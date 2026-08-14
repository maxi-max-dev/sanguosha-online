/**
 * 一个房间 = 一个 Durable Object。它持有这局游戏的权威状态。
 *
 * ## 休眠与恢复
 *
 * 用了 WebSocket Hibernation：没人说话时 DO 会被踢出内存（这样才不烧 duration 额度），
 * 连接却还活着。醒来时内存里的 Game 对象已经没了 —— 我们不去尝试保存它，而是从
 * SQLite 里的「种子 + 决策日志」**重放**出来。一局撑死几百个决策，重放是毫秒级的。
 *
 * 所以这里唯一需要持久化的就是决策日志。游戏状态本身永远是推导出来的，
 * 不存在"存档和实际状态不一致"这种 bug。
 */

import {
	ai,
	IdentityGame,
	GameOver,
	optionProvider,
	registry,
	Rng,
	askHint,
	buildView,
	type ClientMsg,
	type Decision,
	type DecisionPayload,
	type GameRecord,
	type GameSetup,
	type LobbyPlayer,
	type ServerMsg,
} from '@sgs/engine';

interface Env {
	ROOM: DurableObjectNamespace;
	ASSETS: Fetcher;
}

interface SockMeta {
	pid: string;
	name: string;
}

/** 一个座位。bot=true 表示机器人补位，由服务端自动决策 */
interface Seat {
	pid: string;
	name: string;
	host: boolean;
	bot: boolean;
}

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 8;

export class RoomDO implements DurableObject {
	private game?: IdentityGame;
	/** 已落盘的决策条数，用于增量持久化 */
	private persisted = 0;
	/** 当前 ask 的超时截止时间（毫秒时间戳） */
	private deadline = 0;
	/** 机器人专用随机流。与 g.rng 完全隔离（原因见 driveBots 注释） */
	private botRng = new Rng(Math.floor(Math.random() * 0x7fffffff));

	constructor(
		private ctx: DurableObjectState,
		private env: Env,
	) {
		ctx.blockConcurrencyWhile(async () => {
			const sql = ctx.storage.sql;
			sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
			sql.exec(
				`CREATE TABLE IF NOT EXISTS seats (pid TEXT PRIMARY KEY, name TEXT, host INTEGER, bot INTEGER, ord INTEGER)`,
			);
			sql.exec(
				`CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY, who TEXT, payload TEXT, auto INTEGER)`,
			);
		});
	}

	// ─────────────────────── 存取 ───────────────────────

	private meta(k: string): string | undefined {
		const r = this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray();
		return r.length ? (r[0].v as string) : undefined;
	}

