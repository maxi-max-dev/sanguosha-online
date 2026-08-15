/**
 * 吴势力扩充包技能测试：小乔（天香）/ 太史慈（天义）。
 *
 * 手法沿用 skills.test.ts：直接 new Game() 后手工拼装 PlayerState，跳过
 * setupGame()/runGame()，只有真正会经过 g.ask() 的流程才用 drive() 把请求喂掉。
 * 拼点要比点数，所以布景时给双方各塞一张点数写死的手牌 —— 不能靠"随便一张"，
 * 否则测的是运气不是规则。
 */

import { describe, expect, it } from 'vitest';
import type { CardDef } from '../src/defs.js';
import { Game } from '../src/game.js';
import { optionProvider } from '../src/options.js';
import type { AskRequest, DecisionPayload, GameRecord } from '../src/protocol.js';
import { registry } from '../src/registry.js';
import type { Card, PlayerState } from '../src/types.js';

// ─────────────────────── 最小开局 ───────────────────────

function makeGame(specs: Array<{ id: string; general: string; hp?: number }>): Game {
	const record: GameRecord = {
		seed: 1,
		setup: {
			mode: 'identity',
			players: specs.map((s) => ({ id: s.id, nickname: s.id })),
			packs: ['standard'],
		},
		decisions: [],
	};
	const g = new Game(record, registry);
	g.state.players = specs.map((s, seat): PlayerState => {
		const gd = registry.generals[s.general];
		if (!gd) throw new Error(`未知武将 ${s.general}`);
		return {
			id: s.id,
			seat,
			nickname: s.id,
			general: gd.id,
			faction: gd.faction,
			gender: gd.gender,
			identity: seat === 0 ? 'lord' : 'rebel',
			identityRevealed: true,
			maxHp: gd.maxHp,
			hp: s.hp ?? gd.maxHp,
			hand: [],
			equip: {},
			judge: [],
			alive: true,
			chained: false,
			turnedOver: false,
			skills: [...gd.skills],
			disabledSkills: [],
			flags: {},
			offline: false,
		};
	});
	g.state.seating = g.state.players.map((p) => p.id);
	g.state.currentPlayer = g.state.players[0].id;
	g.optionProvider = optionProvider;
	return g;
}

function findCard(g: Game, predicate: (c: Card, def: CardDef) => boolean): number {
	const found = Object.values(g.state.cards).find(
		(c) => g.locate(c.id).zone === 'draw' && predicate(c, g.cardDef(c.name)),
	);
	if (!found) throw new Error('牌堆里找不到符合条件的牌');
	return found.id;
}

function moveToHand(g: Game, who: string, cardId: number): void {
	g.state.drawPile = g.state.drawPile.filter((c) => c !== cardId);
	const p = g.player(who);
	if (!p.hand.includes(cardId)) p.hand.push(cardId);
	g.state.locations[cardId] = { zone: 'hand', owner: who };
}

async function drive<T>(g: Game, run: Promise<T>, respond: (ask: AskRequest) => DecisionPayload): Promise<T> {
	let settled = false;
	let value: T | undefined;
	let failure: unknown;
	run.then(
		(v) => {
			settled = true;
			value = v;
		},
		(e) => {
			settled = true;
			failure = e;
		},
	);
	for (let guard = 0; guard < 1000 && !settled; guard++) {
		const ask = g.getPendingAsk();
		if (ask) {
			await g.submit(ask.who, respond(ask), false);
		} else {
			await Promise.resolve();
		}
	}
	if (failure !== undefined) throw failure;
	return value as T;
}

/** 发动天义：p0 手里塞点数 mine 的牌，对手塞点数 theirs 的牌，跑完一次拼点 */
async function runTianyi(g: Game, opponent: string, mine: number, theirs: number): Promise<void> {
	moveToHand(g, 'p0', findCard(g, (c) => c.number === mine));
	moveToHand(g, opponent, findCard(g, (c) => c.number === theirs));
	const skill = registry.skills.tianyi;
	await drive(g, skill.active!.run(g, g.player('p0')), (ask) => {
		if (ask.kind === 'choosePlayers') return { type: 'players', players: [opponent] };
		if (ask.kind === 'chooseCards') return { type: 'cards', cards: [ask.candidates[0].id] };
		return { type: 'pass' };
	});
}

// ─────────────────────── 测试 ───────────────────────

