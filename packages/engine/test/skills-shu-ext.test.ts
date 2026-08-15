/**
 * 蜀势力风包 / 火包技能测试：黄忠烈弓、魏延狂骨/奇谋、庞统连环/涅槃、卧龙八阵/火计/看破。
 *
 * 手法与 skills.test.ts 相同（那边的 makeGame/drive 是文件内私有的，没导出，所以这里
 * 照抄一份最小骨架，不去动已经跑绿的老文件）：直接 new Game() 手工拼装 PlayerState，
 * 跳过 setupGame()/runGame()，只有需要经过 g.ask() 的地方才用 drive() 把请求喂掉。
 *
 * 每个用例测的都是"这个技能的效果真的发生了"（血掉了几点、牌进没进弃牌堆、距离变没变），
 * 不是"技能对象存在"。
 */

import { describe, expect, it } from 'vitest';
import type { CardDef } from '../src/defs.js';
import { Game } from '../src/game.js';
import { optionProvider } from '../src/options.js';
import type { AskRequest, DecisionPayload, GameRecord } from '../src/protocol.js';
import { registry } from '../src/registry.js';
import { SHU_SKILLS } from '../src/skills/shu.js';
import { suitColor, type Card, type EquipSlot, type PlayerState } from '../src/types.js';

// ─────────────────────── 最小开局 ───────────────────────

