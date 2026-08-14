/**
 * DO 层端到端测试的公共设施。
 *
 * 用 `unstable_dev` 起一个真实的本地 wrangler 实例（真的 Worker + 真的 Durable Object +
 * 真的 SQLite 持久化），再用 Node 原生的 WebSocket 当客户端连上去——不 mock 任何东西，
 * 也不直接碰 RoomDO 的内部方法。测的是从 wire 协议进去的完整链路，跟真实前端看到的
 * 是同一份 GameView，这样才对得上"端到端"三个字。
 */

import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import {
	defaultDecision,
	type AskRequest,
	type ClientMsg,
	type ServerMsg,
} from '@sgs/engine';

/** 起一个本地 wrangler dev 实例。vars 用来给测试注入 TIMEOUT_SCALE 这类只读变量 */
export async function bootWorker(vars: Record<string, string> = {}): Promise<Unstable_DevWorker> {
	return unstable_dev('src/index.ts', {
		config: 'wrangler.jsonc',
		vars,
		experimental: { disableExperimentalWarning: true },
		logLevel: 'error',
	});
}

export function wsBase(worker: Unstable_DevWorker): string {
	return `ws://${worker.address}:${worker.port}`;
}

/** POST /api/room 建一个新房间，返回房间码 */
export async function createRoom(worker: Unstable_DevWorker): Promise<string> {
	const res = await worker.fetch('http://do-test/api/room', { method: 'POST' });
	const { code } = (await res.json()) as { code: string };
	return code;
}

/** GET /api/room/:code/replay —— B1 的只读导出接口 */
export function fetchReplay(worker: Unstable_DevWorker, code: string): Promise<Response> {
	return worker.fetch(`http://do-test/api/room/${code}/replay`);
}

type LobbyMsg = Extract<ServerMsg, { t: 'lobby' }>;
type ViewMsg = Extract<ServerMsg, { t: 'view' }>;

/**
 * 一个真实的测试客户端：原生 WebSocket 直连服务端，走的是真实浏览器同一条协议。
 * 只读 wire 上收到的 GameView，不偷看服务端内部的 Game 对象——这正是要测的边界。
 */
export class TestClient {
	ws!: WebSocket;
	msgs: ServerMsg[] = [];
	lobby?: LobbyMsg;
	view?: ViewMsg;

	/**
	 * 打开后：每次轮到自己决策，就用引擎导出的 defaultDecision() 立即应答——
	 * 这正是服务端超时托管用的同一套"安全默认值"，用它来快速跑完整局，
	 * 而不必真的等 20~40 秒的读秒（那是超时托管测试自己要验的东西）。
	 */
	private _auto = false;
	private lastAutoSeq = -1;
	private waiters: Array<{ pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }> = [];

	/**
	 * 打开自动应答会立刻检查一次"当前是不是已经轮到自己了"——不能只等下一条消息。
	 * 踩过的坑：如果轮到自己的 ask 在调用方拿到 view、还没来得及把 auto 设成 true
	 * 之前就已经到达（比如开局选将第一个问的正好是自己），只监听"以后"的消息会
	 * 永远错过这一条，直接卡死等到真实超时。
	 */
	get auto(): boolean {
		return this._auto;
	}
	set auto(v: boolean) {
		this._auto = v;
		if (v) this.maybeAutoRespond();
	}

