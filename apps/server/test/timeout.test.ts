/**
 * 超时托管：读秒到点后，即使没有任何客户端发过 decide，对局也要自动往前推进。
 *
 * 这一条历史上真的翻过车（DIAGNOSIS.md B3：读秒被无限续命、DO 休眠后超时托管失效），
 * 所以单独起一个 worker，用 TIMEOUT_SCALE 把引擎里 20~60 秒的读秒等比缩短，
 * 不用真的在测试里死等半分钟。这个变量只有测试显式传了才生效（见 room.ts 的
 * scheduleTimeout：`Number(undefined) || 1` 落回 1 倍），不影响其他用例也不影响线上。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Unstable_DevWorker } from 'wrangler';
import { bootWorker, createRoom, startFivePlayerGame } from './helpers.js';

describe('超时托管', () => {
	let worker: Unstable_DevWorker;

	beforeAll(async () => {
		worker = await bootWorker({ TIMEOUT_SCALE: '0.03' });
	});

	afterAll(async () => {
		await worker.stop();
	});

	it('不响应也会在读秒结束后自动推进（DO 的 alarm 触发 submitAuto）', async () => {
		const code = await createRoom(worker);
		const host = await startFivePlayerGame(worker, code, 'p-timeout-host');
		try {
			const ask = await host.waitForOwnAsk();
			expect(host.view!.deadline).toBeDefined();

			// 故意什么都不做：不发任何 decide，纯等 DO 的 alarm 自己把这一步推过去。
			// 能等到"下一次轮到自己"或者"游戏已经推进到别人身上"，
			// 本身就是证据——没有任何客户端提交过决策，状态却动了，只能是服务端的
			// alarm 触发了 submitAuto()。
			const next = await host.waitFor(
				(m) => m.t === 'view' && (m.view.ask?.seq ?? -1) !== ask.seq,
				15_000,
			);
			if (next.t === 'view' && next.view.ask) {
				expect(next.view.ask.seq).not.toBe(ask.seq);
			}
		} finally {
			host.close();
		}
	});
});