function makeGame(specs: Array<{ id: string; general: string; hp?: number }>): Game {
	const record: GameRecord = {
		seed: 7,
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

/** 若干个陪练：技能表里没有触发器，不会干扰被测技能 */
function extras(n: number, from = 1): Array<{ id: string; general: string }> {
	return Array.from({ length: n }, (_, i) => ({ id: `p${from + i}`, general: 'huatuo' }));
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

/** 把某张牌顶到牌堆最上面，让接下来的判定结果可控 */
function stackTop(g: Game, cardId: number): void {
	g.state.drawPile = [cardId, ...g.state.drawPile.filter((c) => c !== cardId)];
	g.state.locations[cardId] = { zone: 'draw' };
}

async function drive<T>(
	g: Game,
	run: Promise<T>,
	respond: (ask: AskRequest) => DecisionPayload,
	seen?: AskRequest[],
): Promise<T> {
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
			seen?.push(ask);
			await g.submit(ask.who, respond(ask), false);
		} else {
			await Promise.resolve();
		}
	}
	if (failure !== undefined) throw failure;
	return value as T;
}

/** 一律同意发动技能，其余请求交给调用方处理 */
function answers(map: (ask: AskRequest) => DecisionPayload | undefined): (ask: AskRequest) => DecisionPayload {
	return (ask) => {
		const r = map(ask);
		if (r) return r;
		if (ask.kind === 'confirmSkill') return { type: 'confirm', yes: true };
		return { type: 'pass' };
	};
}

// ─────────────────────── 黄忠 ───────────────────────

describe('烈弓（黄忠）', () => {
	it('①可以打攻击范围外、但距离不大于【杀】点数的角色', async () => {
		const g = makeGame([{ id: 'p0', general: 're_huangzhong' }, ...extras(6)]);
		const shaId = findCard(g, (c) => c.name === 'sha' && c.number === 2);
		moveToHand(g, 'p0', shaId);

		// 7 人局：p2/p5 距离 2，p3/p4 距离 3，都在攻击范围（1）之外
		expect(g.inAttackRange('p0', 'p2')).toBe(false);
		expect(g.distance('p0', 'p3')).toBe(3);

		const option = optionProvider.play(g, 'p0').find((o) => o.viaSkill === 'xinliegong' && o.cards.length === 0);
		expect(option).toBeDefined();

		const seen: AskRequest[] = [];
		await drive(
			g,
			SHU_SKILLS.xinliegong.active!.run(g, g.player('p0')),
			answers((ask) => {
				if (ask.kind === 'chooseCards') return { type: 'cards', cards: [shaId] };
				if (ask.kind === 'choosePlayers') return { type: 'players', players: ['p2'] };
				return undefined;
			}),
			seen,
		);

		// 点数 2 的【杀】只够得到距离 2 的人，距离 3 的 p3/p4 不在候选里
		const targetAsk = seen.find((a) => a.kind === 'choosePlayers');
		expect(targetAsk && 'candidates' in targetAsk ? targetAsk.candidates.slice().sort() : []).toEqual(['p2', 'p5']);
		expect(g.player('p2').hp).toBe(2);
		expect(g.locate(shaId).zone).toBe('discard');
	});

	it('够不够得着由【杀】的点数说了算，点数不足时技能按钮不出现', () => {
		const g = makeGame([{ id: 'p0', general: 're_huangzhong' }, ...extras(6)]);
		// 给距离 2 的两个人各挂一匹 +1 马，全场最近的"范围外目标"就被推到了距离 3
		moveToEquip(g, 'p2', findCard(g, (c, def) => def.subtype === 'horsePlus'));
		moveToEquip(g, 'p5', findCard(g, (c, def) => def.subtype === 'horsePlus'));
		expect(g.distance('p0', 'p2')).toBe(3);

		moveToHand(g, 'p0', findCard(g, (c) => c.name === 'sha' && c.number === 2));
		expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'xinliegong')).toBe(false);

		moveToHand(g, 'p0', findCard(g, (c) => c.name === 'sha' && c.number === 3));
		expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'xinliegong')).toBe(true);
	});

	it('②目标手牌不多于自己则【杀】不可响应，体力不低于自己则伤害+1', async () => {
		const g = makeGame([
			{ id: 'p0', general: 're_huangzhong', hp: 2 },
			{ id: 'p1', general: 'huatuo', hp: 3 },
		]);
		const shaId = findCard(g, (c) => c.name === 'sha');
		const spareId = findCard(g, (c) => c.name === 'tao');
		const shanId = findCard(g, (c) => c.name === 'shan');
		moveToHand(g, 'p0', shaId);
		moveToHand(g, 'p0', spareId);
		moveToHand(g, 'p1', shanId);

		await drive(
			g,
			g.useCard('p0', { name: 'sha', cards: [shaId] }, ['p1']),
			// 若【闪】真被问到就打出来——正因为烈弓让杀不可响应，这一支不会被走到
			answers((ask) => (ask.kind === 'respond' ? { type: 'play', optionId: `card:${shanId}`, targets: [] } : undefined)),
		);

		expect(g.player('p1').hp).toBe(1); // 3 - (1+1)
		expect(g.player('p1').hand).toContain(shanId); // 从没被问过闪
	});

	it('②的伤害+1 只作用于发动那一次【杀】，同回合第二张不沾光', async () => {
		const g = makeGame([
			{ id: 'p0', general: 're_huangzhong', hp: 2 },
			{ id: 'p1', general: 'huatuo', hp: 3 },
		]);
		const sha1 = findCard(g, (c) => c.name === 'sha');
		const sha2 = findCard(g, (c) => c.name === 'sha' && c.id !== sha1);
		moveToHand(g, 'p0', sha1);
		moveToHand(g, 'p0', sha2);

		await drive(g, g.useCard('p0', { name: 'sha', cards: [sha1] }, ['p1']), answers(() => undefined));
		expect(g.player('p1').hp).toBe(1);

		g.player('p1').hp = 3;
		// 第二张【杀】明确放弃发动烈弓，flag 里残留的加成不该被它读到
		await drive(
			g,
			g.useCard('p0', { name: 'sha', cards: [sha2] }, ['p1']),
			(ask) => (ask.kind === 'confirmSkill' ? { type: 'confirm', yes: false } : { type: 'pass' }),
		);
		expect(g.player('p1').hp).toBe(2);
	});
});

// ─────────────────────── 魏延 ───────────────────────

describe('狂骨（魏延）', () => {
	it('对距离 1 以内的角色造成伤害后可回复体力', async () => {
		const g = makeGame([
			{ id: 'p0', general: 're_weiyan', hp: 2 },
			{ id: 'p1', general: 'huatuo' },
		]);
		await drive(
			g,
			g.damage({ source: 'p0', target: 'p1', amount: 1, nature: undefined }),
			answers((ask) => (ask.kind === 'chooseOption' ? { type: 'option', optionId: 'recover' } : undefined)),
		);
		expect(g.player('p0').hp).toBe(3);
		expect(g.player('p1').hp).toBe(2);
	});

	it('距离大于 1 时不触发', async () => {
		const g = makeGame([{ id: 'p0', general: 're_weiyan', hp: 2 }, ...extras(6)]);
		expect(g.distance('p0', 'p3')).toBe(3);
		const seen: AskRequest[] = [];
		await drive(g, g.damage({ source: 'p0', target: 'p3', amount: 1, nature: undefined }), answers(() => undefined), seen);
		expect(seen.filter((a) => a.kind === 'confirmSkill')).toHaveLength(0);
		expect(g.player('p0').hp).toBe(2);
	});
});

