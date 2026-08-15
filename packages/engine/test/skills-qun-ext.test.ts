/**
 * 群势力风包 / 火包技能测试：张角（雷击、鬼道）、颜良文丑（双雄）、
 * 袁绍（乱击、血裔）、庞德（鞬出）。
 *
 * 手法沿用 skills.test.ts：手工拼装 PlayerState 跳过 setupGame()/runGame()，
 * 需要经过 g.ask() 的地方用 drive() 把请求逐个喂掉。判定类技能靠 stackTop() 把
 * 指定的牌压到牌堆顶 —— 判定结果必须是确定的，不然测的就是运气不是规则。
 */

import { describe, expect, it } from 'vitest';
import type { CardDef } from '../src/defs.js';
import { Game } from '../src/game.js';
import { optionProvider } from '../src/options.js';
import type { AskRequest, DecisionPayload, GameRecord } from '../src/protocol.js';
import { registry } from '../src/registry.js';
import { suitColor, type Card, type EquipSlot, type PlayerState, type UseEvent } from '../src/types.js';

function makeGame(specs: Array<{ id: string; general: string; hp?: number }>): Game {
	const record: GameRecord = {
		seed: 7,
		setup: {
			mode: 'identity',
			players: specs.map((s) => ({ id: s.id, nickname: s.id })),
			packs: ['standard', 'wind', 'fire'],
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

function moveToEquip(g: Game, who: string, cardId: number): void {
	g.state.drawPile = g.state.drawPile.filter((c) => c !== cardId);
	const slot = g.cardDef(g.card(cardId).name).subtype as EquipSlot;
	g.player(who).equip[slot] = cardId;
	g.state.locations[cardId] = { zone: 'equip', owner: who };
}

function moveToProcessing(g: Game, cardId: number): void {
	g.state.drawPile = g.state.drawPile.filter((c) => c !== cardId);
	if (!g.state.processing.includes(cardId)) g.state.processing.push(cardId);
	g.state.locations[cardId] = { zone: 'processing' };
}

/** 把一张牌压到牌堆顶，让下一次判定必定翻出它 */
function stackTop(g: Game, cardId: number): void {
	g.state.drawPile = g.state.drawPile.filter((c) => c !== cardId);
	g.state.drawPile.unshift(cardId);
	g.state.locations[cardId] = { zone: 'draw' };
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

/** 一路点"是"：确认发动、选第一个目标、选前 min 张牌、选第一个选项 */
function acceptAll(ask: AskRequest): DecisionPayload {
	switch (ask.kind) {
		case 'confirmSkill':
			return { type: 'confirm', yes: true };
		case 'choosePlayers':
			return { type: 'players', players: ask.candidates.slice(0, Math.max(1, ask.min)) };
		case 'chooseCards':
			return { type: 'cards', cards: ask.candidates.map((c) => c.id).slice(0, Math.max(1, ask.min)) };
		case 'chooseOption':
			return { type: 'option', optionId: ask.options[0].id };
		default:
			return { type: 'pass' };
	}
}

describe('群·风火扩充包技能', () => {
	describe('雷击（张角）', () => {
		it('打出【闪】后判定为梅花：张角回复 1 点体力，目标受到 1 点雷电伤害', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'sp_zhangjiao', hp: 2 },
				{ id: 'p1', general: 'huatuo' },
			]);
			stackTop(g, findCard(g, (c) => c.suit === 'club'));

			await drive(g, g.trigger('onRespond', { who: 'p0', use: { name: 'shan', cards: [] } }), acceptAll);

			expect(g.player('p0').hp).toBe(3);
			expect(g.player('p1').hp).toBe(2);
			expect(g.log.some((e) => e.kind === 'damage' && (e as any).nature === 'thunder')).toBe(true);
		});

		it('判定为黑桃：目标受到 2 点雷电伤害，张角不回血', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'sp_zhangjiao', hp: 2 },
				{ id: 'p1', general: 'huatuo' },
			]);
			stackTop(g, findCard(g, (c) => c.suit === 'spade'));

			await drive(g, g.trigger('onRespond', { who: 'p0', use: { name: 'shan', cards: [] } }), acceptAll);

			expect(g.player('p0').hp).toBe(2);
			expect(g.player('p1').hp).toBe(1);
		});

		it('判定为红色时双方都不受影响', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'sp_zhangjiao', hp: 2 },
				{ id: 'p1', general: 'huatuo' },
			]);
			stackTop(g, findCard(g, (c) => c.suit === 'heart'));

			await drive(g, g.trigger('onRespond', { who: 'p0', use: { name: 'shan', cards: [] } }), acceptAll);

			expect(g.player('p0').hp).toBe(2);
			expect(g.player('p1').hp).toBe(3);
		});
	});

	describe('鬼道（张角）', () => {
		it('用一张黑色手牌替换掉别人的判定牌，判定结果随之改变', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'sp_zhangjiao' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const redJudge = findCard(g, (c) => suitColor(c.suit) === 'red');
			stackTop(g, redJudge);
			const blackId = findCard(g, (c) => suitColor(c.suit) === 'black');
			moveToHand(g, 'p0', blackId);

			const ev = await drive(
				g,
				g.judge('p1', 'test', (c) => suitColor(c.suit) === 'black'),
				acceptAll,
			);

			expect(ev.card!.id).toBe(blackId);
			expect(ev.result).toBe(true);
			expect(g.player('p0').hand).not.toContain(blackId);
		});

		it('手里没有黑色牌时不触发', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'sp_zhangjiao' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const redJudge = findCard(g, (c) => suitColor(c.suit) === 'red');
			stackTop(g, redJudge);
			moveToHand(g, 'p0', findCard(g, (c) => suitColor(c.suit) === 'red' && c.id !== redJudge));

			const ev = await drive(
				g,
				g.judge('p1', 'test', (c) => suitColor(c.suit) === 'black'),
				acceptAll,
			);

			expect(ev.card!.id).toBe(redJudge);
			expect(ev.result).toBe(false);
		});
	});

	describe('双雄（颜良文丑）', () => {
		it('摸牌阶段改为判定并获得判定牌，本回合可将异色手牌当【决斗】使用', async () => {
			const g = makeGame([
				{ id: 'p0', general: 'yanwen' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const judgeId = findCard(g, (c) => c.suit === 'spade');
			stackTop(g, judgeId);
			const redId = findCard(g, (c) => suitColor(c.suit) === 'red' && c.name !== 'juedou');
			const blackId = findCard(g, (c) => suitColor(c.suit) === 'black' && c.id !== judgeId && c.name !== 'juedou');
			moveToHand(g, 'p0', redId);
			moveToHand(g, 'p0', blackId);

			const ev = { who: 'p0', num: 2, replaced: false };
			await drive(g, g.trigger('drawPhaseNum', ev), acceptAll);

			expect(ev.replaced).toBe(true); // 整个替换摸牌，不再摸那两张
			expect(g.player('p0').hand).toContain(judgeId);

			const opts = optionProvider.play(g, 'p0');
			const converted = opts.filter((o) => o.viaSkill === 'shuangxiong' && o.name === 'juedou');
			expect(converted.map((o) => o.cards[0])).toContain(redId);
			expect(converted.map((o) => o.cards[0])).not.toContain(blackId);
			expect(converted[0].targets.candidates).toContain('p1');
		});

		it('没发动过双雄时不能把手牌当【决斗】用', () => {
			const g = makeGame([
				{ id: 'p0', general: 'yanwen' },
				{ id: 'p1', general: 'huatuo' },
			]);
			moveToHand(g, 'p0', findCard(g, (c) => suitColor(c.suit) === 'red'));

			expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'shuangxiong')).toBe(false);
		});
	});

	describe('乱击（袁绍）', () => {
		it('用两张同花色手牌真的打出了【万箭齐发】，所有其他角色各受 1 点伤害', async () => {
			const g = makeGame([
				{ id: 'p0', general: 're_yuanshao' },
				{ id: 'p1', general: 'huatuo' },
				{ id: 'p2', general: 'huatuo' },
			]);
			const a = findCard(g, (c) => c.suit === 'club');
			const b = findCard(g, (c) => c.suit === 'club' && c.id !== a);
			moveToHand(g, 'p0', a);
			moveToHand(g, 'p0', b);

			// 死代码回归：count>1 的转化技不会被枚举，乱击必须以 active 的形式出现在菜单里
			const opt = optionProvider.play(g, 'p0').find((o) => o.viaSkill === 'luanji');
			expect(opt).toBeDefined();

			await drive(g, registry.skills.luanji.active!.run(g, g.player('p0')), acceptAll);

			const used = g.log.find((e) => e.kind === 'use' && (e as any).name === 'wanjianqifa') as any;
			expect(used).toBeDefined();
			expect(used.cards.sort()).toEqual([a, b].sort());
			expect(g.player('p0').hand).toHaveLength(0);
			expect(g.player('p1').hp).toBe(2);
			expect(g.player('p2').hp).toBe(2);
		});

		it('手上没有两张同花色的牌时点不出乱击', () => {
			const g = makeGame([
				{ id: 'p0', general: 're_yuanshao' },
				{ id: 'p1', general: 'huatuo' },
			]);
			moveToHand(g, 'p0', findCard(g, (c) => c.suit === 'club'));
			moveToHand(g, 'p0', findCard(g, (c) => c.suit === 'heart'));

			expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'luanji')).toBe(false);
		});
	});

	describe('血裔（袁绍）', () => {
		it('每有一名其他群雄角色存活，手牌上限 +2', () => {
			const g = makeGame([
				{ id: 'p0', general: 're_yuanshao' },
				{ id: 'p1', general: 'huatuo' },
				{ id: 'p2', general: 'diaochan' },
				{ id: 'p3', general: 'caocao' },
			]);

			expect(g.handLimit('p0')).toBe(g.player('p0').hp + 4);

			g.player('p1').alive = false;
			expect(g.handLimit('p0')).toBe(g.player('p0').hp + 2);

			g.player('p2').alive = false;
			expect(g.handLimit('p0')).toBe(g.player('p0').hp);
		});
	});

	describe('鞬出（庞德）', () => {
		it('弃掉的是装备牌：此【杀】不可被【闪】响应', async () => {
			const g = makeGame([
				{ id: 'p0', general: 're_pangde' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const shaId = findCard(g, (c) => c.name === 'sha');
			moveToProcessing(g, shaId);
			const equipId = findCard(g, (c, def) => def.type === 'equip');
			moveToEquip(g, 'p1', equipId);

			const ev: UseEvent = { source: 'p0', use: { name: 'sha', cards: [shaId] }, targets: ['p1'], cancelledFor: [] };
			await drive(g, g.trigger('onTargetChosen', ev), acceptAll);

			expect(g.locate(equipId).zone).toBe('discard');
			expect(ev.unavoidableFor).toContain('p1');
			expect(g.player('p1').hand).not.toContain(shaId);
		});

		it('弃掉的不是装备牌：目标获得这张【杀】', async () => {
			const g = makeGame([
				{ id: 'p0', general: 're_pangde' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const shaId = findCard(g, (c) => c.name === 'sha');
			moveToProcessing(g, shaId);
			const taoId = findCard(g, (c) => c.name === 'tao');
			moveToHand(g, 'p1', taoId);

			const ev: UseEvent = { source: 'p0', use: { name: 'sha', cards: [shaId] }, targets: ['p1'], cancelledFor: [] };
			await drive(g, g.trigger('onTargetChosen', ev), acceptAll);

			expect(g.locate(taoId).zone).toBe('discard');
			expect(ev.unavoidableFor ?? []).not.toContain('p1');
			expect(g.player('p1').hand).toContain(shaId);
			expect(g.locate(shaId)).toEqual({ zone: 'hand', owner: 'p1' });
		});

		it('目标区域内没有牌时不触发', () => {
			const g = makeGame([
				{ id: 'p0', general: 're_pangde' },
				{ id: 'p1', general: 'huatuo' },
			]);
			const shaId = findCard(g, (c) => c.name === 'sha');
			moveToProcessing(g, shaId);
			const ev: UseEvent = { source: 'p0', use: { name: 'sha', cards: [shaId] }, targets: ['p1'], cancelledFor: [] };

			expect(registry.skills.jianchu.triggers![0].can(g, g.player('p0'), ev)).toBe(false);
		});
	});
});
