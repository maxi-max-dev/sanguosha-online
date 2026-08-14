/**
 * 单挑（1v1）模式的房间层端到端测试。
 *
 * 身份局那一套（进房/开局/断线重连/视角裁剪/导出重放）已经在 room.test.ts 覆盖过，
 * 这里只测单挑区别于身份局的部分：模式选择、人数上限（固定 2 人），
 * 以及"建房 → 选将 → 开局 → 换将 → 分胜负"这条完整链路真的走得通。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Unstable_DevWorker } from 'wrangler';
import { bootWorker, createRoom, startDuelGame, TestClient, wsBase } from './helpers.js';

describe('单挑模式', () => {
	let worker: Unstable_DevWorker;

	beforeAll(async () => {
		worker = await bootWorker();
	});

	afterAll(async () => {
		await worker.stop();
	});

	it('端到端：2 人建房 → 选将 → 开局 → 换将 → 分胜负', async () => {
		const code = await createRoom(worker);
		const host = await startDuelGame(worker, code, 'p-duel-host');
		try {
			expect(host.lobby?.mode).toBe('duel');
			expect(host.lobby?.players).toHaveLength(2);

			const view0 = host.view!.view;
			expect(view0.mode).toBe('duel');
			expect(view0.players).toHaveLength(2);

			// 选将 + 整局对战全部交给引擎的安全默认值跑完（跟身份局的 B1 测试同一套手法），
			// 房间另一个座位是服务端机器人，会用真实 AI 应战——host 全程消极应对，
			// 几乎必然落败，但这条用例要验的是链路通不通，不是打得好不好
			host.auto = true;
			const finishedMsg = await host.waitFinished(60_000);
			const finished = finishedMsg.view.finished!;
			expect(finished.reason).toBeDefined();

			// "换将"真的发生过——扫描整段连接期间收到的所有战报，只要出现过一次
			// switchGeneral 就说明至少有一名武将阵亡后成功换了下一个，而不是直接终局
			const switched = host.msgs.some(
				(m) => m.t === 'log' && m.entries.some((e) => e.kind === 'switchGeneral'),
			);
			expect(switched).toBe(true);

			// 正常分出胜负时，赢家必须恰好是唯一还站着的那个人；
			// 洗牌耗尽判平局是引擎既有的极小概率兜底分支，两种都算"跑完了"
			if (!finished.reason.includes('平局')) {
				expect(finished.winners).toHaveLength(1);
				const alive = finishedMsg.view.players.filter((p) => p.alive);
				expect(alive).toHaveLength(1);
				expect(finished.winners[0]).toBe(alive[0].id);
			}
		} finally {
			host.close();
		}
	}, 90_000);

	it('人数上限固定 2 人：第 3 个人进不来', async () => {
		const code = await createRoom(worker);
		const a = new TestClient(wsBase(worker), code, 'p-duel-cap-a', 'A');
		const b = new TestClient(wsBase(worker), code, 'p-duel-cap-b', 'B');
		const c = new TestClient(wsBase(worker), code, 'p-duel-cap-c', 'C');
		try {
			await a.connect();
			a.send({ t: 'setMode', mode: 'duel' });
			await a.waitFor((m) => m.t === 'lobby' && m.mode === 'duel');

			await b.connect();
			await a.waitFor((m) => m.t === 'lobby' && m.players.length === 2);

			await c.connect();
			const err = await c.waitFor((m) => m.t === 'error', 5000);
			expect(err.t).toBe('error');
		} finally {
			a.close();
			b.close();
			c.close();
		}
	});

	it('人数超过单挑上限时拒绝切换模式，报错不改状态', async () => {
		const code = await createRoom(worker);
		const a = new TestClient(wsBase(worker), code, 'p-duel-block-a', 'A');
		const b = new TestClient(wsBase(worker), code, 'p-duel-block-b', 'B');
		const c = new TestClient(wsBase(worker), code, 'p-duel-block-c', 'C');
		try {
			await a.connect();
			await b.connect();
			await c.connect();
			await a.waitFor((m) => m.t === 'lobby' && m.players.length === 3);

			a.send({ t: 'setMode', mode: 'duel' });
			const err = await a.waitFor((m) => m.t === 'error', 5000);
			expect(err.t).toBe('error');
			// 被拒绝后模式必须还是原来的身份局，不能悄悄切过去又不让人开局
			expect(a.lobby?.mode).toBe('identity');
		} finally {
			a.close();
			b.close();
			c.close();
		}
	});

	it('开局人数不足 2 人时拒绝开始', async () => {
		const code = await createRoom(worker);
		const host = new TestClient(wsBase(worker), code, 'p-duel-solo', 'Host');
		try {
			await host.connect();
			host.send({ t: 'setMode', mode: 'duel' });
			await host.waitFor((m) => m.t === 'lobby' && m.mode === 'duel');
			expect(host.lobby?.canStart).toBe(false);

			host.send({ t: 'start' });
			const err = await host.waitFor((m) => m.t === 'error', 5000);
			expect(err.t).toBe('error');
		} finally {
			host.close();
		}
	});
});