describe('奇谋（魏延）', () => {
	it('失去 X 点体力后本回合距离 -X、可多使用 X 张【杀】，且整局只能发动一次', async () => {
		const g = makeGame([{ id: 'p0', general: 're_weiyan' }, ...extras(6)]);
		expect(g.shaLimit('p0')).toBe(1);
		expect(g.distance('p0', 'p3')).toBe(3);
		expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'qimou')).toBe(true);

		await drive(
			g,
			SHU_SKILLS.qimou.active!.run(g, g.player('p0')),
			answers((ask) => (ask.kind === 'chooseOption' ? { type: 'option', optionId: '2' } : undefined)),
		);

		expect(g.player('p0').hp).toBe(2);
		expect(g.shaLimit('p0')).toBe(3);
		expect(g.distance('p0', 'p3')).toBe(1);
		expect(optionProvider.play(g, 'p0').some((o) => o.viaSkill === 'qimou')).toBe(false);
	});
});

// ─────────────────────── 庞统 ───────────────────────

describe('连环（庞统）', () => {
	it('把♣手牌当【铁索连环】使用，目标被横置', async () => {
		const g = makeGame([
			{ id: 'p0', general: 'pangtong' },
			{ id: 'p1', general: 'huatuo' },
		]);
		const clubId = findCard(g, (c) => c.suit === 'club' && c.name !== 'tiesuolianhuan');
		moveToHand(g, 'p0', clubId);

		await drive(
			g,
			SHU_SKILLS.lianhuan.active!.run(g, g.player('p0')),
			answers((ask) => {
				if (ask.kind === 'chooseCards') return { type: 'cards', cards: [clubId] };
				if (ask.kind === 'chooseOption') return { type: 'option', optionId: 'use' };
				if (ask.kind === 'choosePlayers') return { type: 'players', players: ['p1'] };
				return undefined;
			}),
		);

		expect(g.player('p1').chained).toBe(true);
		expect(g.locate(clubId).zone).toBe('discard');
	});

	it('也可以把♣手牌重铸：弃掉它并摸一张', async () => {
		const g = makeGame([
			{ id: 'p0', general: 'pangtong' },
			{ id: 'p1', general: 'huatuo' },
		]);
		const clubId = findCard(g, (c) => c.suit === 'club');
		moveToHand(g, 'p0', clubId);

		await drive(
			g,
			SHU_SKILLS.lianhuan.active!.run(g, g.player('p0')),
			answers((ask) => {
				if (ask.kind === 'chooseCards') return { type: 'cards', cards: [clubId] };
				if (ask.kind === 'chooseOption') return { type: 'option', optionId: 'recast' };
				return undefined;
			}),
		);

		expect(g.locate(clubId).zone).toBe('discard');
		expect(g.player('p0').hand).toHaveLength(1);
		expect(g.player('p0').hand[0]).not.toBe(clubId);
		expect(g.player('p1').chained).toBe(false);
	});
});

