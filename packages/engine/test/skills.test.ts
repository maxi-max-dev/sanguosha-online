/**
 * 武将技能测试（wei/shu/wu/qun 四个技能文件）。
 *
 * 需要真实卡牌才能跑：转化技的合法性判断走真实 CardDef，奸雄那类"获得造成伤害的
 * 牌"也要有真实杀/闪/桃的结算语义撑着。cards/ + deck.ts 还没并入 registry 之前，
 * import registry 就会带着两个"模块找不到"的类型错误，运行时 buildDeck 也会炸——
 * 所以整个文件用 describe.skip 占位：结构先写对，等 cards/ 就绪后去掉最外层的
 * .skip 就能跑，不需要再重新设计用例。
 *
 * 测试手法和 core.test.ts 不同：core.test.ts 全程通过 runGame() 的单一协程 + submit()
 * 驱动一整局真实对局。这里大多数用例只想验证一个孤立的技能机制，不需要也不应该
 * 跑完整的开局流程——所以直接 new Game() 后手工拼装 PlayerState（跳过 setupGame()/
 * runGame()），只有真正需要经过 g.ask() 的场景（奸雄的"是否发动"确认）才用 drive()
 * 顺带把请求喂掉。因为没有 runGame() 协程在跑，不存在"两个地方抢同一个 pending
 * 请求"的问题，可以放心直接调用 g.damage() 这类方法。
 */

import { describe, expect, it } from 'vitest';
import type { CardDef } from '../src/defs.js';
import { Game } from '../src/game.js';
import { markLimit, optionProvider } from '../src/options.js';
import type { AskRequest, DecisionPayload, GameRecord } from '../src/protocol.js';
import { registry } from '../src/registry.js';
import { suitColor, type Card, type EquipSlot, type PlayerState, type UseEvent } from '../src/types.js';

// ─────────────────────── 最小开局：跳过 setupGame()，手工拼装 ───────────────────────

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
	// 构造函数本身会把牌堆按 registry.buildDeck 铺好，只是不会分配座位/武将/手牌——
	// 那部分是 IdentityGame.setupGame() 干的活，这里不需要一整套选将/发牌流程，自己填
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

/** 从牌堆里找一张符合条件、还没被挪作他用的牌 */
function findCard(g: Game, predicate: (c: Card, def: CardDef) => boolean): number {
	const found = Object.values(g.state.cards).find(
		(c) => g.locate(c.id).zone === 'draw' && predicate(c, g.cardDef(c.name)),
	);
	if (!found) throw new Error('牌堆里找不到符合条件的牌');
	return found.id;
}

/** 把一张牌从当前区域挪进某人手牌，纯粹是测试布景，不走 moveCards 的事件通路 */
function moveToHand(g: Game, who: string, cardId: number): void {
	g.state.drawPile = g.state.drawPile.filter((c) => c !== cardId);
	const p = g.player(who);
	if (!p.hand.includes(cardId)) p.hand.push(cardId);
	g.state.locations[cardId] = { zone: 'hand', owner: who };
}

function moveToEquip(g: Game, who: string, cardId: number): void {
	g.state.drawPile = g.state.drawPile.filter((c) => c !== cardId);
	const slot = g.cardDef(g.card(cardId).name).subtype as EquipSlot;
	g.player(who).equip[slot] = cardId;
	g.state.locations[cardId] = { zone: 'equip', owner: who };
}

/** 模拟"这张牌正在结算杀的过程中"：还没进弃牌堆，暂存在处理区 */
function moveToProcessing(g: Game, cardId: number): void {
	g.state.drawPile = g.state.drawPile.filter((c) => c !== cardId);
	if (!g.state.processing.includes(cardId)) g.state.processing.push(cardId);
	g.state.locations[cardId] = { zone: 'processing' };
}

/**
 * 直接调用一个会经过 g.ask() 的方法（如 g.damage()），并用 respond 把过程中弹出的
 * 请求逐个喂掉。没有 runGame() 协程在跑，所以这里不会和别的地方抢 pending 请求。
 */
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
			// wait:false —— 这里没有 runGame() 在驱动，等 settle 会死锁（见 Game.submit 注释）
			await g.submit(ask.who, respond(ask), false);
		} else {
			await Promise.resolve(); // 让 run() 内部的 await 链继续往前走一步
		}
	}
	if (failure !== undefined) throw failure;
	return value as T;
}

// ─────────────────────── 测试 ───────────────────────

