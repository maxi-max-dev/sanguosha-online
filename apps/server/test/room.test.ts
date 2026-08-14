/**
 * RoomDO 端到端测试：进房/开局、决策校验、断线重连、结算导出、再来一局、视角裁剪。
 *
 * 共用同一个本地 wrangler 实例（正常读秒，不缩短）——这几条用例都不依赖超时机制，
 * 用真实读秒也不会拖慢测试。超时托管单独在 timeout.test.ts 里用缩短过的读秒测，
 * 避免这里的用例被那套缩短的时间意外影响（比如重连测试需要足够时间从容断开重连）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Unstable_DevWorker } from 'wrangler';
import {
	defaultDecision,
	GameOver,
	IdentityGame,
	optionProvider,
	registry,
	type GameRecord,
	type ServerMsg,
} from '@sgs/engine';
import { bootWorker, createRoom, fetchReplay, startFivePlayerGame, TestClient, waitUntil, wsBase } from './helpers.js';

type ViewMsg = Extract<ServerMsg, { t: 'view' }>;

describe('RoomDO 端到端', () => {
	let worker: Unstable_DevWorker;

	beforeAll(async () => {
		worker = await bootWorker();
	});

	afterAll(async () => {
		await worker.stop();
	});

	it('创建房间 → 5 人（含机器人补位）进房 → 开局', async () => {
		const code = await createRoom(worker);
		expect(code).toMatch(/^[A-Z0-9]{4}$/);

		const host = await startFivePlayerGame(worker, code, 'p-start-host');
		try {
			expect(host.lobby?.players).toHaveLength(5);
			expect(host.lobby?.players.filter((p) => p.bot)).toHaveLength(4);
			expect(host.lobby?.canStart).toBe(true);

			const view = host.view!.view;
			expect(view.players).toHaveLength(5);
			expect(view.finished).toBeUndefined();
		} finally {
			host.close();
		}
	});

	it('决策提交：seq 对不上时不会被接受，正确 seq 仍能正常推进', async () => {
		const code = await createRoom(worker);
		const host = await startFivePlayerGame(worker, code, 'p-seq-host');
		try {
			const ask = await host.waitForOwnAsk();
			const msgsBefore = host.msgs.length;

			// 错误 seq：服务端不该消费它，而是把当前状态原样推回来（room.ts 的注释原话：
			// "不能静默丢弃，那样玩家点了按钮什么都不会发生，只能干等超时"）
			host.send({ t: 'decide', seq: ask.seq + 999, payload: defaultDecision(ask) });
			await waitUntil(() => host.msgs.length > msgsBefore, 5000);

			// 推回来的状态里，该决策的人还是同一个，seq 也还是原来那个——没有被消费掉
			expect(host.view!.view.ask?.who).toBe(host.pid);
			expect(host.view!.view.ask?.seq).toBe(ask.seq);

			// 用正确的 seq 重新提交，游戏应该能继续往前走——证明坏 seq 没有破坏状态机
			host.send({ t: 'decide', seq: ask.seq, payload: defaultDecision(ask) });
			const next = await host.waitForOwnAsk(ask.seq, 15_000).catch(() => undefined);
			// 也可能下一次轮到自己时游戏已经结束（极少数情况），两者都证明状态推进了
			if (next) expect(next.seq).not.toBe(ask.seq);
			else expect(host.view!.view.finished).toBeDefined();
		} finally {
			host.close();
		}
	});

	it('断线重连：拿回和断开前完全一致的手牌与体力', async () => {
		const code = await createRoom(worker);
		const host = await startFivePlayerGame(worker, code, 'p-reconnect-host');
		try {
			/**
			 * 不能用 auto 全程自动应答再"事后冻结"——冻结的只是我们自己会不会再发
			 * decide，服务端并不会跟着停。机器人照样在后台继续跑，如果轮回到 host
			 * 自己的下一个回合，摸牌阶段是不需要 ask 的强制摸 2 张，跟 host 答不答
			 * 决策毫无关系，快照会在我们看不见的地方悄悄多出牌来（实测踩过：
			 * 断线重连读回来的手牌比断线前多了 2 张）。
			 *
			 * 真正稳的锚点是"服务端结构性地卡在等 host 决策"——只要我们不去应答，
			 * 这个状态在真实的 20~60 秒读秒耗尽之前不会自己动。所以这里手动只应答
			 * 一次选将（不影响手牌/体力，随便选），然后专等 host 的下一个 ask，
			 * 从那条消息里取快照后就再也不碰它——之后不管断线多久，这个 ask
			 * 对应的手牌/体力都是冻住的。
			 */
			const pick = await host.waitForOwnAsk();
			host.send({ t: 'decide', seq: pick.seq, payload: defaultDecision(pick) });

			// 下一次轮到 host，就是我们的锚点：拿到快照后故意不回应，让它稳稳卡在这里
			await host.waitForOwnAsk(pick.seq, 20_000);
			const before = host.view!.view.players.find((p) => p.id === host.pid)!;
			const snapshot = { hand: [...before.hand!].sort((a, b) => a - b), hp: before.hp, maxHp: before.maxHp };

			host.close();
			await new Promise((r) => setTimeout(r, 300));

			const reconnected = new TestClient(wsBase(worker), code, host.pid, 'Host');
			await reconnected.connect();
			await waitUntil(() => !!reconnected.view, 5000);

			const after = reconnected.view!.view.players.find((p) => p.id === host.pid)!;
			expect([...(after.hand ?? [])].sort((a, b) => a - b)).toEqual(snapshot.hand);
			expect(after.hp).toBe(snapshot.hp);
			expect(after.maxHp).toBe(snapshot.maxHp);
			reconnected.close();
		} finally {
			host.close();
		}
	});

	it('视角裁剪：A 拿到的 view 里没有 B 的手牌牌面', async () => {
		const code = await createRoom(worker);
		const a = new TestClient(wsBase(worker), code, 'p-view-a', 'A');
		const b = new TestClient(wsBase(worker), code, 'p-view-b', 'B');
		try {
			await a.connect();
			await b.connect();
			for (let i = 0; i < 3; i++) a.send({ t: 'addBot' });
			await a.waitFor((m) => m.t === 'lobby' && m.players.length === 5);
			a.send({ t: 'start' });
			a.auto = true;
			b.auto = true;

			/**
			 * 各等各自的手牌摸到——初始发牌是 setupGame 里一个不带 ask 的循环，
			 * 对所有人同时生效，所以这两次等待对应的其实是同一次状态跃迁，只是
			 * 分别从 A、B 两个 socket 各收到的那一条消息。直接从命中的消息取数据，
			 * 不读事后可能已经往前走了的 .view——原因和断线重连测试那条注释一样：
			 * defaultDecision 很容易让人几步内阵亡，轮询或者晚读一步都可能踩到
			 * 结算后的 revealAll 状态，制造这条测试自己的假阳性/假阴性。
			 */
			const [bDealt, aDealt] = (await Promise.all([
				b.waitFor((m) => m.t === 'view' && !!m.view.players.find((p) => p.id === b.pid)?.hand?.length, 15_000),
				a.waitFor((m) => m.t === 'view' && !!m.view.players.find((p) => p.id === a.pid)?.hand?.length, 15_000),
			])) as [ViewMsg, ViewMsg];
			a.auto = false;
			b.auto = false;

			const bRealHand = bDealt.view.players.find((p) => p.id === b.pid)!.hand!;
			expect(bRealHand.length).toBeGreaterThan(0);

			const aView = aDealt.view;
			expect(aView.finished).toBeUndefined();
			const bFromA = aView.players.find((p) => p.id === b.pid)!;
			// 字段本身就不该下发
			expect(bFromA.hand).toBeUndefined();
			// 更硬的证据：B 真实手牌的 id 在 A 的 view.cards 里完全查不到牌面
			// （和 DIAGNOSIS.md A1 里"用 view.cards 里没有该 id 来证明"是同一种验证方式）
			for (const id of bRealHand) {
				expect(aView.cards[id]).toBeUndefined();
			}
		} finally {
			a.close();
			b.close();
		}
	});

	it('B1：进行中导出被拒绝（403）；结算后可导出并能在本地精确重放；再来一局保留座位、清空决策日志', async () => {
		// 这条要跑完整整两局游戏（5 人身份局，机器人真打，牌局长度看随机种子的脸色），
		// 给足单条用例的超时预算，别被全局默认值卡住
		const code = await createRoom(worker);
		const host = await startFivePlayerGame(worker, code, 'p-full-host');
		try {
			const seatsBefore = host.lobby!.players.map((p) => p.pid).sort();

			// 进行中：防作弊边界必须挡住，GameRecord 含全员身份和手牌。
			// 必须在打开 auto 之前查，而不是之后——见过整局 5 人身份局在小几百毫秒内
			// 就打完的情况，auto 一开可能几个来回就直接结算了，这里再查就可能已经
			// 不是"进行中"了。startFivePlayerGame 刚返回时保证只处理过选将，
			// 离结束还远，这个时间点才是稳的。
			const mid = await fetchReplay(worker, code);
			expect(mid.status).toBe(403);

			host.auto = true;
			const finishedMsg = await host.waitFinished(45_000);
			const finished1 = finishedMsg.view.finished!;

			const res1 = await fetchReplay(worker, code);
			expect(res1.status).toBe(200);
			const record1 = (await res1.json()) as GameRecord;
			expect(record1.decisions.length).toBeGreaterThan(0);
			expect(record1.decisions[0].seq).toBe(0);

			// 验收标准原文：拿 GameRecord 在本地 new IdentityGame(record, registry) 重放，
			// 断言最终 state.finished 与线上一致
			const replayed1 = new IdentityGame(record1, registry);
			replayed1.optionProvider = optionProvider;
			void replayed1.runGame().catch((e) => {
				if (!(e instanceof GameOver)) throw e;
			});
			await replayed1.waitIdle();
			expect(replayed1.state.finished?.reason).toBe(finished1.reason);
			expect(new Set(replayed1.state.finished?.winners)).toEqual(new Set(finished1.winners));

			// 再来一局：座位原样保留（同一批 pid，不是重新进房）。
			// 这里必须用 waitForNext——开局前那条"5 人大厅"消息早就在历史里了，
			// 用会先查历史的 waitFor 会立刻假性命中那条旧消息，根本没真的等到重启。
			host.send({ t: 'restart' });
			await host.waitForNext((m) => m.t === 'lobby' && m.players.length === 5, 10_000);
			const seatsAfter = host.lobby!.players.map((p) => p.pid).sort();
			expect(seatsAfter).toEqual(seatsBefore);

			// 决策日志已清空：重启后、开第二局前，导出应该是"还没开始"（404），
			// 而不是"进行中"（403）——两者用不同状态码正是为了这里能分得清
			const afterRestart = await fetchReplay(worker, code);
			expect(afterRestart.status).toBe(404);

			// 开第二局，跑完，确认是全新的决策日志（从 seq 0 重新算，而不是接着第一局的尾巴）
			host.auto = true;
			host.send({ t: 'start' });
			const finishedMsg2 = await host.waitFinished(45_000);
			const finished2 = finishedMsg2.view.finished!;

			const res2 = await fetchReplay(worker, code);
			expect(res2.status).toBe(200);
			const record2 = (await res2.json()) as GameRecord;
			expect(record2.decisions[0]?.seq).toBe(0);
			expect(record2.seed).not.toBe(record1.seed);

			// 第二局同样要能精确重放——如果 restart 没把 decisions 表清干净，
			// 新种子下的候选/选项八成对不上旧决策，这里几乎必然会抛 ReplayDesyncError
			const replayed2 = new IdentityGame(record2, registry);
			replayed2.optionProvider = optionProvider;
			void replayed2.runGame().catch((e) => {
				if (!(e instanceof GameOver)) throw e;
			});
			await replayed2.waitIdle();
			expect(replayed2.state.finished?.reason).toBe(finished2.reason);
			expect(new Set(replayed2.state.finished?.winners)).toEqual(new Set(finished2.winners));
		} finally {
			host.close();
		}
	}, 100_000);
});