describe('涅槃（庞统）', () => {
	it('濒死时弃光区域内的牌、复原武将牌，摸三张并回到 3 点体力', async () => {
		const g = makeGame([
			{ id: 'p0', general: 'pangtong', hp: 0 },
			{ id: 'p1', general: 'huatuo' },
		]);
		const pangtong = g.player('p0');
		const handId = findCard(g, (c) => c.name === 'sha');
		const weaponId = findCard(g, (c, def) => def.type === 'equip' && def.subtype === 'weapon');
		moveToHand(g, 'p0', handId);
		moveToEquip(g, 'p0', weaponId);
		pangtong.turnedOver = true;
		pangtong.chained = true;

		await drive(g, g.dying('p0'), answers(() => undefined));

		expect(pangtong.alive).toBe(true);
		expect(pangtong.hp).toBe(3);
		expect(pangtong.hand).toHaveLength(3);
		expect(pangtong.hand).not.toContain(handId);
		expect(pangtong.equip.weapon).toBeUndefined();
		expect(pangtong.turnedOver).toBe(false);
		expect(pangtong.chained).toBe(false);
		expect(g.getFlag('p0', 'game:oldniepan')).toBe(1);
	});

	it('限定技：发动过就不再触发', async () => {
		const g = makeGame([
			{ id: 'p0', general: 'pangtong', hp: 0 },
			{ id: 'p1', general: 'huatuo' },
		]);
		g.setFlag('p0', 'game:oldniepan', 1);
		await drive(g, g.dying('p0'), answers(() => undefined));
		expect(g.player('p0').alive).toBe(false);
	});
});

// ─────────────────────── 卧龙诸葛亮 ───────────────────────

describe('八阵（卧龙诸葛亮）', () => {
	it('防具栏为空时，需要【闪】可以改为判定，红色即视为打出【闪】', async () => {
		const g = makeGame([
			{ id: 'p0', general: 'sp_zhugeliang' },
			{ id: 'p1', general: 'huatuo' },
		]);
		stackTop(g, findCard(g, (c) => suitColor(c.suit) === 'red'));

		const use = await drive(g, g.askForCard('p0', 'shan', '测试：请打出一张【闪】'), answers(() => undefined));

		expect(use).toEqual({ name: 'shan', cards: [], viaSkill: 'bazhen' });
	});

	it('防具栏有牌时不生效', async () => {
		const g = makeGame([
			{ id: 'p0', general: 'sp_zhugeliang' },
			{ id: 'p1', general: 'huatuo' },
		]);
		moveToEquip(g, 'p0', findCard(g, (c, def) => def.type === 'equip' && def.subtype === 'armor'));
		stackTop(g, findCard(g, (c) => suitColor(c.suit) === 'red'));

		const use = await drive(g, g.askForCard('p0', 'shan', '测试：请打出一张【闪】'), answers(() => undefined));

		expect(use).toBeNull();
	});
});

describe('火计（卧龙诸葛亮）', () => {
	it('红色手牌能转化成【火攻】，黑色手牌不能', () => {
		const g = makeGame([
			{ id: 'p0', general: 'sp_zhugeliang' },
			{ id: 'p1', general: 'huatuo' },
		]);
		const redId = findCard(g, (c) => suitColor(c.suit) === 'red' && c.name !== 'huogong');
		const blackId = findCard(g, (c) => suitColor(c.suit) === 'black');
		moveToHand(g, 'p0', redId);
		moveToHand(g, 'p0', blackId);
		moveToHand(g, 'p1', findCard(g, (c) => c.name === 'sha')); // 火攻要求目标有手牌

		const opts = optionProvider.play(g, 'p0').filter((o) => o.viaSkill === 'huoji');
		expect(opts.map((o) => o.cards[0])).toEqual([redId]);
		expect(opts[0].name).toBe('huogong');
		expect(opts[0].targets.candidates).toContain('p1');
	});
});

describe('看破（卧龙诸葛亮）', () => {
	it('黑色手牌能转化成【无懈可击】，红色手牌不能', () => {
		const g = makeGame([
			{ id: 'p0', general: 'sp_zhugeliang' },
			{ id: 'p1', general: 'huatuo' },
		]);
		const blackId = findCard(g, (c) => suitColor(c.suit) === 'black' && c.name !== 'wuxiekeji');
		const redId = findCard(g, (c) => suitColor(c.suit) === 'red');
		moveToHand(g, 'p0', blackId);
		moveToHand(g, 'p0', redId);

		// 用引擎问无懈时的那个 need 去枚举 —— 简称对不上牌名的话这里就会是空的
		const opts = optionProvider.respond(g, 'p0', 'wuxiekeji', 'respond').filter((o) => o.viaSkill === 'kanpo');
		expect(opts.map((o) => o.cards[0])).toEqual([blackId]);
		expect(opts[0].name).toBe('wuxiekeji');
	});
});