	constructor(
		private base: string,
		private code: string,
		readonly pid: string,
		readonly name = pid,
	) {}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(`${this.base}/api/ws?code=${this.code}`);
			this.ws.onopen = () => {
				this.send({ t: 'hello', pid: this.pid, name: this.name });
				resolve();
			};
			this.ws.onerror = () => reject(new Error(`${this.pid} 连接失败`));
			this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data as string) as ServerMsg);
		});
	}

	private onMessage(msg: ServerMsg): void {
		this.msgs.push(msg);
		if (msg.t === 'lobby') this.lobby = msg;
		if (msg.t === 'view') {
			this.view = msg;
			if (this.auto) this.maybeAutoRespond();
		}
		this.waiters = this.waiters.filter((w) => {
			if (!w.pred(msg)) return true;
			w.resolve(msg);
			return false;
		});
	}

	private maybeAutoRespond(): void {
		const ask = this.view?.view.ask;
		if (!ask || ask.who !== this.pid || ask.seq === this.lastAutoSeq) return;
		this.lastAutoSeq = ask.seq;
		this.send({ t: 'decide', seq: ask.seq, payload: defaultDecision(ask) });
	}

	send(msg: ClientMsg): void {
		this.ws.send(JSON.stringify(msg));
	}

	/** 等到满足条件的下一条消息（已经收到但还没被 waitFor 消费过的也算） */
	waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 10_000): Promise<ServerMsg> {
		const hit = this.msgs.find(pred);
		if (hit) return Promise.resolve(hit);
		return this.waitForNext(pred, timeoutMs);
	}

	/**
	 * 只等"从现在起新到达"的消息，不管历史里有没有已经满足过条件的旧消息。
	 *
	 * "再来一局"这类测试会在同一个连接上跨好几个阶段复用同一个 TestClient——
	 * 开局前的大厅、第一局进行中、第一局结束、重启后的大厅、第二局……如果这时候
	 * 还用 waitFor 的"先查历史"逻辑，类似"5 人大厅"或"对局已结束"这种条件在
	 * 历史消息里早就满足过一次了，会立刻假性 resolve，实际上根本没等到这一次
	 * 真正的状态跃迁。这个坑真的踩过（B1 测试重启后 waitFinished 直接把第一局
	 * 结束的旧消息当成第二局结束）。凡是同一个 predicate 形状可能在客户端生命周期
	 * 里匹配到不止一次的场景，都该用这个而不是 waitFor。
	 */
	waitForNext(pred: (m: ServerMsg) => boolean, timeoutMs = 10_000): Promise<ServerMsg> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('waitForNext 超时')), timeoutMs);
			this.waiters.push({
				pred,
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				},
			});
		});
	}

	/**
	 * 等到轮到自己决策的下一个 ask（seq 与 afterSeq 不同）。
	 *
	 * 故意用会先查历史的 waitFor，不是 waitForNext：调用方常常是"游戏刚开局，
	 * 说不定这一刻已经轮到我了"，历史里已经有的那条消息就该算数，不用真的傻等
	 * 一条新消息。之所以不会像 waitFinished 那样踩到"跨局撞见旧消息"的坑，
	 * 是因为一局游戏内 ask.seq 严格递增且一次性——已经用掉的 seq 不会再出现，
	 * 传 afterSeq 排除掉它就够了。这个方法目前没有跨局复用的场景，如果以后要跨
	 * 局重复调用，应该照 waitFinished 的做法换成 waitForNext。
	 */
	async waitForOwnAsk(afterSeq = -1, timeoutMs = 10_000): Promise<AskRequest> {
		const msg = (await this.waitFor(
			(m) => m.t === 'view' && m.view.ask?.who === this.pid && m.view.ask.seq !== afterSeq,
			timeoutMs,
		)) as ViewMsg;
		return msg.view.ask!;
	}

	/** 等对局结束。永远只看"从现在起"的新消息，同一个连接上打第二局时不会被第一局的旧结算消息骗到 */
	async waitFinished(timeoutMs = 20_000): Promise<ViewMsg> {
		return (await this.waitForNext((m) => m.t === 'view' && !!m.view.finished, timeoutMs)) as ViewMsg;
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			/* 已经断开，忽略 */
		}
	}
}

/** 建房、连房主、补够 4 个机器人到 5 人、开局。返回已连接的房主客户端 */
export async function startFivePlayerGame(
	worker: Unstable_DevWorker,
	code: string,
	hostPid: string,
): Promise<TestClient> {
	const host = new TestClient(wsBase(worker), code, hostPid, 'Host');
	await host.connect();
	for (let i = 0; i < 4; i++) host.send({ t: 'addBot' });
	await host.waitFor((m) => m.t === 'lobby' && m.players.length === 5);
	host.send({ t: 'start' });
	await host.waitFor((m) => m.t === 'view');
	return host;
}

/** 轮询等一个派生条件成立。用来等"手牌摸到了"这类没有单一消息边界的状态变化 */
export async function waitUntil(check: () => boolean, timeoutMs = 10_000, intervalMs = 20): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitUntil 超时');
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}