describe('武将技能', () => {
	describe('奸雄（曹操）', () => {
		it('受到伤害后，确认发动可获得造成伤害的那张牌', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'caocao' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const caocao = g.player('p0');
			const shaId = findCard(g, (c) => c.name === 'sha');
			moveToProcessing(g, shaId); // 模拟"这张杀正在结算到造成伤害那一步"
			const before = caocao.hand.length;

			await drive(
				g,
				g.damage({ source: 'p1', target: 'p0', amount: 1, nature: undefined, card: { name: 'sha', cards: [shaId] } }),
				(ask) => (ask.kind === 'confirmSkill' ? { type: 'confirm', yes: true } : { type: 'pass' }),
			);

			expect(caocao.hand).toContain(shaId);
			expect(caocao.hand.length).toBe(before + 1);
			expect(g.locate(shaId)).toEqual({ zone: 'hand', owner: 'p0' });
		});
	});

	describe('武圣（关羽）', () => {
		it('手牌里有红色牌时，出牌阶段能以武圣转化出杀', () => {
			const g = makeGame([
				{ id: 'p0', general: 'guanyu' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const redId = findCard(g, (c) => suitColor(c.suit) === 'red');
			moveToHand(g, 'p0', redId);

			const options = optionProvider.play(g, 'p0');
			const converted = options.find(
				(o) => o.viaSkill === 'wusheng' && o.name === 'sha' && o.cards.includes(redId),
			);
			expect(converted).toBeDefined();
			expect(converted!.targets.candidates).toContain('p1');
		});
	});

	describe('咆哮（张飞）', () => {
		it('使用【杀】没有次数上限', () => {
			const g = makeGame([
				{ id: 'p0', general: 'zhangfei' },
				{ id: 'p1', general: 'huatuo' },
			]);
			expect(g.shaLimit('p0')).toBe(Infinity);
		});
	});

	describe('马术（马超）', () => {
		it('计算与其他角色的距离 -1', () => {
			const g = makeGame([
				{ id: 'p0', general: 'machao' },
				{ id: 'p1', general: 'huatuo' },
				{ id: 'p2', general: 'huatuo' },
				{ id: 'p3', general: 'huatuo' },
			]);
			const machao = g.player('p0');

			// 必须先摘掉马术再找目标：带着 -1 的时候 4 人局所有距离都被压到下限 1，
			// 根本找不到"距离 >= 2"的人，target 会是 undefined
			machao.skills = [];
			const target = g.state.players.find((p) => p.id !== 'p0' && g.distance('p0', p.id) >= 2)!;

			const without = g.distance('p0', target.id);
			machao.skills = ['mashu', 'tieji'];
			const withSkill = g.distance('p0', target.id);

			expect(without - withSkill).toBe(1);
		});
	});

	describe('空城（诸葛亮）', () => {
		it('没有手牌时不能成为杀的目标，有手牌后恢复可以', () => {
			const g = makeGame([
				{ id: 'p0', general: 'zhugeliang' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const zhuge = g.player('p0');
			const shaId = findCard(g, (c) => c.name === 'sha');
			const fakeEv: UseEvent = { source: 'p1', use: { name: 'sha', cards: [] }, targets: [] };

			zhuge.hand = [];
			expect(g.canBeTargeted('p1', 'p0', fakeEv)).toBe(false);

			zhuge.hand = [shaId];
			expect(g.canBeTargeted('p1', 'p0', fakeEv)).toBe(true);
		});
	});

	describe('连营（陆逊）', () => {
		it('失去最后一张手牌后摸一张', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'luxun' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const luxun = g.player('p0');
			const only = findCard(g, (c) => c.name === 'sha');
			moveToHand(g, 'p0', only);

			await g.discardCards([only], 'test', 'p0');

			expect(luxun.hand.length).toBe(1); // 弃 1 摸 1，张数不变但已经不是原来那张
			expect(luxun.hand[0]).not.toBe(only);
		});
	});

	describe('枭姬（孙尚香）', () => {
		it('失去装备区的牌后摸两张，一次失去两张就摸两次共四张', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'sunshangxiang' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const xiaoji = g.player('p0');
			const weaponId = findCard(g, (c, def) => def.type === 'equip' && def.subtype === 'weapon');
			const armorId = findCard(g, (c, def) => def.type === 'equip' && def.subtype === 'armor');
			moveToEquip(g, 'p0', weaponId);
			moveToEquip(g, 'p0', armorId);

			await g.discardCards([weaponId, armorId], 'test', 'p0');

			expect(xiaoji.hand.length).toBe(4);
		});
	});

	describe('制衡（孙权）', () => {
		it('每回合限一次：markLimit 之后菜单里的选项就消失了', () => {
			const g = makeGame([
				{ id: 'p0', general: 'sunquan' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const sunquan = g.player('p0');
			moveToHand(g, 'p0', findCard(g, (c) => c.name === 'sha'));

			expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'zhiheng')).toBe(true);
			markLimit(g, sunquan, 'zhiheng', 'turn');
			expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'zhiheng')).toBe(false);
		});
	});
});
