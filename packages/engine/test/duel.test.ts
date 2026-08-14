/**
 * 单挑（DuelGame）测试：换将机制 + 三将尽出判负。
 *
 * 手法跟 core.test.ts 一样，全程通过 runGame() 单协程驱动，但用 setup.rosters
 * 固定选将名单（跳过选将的 chooseOption 询问），这样 boot() 一路跑到第一个
 * playPhase 请求为止，setupGame() 已经完整跑完——武将、体力、手牌都已就位。
 *
 * 之后为了孤立测"死亡 → 换将"这一段机制本身，不想被具体武将的技能干扰
 * （谁的技能在 turnStart/onDie 弹了确认框，测试就要多处理一个 ask），
 * 直接把两个人的技能和手牌清空：技能清空后 trigger() 找不到任何候选，
 * 手牌清空后濒死救援的 rescueOptions() 必为空，dying() 的桃救援循环会立刻
 * 跳过、不产生任何 ask()——这样 g.loseHp() 之后的整条调用链可以保证是纯同步
 * 推进到底，不会跟 setupGame() 期间就已经挂起的那个 playPhase 请求打架。
 */

import { describe, expect, it } from 'vitest';
import { GameOver } from '../src/game.js';
import { DuelGame } from '../src/modes/duel.js';
import { optionProvider } from '../src/options.js';
import type { GameRecord } from '../src/protocol.js';
import { registry } from '../src/registry.js';

function makeRecord(seed = 1): GameRecord {
	return {
		seed,
		setup: {
			mode: 'duel',
			players: [
				{ id: 'p0', nickname: '甲' },
				{ id: 'p1', nickname: '乙' },
			],
			packs: ['standard'],
			// 固定名单，第一个是首发；跳过选将流程直接进正局
			rosters: {
				p0: ['zhaoyun', 'zhangfei', 'guanyu'],
				p1: ['sunquan', 'ganning', 'lvmeng'],
			},
		},
		decisions: [],
	};
}

/**
 * 清空双方技能和手牌：技能清空后 trigger() 永远找不到候选，手牌清空后
 * dying() 的桃救援循环必然直接跳过——这样后面的 g.loseHp() 调用链能保证
 * 全程不产生任何 ask()，可以放心在 runGame() 协程还挂着一个 playPhase 请求
 * 没处理的情况下，照样直接调用引擎方法（跟 skills.test.ts 头部注释里
 * "没有 runGame() 协程在跑就可以放心直接调 g.damage()" 是同一个安全前提，
 * 这里换了个方式满足它：不是不跑协程，是保证协程绝不会再被吵醒）。
 */
function sterilize(g: DuelGame): void {
	for (const p of g.state.players) {
		if (!p.alive) continue;
		p.skills = [];
		p.hand = [];
	}
}

/** 跑到 setupGame() 完成、第一个 playPhase 请求挂起为止 */
async function boot(seed = 1): Promise<DuelGame> {
	const g = new DuelGame(makeRecord(seed), registry);
	g.optionProvider = optionProvider;
	void g.runGame().catch((e) => {
		if (!(e instanceof GameOver)) throw e;
	});
	await g.waitIdle();
	sterilize(g);
	return g;
}

/**
 * 把某个座位的当前武将直接打到体力见底，驱动 dying()→die() 走一遍。
 *
 * 换将会带出新武将的真实技能和一手新牌——如果测试要连续杀第二轮，调用方
 * 必须在看完这一轮的断言之后自己再调一次 sterilize()，不然下一刀就可能撞上
 * 换上来的武将自己的确认框（比如某个 onDie 触发技问"是否发动"）。
 */
async function kill(g: DuelGame, who: string): Promise<void> {
	const p = g.player(who);
	await g.loseHp(who, p.hp);
}

describe('单挑：开局布置', () => {
	it('固定名单时，首发武将、体力、先后手摸牌数都对', async () => {
		const g = await boot();
		const p0 = g.state.players[0];
		const p1 = g.state.players[1];
		expect(p0.general).toBe('zhaoyun');
		expect(p1.general).toBe('sunquan');
		expect(p0.hp).toBe(p0.maxHp);
		expect(p1.hp).toBe(p1.maxHp);
	});

	it('先手摸 4、后手摸 6（在被测试清空手牌之前，从 boot 内部状态看不到——改用未清空的独立实例验证）', async () => {
		const g = new DuelGame(makeRecord(2), registry);
		g.optionProvider = optionProvider;
		void g.runGame().catch((e) => {
			if (!(e instanceof GameOver)) throw e;
		});
		await g.waitIdle();
		// 先手（0 号座）就是当前回合角色，可能已经在摸牌阶段又多摸了 2 张，
		// 所以断言 >= 4 而不是恰好 4；后手不受影响，断言恰好 6
		expect(g.state.players[0].hand.length).toBeGreaterThanOrEqual(4);
		expect(g.state.players[1].hand.length).toBe(6);
	});

	it('不给 rosters 时会走选将询问，且是 chooseOption', async () => {
		const rec = makeRecord(3);
		rec.setup.rosters = undefined;
		const g = new DuelGame(rec, registry);
		g.optionProvider = optionProvider;
		void g.runGame().catch((e) => {
			if (!(e instanceof GameOver)) throw e;
		});
		await g.waitIdle();
		const ask = g.getPendingAsk()!;
		expect(ask.kind).toBe('chooseOption');
		expect(ask.who).toBe('p0');
	});
});