	private setMeta(k: string, v: string): void {
		this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`, k, v);
	}

	private seats(): Seat[] {
		return this.ctx.storage.sql
			.exec(`SELECT pid, name, host, bot FROM seats ORDER BY ord`)
			.toArray()
			.map((r) => ({
				pid: r.pid as string,
				name: r.name as string,
				host: !!r.host,
				bot: !!r.bot,
			}));
	}

	private loadDecisions(): Decision[] {
		return this.ctx.storage.sql
			.exec(`SELECT seq, who, payload, auto FROM decisions ORDER BY seq`)
			.toArray()
			.map((r) => ({
				seq: r.seq as number,
				who: r.who as string,
				payload: JSON.parse(r.payload as string) as DecisionPayload,
				auto: !!r.auto,
			}));
	}

	/** 把引擎里还没落盘的决策写进 SQLite */
	private persistDecisions(): void {
		if (!this.game) return;
		const all = this.game.decisions;
		for (let i = this.persisted; i < all.length; i++) {
			const d = all[i];
			this.ctx.storage.sql.exec(
				`INSERT OR REPLACE INTO decisions (seq, who, payload, auto) VALUES (?, ?, ?, ?)`,
				d.seq,
				d.who,
				JSON.stringify(d.payload),
				d.auto ? 1 : 0,
			);
		}
		this.persisted = all.length;
	}

	// ─────────────────────── 游戏实例 ───────────────────────

	/** 拿到（必要时从日志重放出）当前对局。未开局则返回 undefined */
	private async ensureGame(): Promise<IdentityGame | undefined> {
		if (this.game) return this.game;
		const seedStr = this.meta('seed');
		const setupStr = this.meta('setup');
		if (!seedStr || !setupStr) return undefined;

		const decisions = this.loadDecisions();
		const record: GameRecord = {
			seed: Number(seedStr),
			setup: JSON.parse(setupStr) as GameSetup,
			decisions,
		};
		const g = new IdentityGame(record, registry);
		g.optionProvider = optionProvider;
		void g.runGame().catch((e) => {
			if (!(e instanceof GameOver)) console.error('引擎异常', e);
		});
		await g.waitIdle();

		this.game = g;
		this.persisted = decisions.length;
		return g;
	}

	// ─────────────────────── HTTP / WebSocket ───────────────────────

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (req.headers.get('Upgrade') !== 'websocket') {
			return new Response('expected websocket', { status: 426 });
		}

		const code = url.searchParams.get('code') ?? '';
		if (!this.meta('code')) this.setMeta('code', code);

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		// 用 hibernation 版的 accept：DO 可以在消息间隙被踢出内存而连接不断
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		let msg: ClientMsg;
		try {
			msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
		} catch {
			return this.send(ws, { t: 'error', msg: '报文解析失败' });
		}

		try {
			switch (msg.t) {
				case 'hello':
					return await this.onHello(ws, msg.pid, msg.name);
				case 'start':
					return await this.onStart(ws);
				case 'addBot':
					return await this.onBot(ws, true);
				case 'removeBot':
					return await this.onBot(ws, false);
				case 'restart':
					return await this.onRestart(ws);
				case 'decide':
					return await this.onDecide(ws, msg.seq, msg.payload);
				case 'chat':
					return this.onChat(ws, msg.text);
				case 'ping':
					return this.send(ws, { t: 'pong' });
			}
		} catch (e) {
			console.error(e);
			this.send(ws, { t: 'error', msg: e instanceof Error ? e.message : String(e) });
		}
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		const meta = this.sockMeta(ws);
		if (meta && this.game) {
			const p = this.game.state.players.find((x) => x.id === meta.pid);
			if (p) p.offline = true;
		}
		await this.broadcast();
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.webSocketClose(ws);
	}

	// ─────────────────────── 消息处理 ───────────────────────

	private async onHello(ws: WebSocket, pid: string, name: string): Promise<void> {
		if (!pid || pid.length > 64) return this.send(ws, { t: 'error', msg: '身份无效' });
		const clean = (name || '无名').slice(0, 12);
		ws.serializeAttachment({ pid, name: clean } satisfies SockMeta);

		const seats = this.seats();
		const existing = seats.find((s) => s.pid === pid);

		if (!existing) {
			if (this.meta('seed')) {
				// 开局后不允许新玩家占座，但允许作为观战者连着
				await this.pushState();
				return;
			}
			if (seats.length >= MAX_PLAYERS) {
				return this.send(ws, { t: 'error', msg: '房间已满' });
			}
			this.ctx.storage.sql.exec(
				`INSERT INTO seats (pid, name, host, bot, ord) VALUES (?, ?, ?, 0, ?)`,
				pid,
				clean,
				seats.length === 0 ? 1 : 0,
				seats.length,
			);
		} else {
			this.ctx.storage.sql.exec(`UPDATE seats SET name = ? WHERE pid = ?`, clean, pid);
		}

		const g = await this.ensureGame();
		if (g) {
			const p = g.state.players.find((x) => x.id === pid);
			if (p) p.offline = false;
		}
		await this.pushState();
	}

	private async onStart(ws: WebSocket): Promise<void> {
		const meta = this.sockMeta(ws);
		if (!meta) return;
		const seats = this.seats();
		const me = seats.find((s) => s.pid === meta.pid);
		if (!me?.host) return this.send(ws, { t: 'error', msg: '只有房主能开始' });
		if (this.meta('seed')) return this.send(ws, { t: 'error', msg: '游戏已开始' });
		if (seats.length < MIN_PLAYERS) {
			return this.send(ws, { t: 'error', msg: `身份局至少 ${MIN_PLAYERS} 人（可加机器人补位）` });
		}

		const seed = Math.floor(Math.random() * 0x7fffffff);
		const setup: GameSetup = {
			mode: 'identity',
			players: seats.map((s) => ({ id: s.pid, nickname: s.name })),
			packs: ['standard'],
		};
		this.setMeta('seed', String(seed));
		this.setMeta('setup', JSON.stringify(setup));

		await this.ensureGame();
		this.persistDecisions();
		await this.pushState();
		await this.driveBots();
	}

	private async onBot(ws: WebSocket, add: boolean): Promise<void> {
		const meta = this.sockMeta(ws);
		if (!meta) return;
		const seats = this.seats();
		if (!seats.find((s) => s.pid === meta.pid)?.host) {
			return this.send(ws, { t: 'error', msg: '只有房主能增减机器人' });
		}
		if (this.meta('seed')) return this.send(ws, { t: 'error', msg: '游戏已开始' });

		if (add) {
			if (seats.length >= MAX_PLAYERS) return this.send(ws, { t: 'error', msg: '房间已满' });
			const n = seats.filter((s) => s.bot).length + 1;
			this.ctx.storage.sql.exec(
				`INSERT INTO seats (pid, name, host, bot, ord) VALUES (?, ?, 0, 1, ?)`,
				`bot-${n}-${Math.random().toString(36).slice(2, 8)}`,
				`机器人${n}`,
				seats.length,
			);
		} else {
			const last = seats.filter((s) => s.bot).pop();
			if (last) this.ctx.storage.sql.exec(`DELETE FROM seats WHERE pid = ?`, last.pid);
		}
		await this.pushState();
	}

	/**
	 * 开下一局：只清牌局（种子 + 决策日志），**保留座位**。
	 * 朋友一晚上要连打好几局，每局都重新建房、重发房间码是劝退的。
	 */
	private async onRestart(ws: WebSocket): Promise<void> {
		const meta = this.sockMeta(ws);
		if (!meta) return;
		if (!this.seats().find((s) => s.pid === meta.pid)?.host) {
			return this.send(ws, { t: 'error', msg: '只有房主能开下一局' });
		}
		const g = this.game;
		if (g && !g.state.finished) {
			return this.send(ws, { t: 'error', msg: '本局还没结束' });
		}

		this.ctx.storage.sql.exec(`DELETE FROM decisions`);
		this.ctx.storage.sql.exec(`DELETE FROM meta WHERE k IN ('seed', 'setup')`);
		this.game = undefined;
		this.persisted = 0;
		this.deadline = 0;
		await this.pushState();
	}

	private async onDecide(ws: WebSocket, seq: number, payload: DecisionPayload): Promise<void> {
		const meta = this.sockMeta(ws);
		if (!meta) return;
		const g = await this.ensureGame();
		if (!g) return this.send(ws, { t: 'error', msg: '游戏尚未开始' });

		const ask = g.getPendingAsk();
		if (!ask) return this.send(ws, { t: 'error', msg: '现在不需要你决策' });
		// seq 校验挡住重复提交和"手快点了上一个请求的按钮"。
		// 不能静默丢弃 —— 那样玩家点了按钮什么都不会发生，只能干等超时。
		// 把最新状态推回去，客户端会拿到正确的 seq 重新渲染。
		if (ask.seq !== seq) {
			await this.pushState();
			return;
		}
		if (ask.who !== meta.pid) return this.send(ws, { t: 'error', msg: '还没轮到你' });

		await g.submit(meta.pid, payload);
		this.persistDecisions();
		await this.pushState();
		await this.driveBots();
	}

	private onChat(ws: WebSocket, text: string): void {
		const meta = this.sockMeta(ws);
		if (!meta || !text) return;
		this.broadcastRaw({ t: 'chat', from: meta.name, text: text.slice(0, 80) });
	}

	// ─────────────────────── 机器人补位 ───────────────────────

	/**
	 * 机器人决策。走 `ai.decide()` 而不是 `submitAuto()` 的安全默认值 ——
	 * 后者对出牌阶段永远返回"跳过"，机器人一整局一张牌不出，纯送人头。
	 *
	 * 掉线的真人仍然走 `submitAuto()`（见 `alarm()`）：替别人乱出牌比什么都不做更糟。
	 *
	 * 注意这里给 AI 的是一条**独立**的随机流，绝不能用 `g.rng` —— 重放时 AI 不参与，
	 * 用了游戏自己的随机流会让重放后的状态和实时对局静默错位。
	 */
	private async driveBots(): Promise<void> {
		const g = this.game;
		if (!g) return;
		const bots = new Set(this.seats().filter((s) => s.bot).map((s) => s.pid));
		if (bots.size === 0) return;

		let guard = 0;
		while (!g.state.finished && guard++ < 500) {
			const ask = g.getPendingAsk();
			if (!ask || !bots.has(ask.who)) break;
			let payload;
			try {
				payload = ai.decide(g, ask, this.botRng);
			} catch (e) {
				// AI 出错不能把整局卡死，退回安全默认值
				console.error('机器人决策异常，退回默认值', e);
				await g.submitAuto();
				continue;
			}
			await g.submit(ask.who, payload);
		}
		this.persistDecisions();
		await this.pushState();
	}

	// ─────────────────────── 超时托管 ───────────────────────

	/** 当前读秒对应的请求序号。用来区分"新请求"和"同一个请求的又一次广播" */
	private deadlineSeq = -1;

	/**
	 * 只有**换了新请求**才重排读秒。
	 *
	 * 这个方法挂在 pushState 里，而 pushState 每次广播都会调（有人重连、有人聊天、
	 * 状态刷新都会触发）。早先无条件重置 deadline，等于每广播一次就给当前决策者续一次命 ——
	 * 一个掉线的人可以把整局无限期卡住，而超时托管永远不会触发。
	 */
	private scheduleTimeout(): void {
		const g = this.game;
		const ask = g?.getPendingAsk();
		if (!ask) {
			this.deadline = 0;
			this.deadlineSeq = -1;
			return;
		}
		if (ask.seq === this.deadlineSeq && this.deadline > Date.now()) return;
		this.deadlineSeq = ask.seq;
		this.deadline = Date.now() + ask.timeout * 1000;
		void this.ctx.storage.setAlarm(this.deadline);
	}

	async alarm(): Promise<void> {
		const g = await this.ensureGame();
		if (!g) return;
		const ask = g.getPendingAsk();
		if (!ask) return;
		// deadline 是内存态，DO 休眠一次就没了。醒来后不知道读秒走到哪，
		// 宁可重排也不能直接替人做决定 —— 玩家可能刚点开手机正要出牌。
		if (this.deadline === 0) return this.scheduleTimeout();
		// 还没到点（可能是旧 alarm）就重排
		if (Date.now() < this.deadline - 500) return this.scheduleTimeout();

		await g.submitAuto();
		this.persistDecisions();
		await this.pushState();
		await this.driveBots();
	}

	// ─────────────────────── 广播 ───────────────────────

	private sockMeta(ws: WebSocket): SockMeta | undefined {
		try {
			return ws.deserializeAttachment() as SockMeta | undefined;
		} catch {
			return undefined;
		}
	}

	private send(ws: WebSocket, msg: ServerMsg): void {
		try {
			ws.send(JSON.stringify(msg));
		} catch {
			/* 连接已断，下一次广播会自然跳过 */
		}
	}

	private broadcastRaw(msg: ServerMsg): void {
		for (const ws of this.ctx.getWebSockets()) this.send(ws, msg);
	}

	/** 推送当前状态。每个连接拿到的是**按自己视角裁剪过的**视图 */
	private async pushState(): Promise<void> {
		const g = this.game ?? (await this.ensureGame());
		this.scheduleTimeout();

		if (!g) {
			const seats = this.seats();
			const online = new Set(
				this.ctx.getWebSockets().map((w) => this.sockMeta(w)?.pid).filter(Boolean) as string[],
			);
			const players: LobbyPlayer[] = seats.map((s) => ({
				pid: s.pid,
				name: s.name,
				host: s.host,
				bot: s.bot,
				online: s.bot || online.has(s.pid),
			}));
			for (const ws of this.ctx.getWebSockets()) {
				const meta = this.sockMeta(ws);
				this.send(ws, {
					t: 'lobby',
					room: this.meta('code') ?? '',
					players,
					you: meta?.pid ?? '',
					canStart: !!meta && seats.find((s) => s.pid === meta.pid)?.host === true &&
						seats.length >= MIN_PLAYERS,
				});
			}
			return;
		}

		const ask = g.getPendingAsk();
		const hint = askHint(ask);
		for (const ws of this.ctx.getWebSockets()) {
			const meta = this.sockMeta(ws);
			const view = buildView(g.state, meta?.pid ?? null, ask);
			this.send(ws, {
				t: 'view',
				view,
				hint,
				deadline: this.deadline || undefined,
			});
		}
		this.broadcastRaw({ t: 'log', entries: g.log.slice(-40) });
	}

	private async broadcast(): Promise<void> {
		await this.pushState();
	}
}
