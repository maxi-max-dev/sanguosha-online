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
	DuelGame,
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
	type Game,
	type GameRecord,
	type GameSetup,
	type LobbyPlayer,
	type ServerMsg,
} from '@sgs/engine';

interface Env {
	ROOM: DurableObjectNamespace;
	ASSETS: Fetcher;
	/** 仅测试用：缩短读秒等待，不设置时按 1 倍算，不影响线上行为。见 test/ 下的超时托管用例 */
	TIMEOUT_SCALE?: string;
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

/** 每种模式的开局人数上下限。单挑固定 2 人，身份局沿用原来的 5–8 人 */
const MODE_LIMITS: Record<GameSetup['mode'], { min: number; max: number }> = {
	identity: { min: 5, max: 8 },
	duel: { min: 2, max: 2 },
};

const MODE_CN: Record<GameSetup['mode'], string> = { identity: '身份局', duel: '单挑' };

function json(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

export class RoomDO implements DurableObject {
	/** 具体是 IdentityGame 还是 DuelGame 由 setup.mode 决定，房间层只认基类接口 */
	private game?: Game;
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

	/** 大厅里房主选定的模式，开局前可改。未选过（新房间）默认身份局，不破坏老房间的行为 */
	private mode(): GameSetup['mode'] {
		return this.meta('mode') === 'duel' ? 'duel' : 'identity';
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
	private async ensureGame(): Promise<Game | undefined> {
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
		// 具体走哪个 Game 子类由这局开局时定下的 setup.mode 决定，跟房间当前
		// （可能已经被下一局改过）的模式选择无关——记录本身才是唯一真相
		const g = record.setup.mode === 'duel' ? new DuelGame(record, registry) : new IdentityGame(record, registry);
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
			if (req.method === 'GET' && url.pathname.endsWith('/replay')) {
				return this.handleReplay();
			}
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

	/**
	 * 只读导出对局记录（B1）。
	 *
	 * 🔴 防作弊边界：GameRecord 含全员身份和手牌，对局进行中导出等于给所有人开天眼，
	 * 所以只在 `state.finished` 之后才放行，进行中一律 403 —— 不为调试方便放宽。
	 */
	private async handleReplay(): Promise<Response> {
		const seedStr = this.meta('seed');
		const setupStr = this.meta('setup');
		if (!seedStr || !setupStr) {
			return json({ error: '本局还没开始' }, 404);
		}

		const g = await this.ensureGame();
		if (!g || !g.state.finished) {
			return json({ error: '对局进行中，结束后才能导出' }, 403);
		}

		const record: GameRecord = {
			seed: Number(seedStr),
			setup: JSON.parse(setupStr) as GameSetup,
			decisions: this.loadDecisions(),
		};
		return json(record, 200);
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
				case 'setMode':
					return await this.onSetMode(ws, msg.mode);
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
			if (seats.length >= MODE_LIMITS[this.mode()].max) {
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

	private async onSetMode(ws: WebSocket, mode: GameSetup['mode']): Promise<void> {
		const meta = this.sockMeta(ws);
		if (!meta) return;
		if (!this.seats().find((s) => s.pid === meta.pid)?.host) {
			return this.send(ws, { t: 'error', msg: '只有房主能选择模式' });
		}
		if (this.meta('seed')) return this.send(ws, { t: 'error', msg: '游戏已开始' });
		if (mode !== 'identity' && mode !== 'duel') return;

		const limits = MODE_LIMITS[mode];
		const seats = this.seats();
		if (seats.length > limits.max) {
			return this.send(ws, {
				t: 'error',
				msg: `${MODE_CN[mode]}最多 ${limits.max} 人，当前房间有 ${seats.length} 人，先请人离开`,
			});
		}
		this.setMeta('mode', mode);
		await this.pushState();
	}

	private async onStart(ws: WebSocket): Promise<void> {
		const meta = this.sockMeta(ws);
		if (!meta) return;
		const seats = this.seats();
		const me = seats.find((s) => s.pid === meta.pid);
		if (!me?.host) return this.send(ws, { t: 'error', msg: '只有房主能开始' });
		if (this.meta('seed')) return this.send(ws, { t: 'error', msg: '游戏已开始' });

		const mode = this.mode();
		const limits = MODE_LIMITS[mode];
		if (seats.length < limits.min || seats.length > limits.max) {
			const need = limits.min === limits.max ? `${limits.min}` : `${limits.min}-${limits.max}`;
			return this.send(ws, { t: 'error', msg: `${MODE_CN[mode]}需要 ${need} 人（可加机器人补位）` });
		}

		const seed = Math.floor(Math.random() * 0x7fffffff);
		const setup: GameSetup = {
			mode,
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
			if (seats.length >= MODE_LIMITS[this.mode()].max) return this.send(ws, { t: 'error', msg: '房间已满' });
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

	/**
	 * 只有**换了新请求**才重排读秒，而且读秒要落盘。
	 *
	 * 两件事一起解决：
	 * 1. 这个方法挂在 pushState 里，pushState 每次广播都会调（有人重连、有人聊天…）。
	 *    无条件重置 deadline 等于每广播一次就给当前决策者续一次命 —— 掉线的人能把
	 *    整局无限期卡住。所以按 seq 判断是不是同一个请求。
	 * 2. deadline 不能只放内存。DO 随时会休眠，醒来时内存全空；如果这时选择"不知道
	 *    就重排"，而它又可能再次休眠，就变成无限重排、永远不超时 —— 比第 1 条更糟。
	 *    落进 SQLite 才能真正跨休眠。
	 */
	private scheduleTimeout(): void {
		const g = this.game;
		const ask = g?.getPendingAsk();
		if (!ask) {
			this.deadline = 0;
			this.setMeta('deadline', '0');
			this.setMeta('deadlineSeq', '-1');
			return;
		}

		const storedSeq = Number(this.meta('deadlineSeq') ?? '-1');
		const storedAt = Number(this.meta('deadline') ?? '0');
		if (ask.seq === storedSeq && storedAt > Date.now()) {
			this.deadline = storedAt;
			return;
		}

		// TIMEOUT_SCALE 只给测试用（缩短读秒好在自动化测试里跑超时托管），
		// 不设置时 Number(undefined) 是 NaN，`|| 1` 落回 1 倍，线上行为不变。
		const scale = Number(this.env.TIMEOUT_SCALE) || 1;
		this.deadline = Date.now() + ask.timeout * 1000 * scale;
		this.setMeta('deadline', String(this.deadline));
		this.setMeta('deadlineSeq', String(ask.seq));
		void this.ctx.storage.setAlarm(this.deadline);
	}

	async alarm(): Promise<void> {
		const g = await this.ensureGame();
		if (!g) return;
		const ask = g.getPendingAsk();
		if (!ask) return;

		// 读秒从 SQLite 读，不能读内存 —— DO 可能刚从休眠里醒来，内存是空的
		const due = Number(this.meta('deadline') ?? '0');
		const seq = Number(this.meta('deadlineSeq') ?? '-1');
		this.deadline = due;

		// 落盘的读秒对不上当前请求，说明状态漂了，重排一次
		if (seq !== ask.seq || due === 0) return this.scheduleTimeout();
		// 还没到点（旧 alarm 或者被别的写入提前唤醒），重排到真正的截止时刻
		if (Date.now() < due - 500) {
			void this.ctx.storage.setAlarm(due);
			return;
		}

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
			const mode = this.mode();
			const limits = MODE_LIMITS[mode];
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
					mode,
					canStart: !!meta && seats.find((s) => s.pid === meta.pid)?.host === true &&
						seats.length >= limits.min && seats.length <= limits.max,
				});
			}
			return;
		}

		const ask = g.getPendingAsk();
		const hint = askHint(ask);
		for (const ws of this.ctx.getWebSockets()) {
			const meta = this.sockMeta(ws);
			// 用 g.setup.mode（这局实际的模式）而不是 this.mode()（大厅当前选的模式）——
			// 房主可能在这局还没结束时已经把大厅的下一局模式切走了，两者不该混用
			const view = buildView(g.state, meta?.pid ?? null, ask, g.setup.mode);
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