/** 找一张真实装备牌的 id——牌的位置只能走 moveCards()，不能直接戳 p.equip，见 CLAUDE.md 的"牌的移动"约束 */
function findEquipCardId(g: DuelGame): number {
	const defName = Object.values(registry.cards).find((d) => d.type === 'equip')!.name;
	const found = Object.values(g.state.cards).find((c) => c.name === defName);
	if (!found) throw new Error('deck 里没找到装备牌，测试假设不成立');
	return found.id;
}

describe('单挑：换将', () => {
	it('替补还在时，阵亡即换将：体力回满、手牌为 4、装备判定区清空、不算真正死亡', async () => {
		const g = await boot(11);
		const p0 = g.state.players[0];
		// 给"旧武将"正经装备一张牌（走 equipCard，不能直接戳 p.equip），验证换将后确实清空了
		await g.equipCard('p0', findEquipCardId(g));
		expect(Object.keys(p0.equip).length).toBeGreaterThan(0);
		// equipCard 可能顺带挂一个装备技（如果这张装备牌自带的话），不是这条用例要测的东西，杀之前清掉
		p0.skills = [];

		await kill(g, 'p0');

		expect(p0.alive).toBe(true); // 还有替补，不是真的死了
		expect(p0.general).toBe('zhangfei'); // 名单里的第二个
		expect(p0.hp).toBe(p0.maxHp);
		expect(p0.hand.length).toBe(4);
		expect(p0.equip).toEqual({});
		expect(p0.judge).toEqual([]);

		const switchLog = g.log.find((e) => e.kind === 'switchGeneral' && e.who === 'p0');
		expect(switchLog).toBeDefined();
		expect(switchLog?.general).toBe('zhangfei');

		const dieLog = [...g.log].reverse().find((e) => e.kind === 'die' && e.who === 'p0');
		expect(dieLog?.switching).toBe(true);
	});

	it('rosterLeft 随每次阵亡递减，换将不影响对手', async () => {
		const g = await boot(12);
		const p0 = g.state.players[0];
		expect(p0.flags['game:rosterLeft']).toBe(3);

		await kill(g, 'p0');
		expect(p0.flags['game:rosterLeft']).toBe(2);
		expect(g.state.players[1].flags['game:rosterLeft']).toBe(3);

		sterilize(g); // 张飞已经带着真技能上场了，杀第二刀前先清干净
		await kill(g, 'p0');
		expect(p0.flags['game:rosterLeft']).toBe(1);
		expect(p0.general).toBe('guanyu'); // 名单里的第三个
	});

	it('本回合已用的技能计数（turn: 前缀）不会带进新武将，跨武将的计数（如 rosterLeft）不受影响', async () => {
		const g = await boot(13);
		const p0 = g.state.players[0];
		p0.flags['turn:someSkillUsed'] = 3;

		await kill(g, 'p0');

		expect(p0.flags['turn:someSkillUsed']).toBeUndefined();
		expect(p0.flags['game:rosterLeft']).toBe(2);
	});
});

describe('单挑：胜负判定', () => {
	it('三将尽出即败，对方获胜；rosterLeft 归零', async () => {
		const g = await boot(21);
		const p0 = g.state.players[0];
		const p1 = g.state.players[1];

		await kill(g, 'p0'); // zhaoyun 阵亡 → 换 zhangfei
		expect(g.state.finished).toBeUndefined();
		sterilize(g);
		await kill(g, 'p0'); // zhangfei 阵亡 → 换 guanyu
		expect(g.state.finished).toBeUndefined();
		sterilize(g);
		await kill(g, 'p0'); // guanyu 阵亡，替补耗尽，真正出局

		expect(p0.alive).toBe(false);
		expect(p0.flags['game:rosterLeft']).toBe(0);
		expect(g.state.finished).toBeDefined();
		expect(g.state.finished!.winners).toEqual([p1.id]);
		expect(g.state.finished!.reason).toContain(p1.nickname);
	});

	it('对局能跑完：随机走两边的死亡直到分出胜负，不崩', async () => {
		const g = await boot(31);
		let turn = 0;
		// 交替砍两边，制造一场拉锯，验证连续换将不会把引擎带崩
		while (!g.state.finished) {
			const who = turn % 2 === 0 ? 'p0' : 'p1';
			await kill(g, who);
			sterilize(g);
			turn++;
			expect(turn).toBeLessThan(20); // 双方总共最多 6 条命，20 步内必分胜负，防死循环挂住测试
		}
		expect(g.state.finished).toBeDefined();
		expect(['p0', 'p1']).toContain(g.state.finished!.winners[0]);
	});
});