describe('风火包·吴', () => {
	describe('天香（小乔）', () => {
		it('弃一张红桃防止伤害，并把 1 点伤害转给选定角色，该角色按已损失体力摸牌', async () => {
			// 张飞 4 血：受完转移过来的 1 点还剩 2 血，不会进濒死把用例带偏
			const g = makeGame([
				{ id: 'p0', general: 'xiaoqiao' },
				{ id: 'p1', general: 'huatuo' },
				{ id: 'p2', general: 'zhangfei', hp: 3 },
			]);
			const heart = findCard(g, (c) => c.suit === 'heart');
			moveToHand(g, 'p0', heart);
			const xiaoqiao = g.player('p0');
			const victim = g.player('p2');
			const hpBefore = xiaoqiao.hp;

			await drive(
				g,
				g.damage({ source: 'p1', target: 'p0', amount: 1, nature: undefined }),
				(ask) => {
					if (ask.kind === 'confirmSkill') return { type: 'confirm', yes: true };
					if (ask.kind === 'chooseCards') return { type: 'cards', cards: [heart] };
					if (ask.kind === 'choosePlayers') return { type: 'players', players: ['p2'] };
					if (ask.kind === 'chooseOption') return { type: 'option', optionId: 'damage' };
					return { type: 'pass' };
				},
			);

			expect(xiaoqiao.hp).toBe(hpBefore); // 伤害被防止
			expect(xiaoqiao.hand).not.toContain(heart);
			expect(victim.hp).toBe(2);
			expect(victim.hand.length).toBe(2); // 已损失体力 4-2=2，摸 2 张
		});

		it('第二项：目标失去 1 点体力并获得小乔弃置的那张红桃', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'xiaoqiao' },
				{ id: 'p1', general: 'huatuo' },
				{ id: 'p2', general: 'zhangfei' },
			]);
			const heart = findCard(g, (c) => c.suit === 'heart');
			moveToHand(g, 'p0', heart);
			const xiaoqiao = g.player('p0');
			const victim = g.player('p2');
			const hpBefore = xiaoqiao.hp;

			await drive(
				g,
				g.damage({ source: 'p1', target: 'p0', amount: 2, nature: undefined }),
				(ask) => {
					if (ask.kind === 'confirmSkill') return { type: 'confirm', yes: true };
					if (ask.kind === 'chooseCards') return { type: 'cards', cards: [heart] };
					if (ask.kind === 'choosePlayers') return { type: 'players', players: ['p2'] };
					if (ask.kind === 'chooseOption') return { type: 'option', optionId: 'loseHp' };
					return { type: 'pass' };
				},
			);

			expect(xiaoqiao.hp).toBe(hpBefore); // 2 点伤害同样整个被防下
			expect(victim.hp).toBe(3); // 只失去 1 点体力，和原伤害量无关
			expect(victim.hand).toContain(heart);
		});

		it('手上没有红桃时不触发', () => {
			const g = makeGame([
				{ id: 'p0', general: 'xiaoqiao' },
				{ id: 'p1', general: 'huatuo' },
			]);
			moveToHand(g, 'p0', findCard(g, (c) => c.suit === 'spade'));
			const spec = registry.skills.retianxiang.triggers![0];
			const ev = { source: 'p1', target: 'p0', amount: 1, nature: undefined };
			expect(spec.can(g, g.player('p0'), ev)).toBe(false);
		});
	});

	describe('天义（太史慈）', () => {
		it('拼点赢：本回合多一张【杀】，且距离被压到下限（杀无距离限制）', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'taishici' },
				{ id: 'p1', general: 'huatuo' },
				{ id: 'p2', general: 'huatuo' },
				{ id: 'p3', general: 'huatuo' },
			]);
			expect(g.shaLimit('p0')).toBe(1);
			expect(g.inAttackRange('p0', 'p2')).toBe(false); // 对面距离 2，空手攻击范围 1

			await runTianyi(g, 'p1', 13, 2);

			expect(g.getFlag('p0', 'turn:tianyiWin')).toBe(1);
			expect(g.shaLimit('p0')).toBe(2);
			expect(g.inAttackRange('p0', 'p2')).toBe(true);
			// 修正只作用于太史慈自己，别人的距离照旧
			expect(g.inAttackRange('p1', 'p3')).toBe(false);
		});

		it('拼点没赢：本回合【杀】从出牌选项里消失', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'taishici' },
				{ id: 'p1', general: 'huatuo' },
			]);

			await runTianyi(g, 'p1', 2, 13);

			expect(g.getFlag('p0', 'turn:tianyiLose')).toBe(1);
			expect(g.shaLimit('p0')).toBe(0);

			// 拼点用掉的牌已经进弃牌堆，重新塞一张杀进来验证它点不出去
			moveToHand(g, 'p0', findCard(g, (c) => c.name === 'sha'));
			expect(optionProvider.play(g, 'p0').some((o) => o.name === 'sha')).toBe(false);
			// 对照：撤掉天义的败方标记后同一张杀立刻可用，说明拦下它的确实是天义
			g.setFlag('p0', 'turn:tianyiLose', 0);
			expect(optionProvider.play(g, 'p0').some((o) => o.name === 'sha')).toBe(true);
		});

		it('出牌阶段限一次：发动后菜单里不再出现天义', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'taishici' },
				{ id: 'p1', general: 'huatuo' },
			]);
			// 双方各留两张：拼点各弃一张之后手牌仍不为空，这样选项消失只可能是次数用尽，
			// 不会和"没牌可拼所以 can() 为假"混在一起
			moveToHand(g, 'p0', findCard(g, (c) => c.number === 13));
			moveToHand(g, 'p0', findCard(g, (c) => c.number === 5));
			moveToHand(g, 'p1', findCard(g, (c) => c.number === 2));
			moveToHand(g, 'p1', findCard(g, (c) => c.number === 4));
			expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'tianyi')).toBe(true);

			await drive(g, registry.skills.tianyi.active!.run(g, g.player('p0')), (ask) => {
				if (ask.kind === 'choosePlayers') return { type: 'players', players: ['p1'] };
				if (ask.kind === 'chooseCards') return { type: 'cards', cards: [ask.candidates[0].id] };
				return { type: 'pass' };
			});

			expect(g.player('p0').hand.length).toBeGreaterThan(0);
			expect(g.player('p1').hand.length).toBeGreaterThan(0);
			expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'tianyi')).toBe(false);
		});
	});
});
