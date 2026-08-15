/**
 * 群雄势力技能：华佗 / 吕布 / 貂蝉（标准包）；
 * 张角 / 颜良文丑 / 袁绍 / 庞德（风 / 火扩充包，见 generals.ts 的 pack 字段）。
 */

import type { SkillDef } from '../defs.js';
import type { Game } from '../game.js';
import { markLimit } from '../options.js';
import {
	suitColor,
	type CardUse,
	type Color,
	type DrawNumEvent,
	type JudgeEvent,
	type PhaseEvent,
	type PlayerState,
	type Suit,
	type UseEvent,
} from '../types.js';

// ─────────────────────────── 华佗 ───────────────────────────

const qingnang: SkillDef = {
	id: 'qingnang',
	cn: '青囊',
	desc: '出牌阶段限一次，你可以弃置一张手牌，令一名角色回复 1 点体力。',
	active: {
		limit: 'turn',
		can(g, self) {
			return self.hand.length > 0;
		},
		async run(g, self) {
			const targets = await g.askPlayers(
				self.id,
				'青囊：选择一名角色回复 1 点体力',
				g.alivePlayers().map((p) => p.id),
				1,
				1,
				true,
			);
			if (targets.length === 0) return;
			const cards = await g.askCards(self.id, '青囊：弃置一张手牌', self.hand.map((id) => ({ id })), 1, 1, true);
			if (cards.length === 0) return;
			markLimit(g, self, 'qingnang', 'turn');
			await g.discardCards(cards, 'qingnang', self.id);
			await g.recover({ source: self.id, target: targets[0], amount: 1 });
		},
	},
};

const jijiu: SkillDef = {
	id: 'jijiu',
	cn: '急救',
	desc: '你的回合外，你可以将一张红色牌当【桃】使用。',
	convert: {
		to: ['tao'],
		usage: ['use'],
		from: ['hand', 'equip'],
		can(g, self) {
			return g.state.currentPlayer !== self.id;
		},
		filter(g, self, card) {
			return suitColor(card.suit) === 'red';
		},
	},
};

// ─────────────────────────── 吕布 ───────────────────────────

const wushuang: SkillDef = {
	id: 'wushuang',
	cn: '无双',
	desc: '锁定技，你使用【杀】需要目标使用两张【闪】才能抵消；你使用或成为目标的【决斗】，对方每次需打出两张【杀】。',
	tags: ['locked'],
	mods: {
		shanNeeded(g, self, ev, base) {
			return ev.source === self.id ? 2 : base;
		},
		// 决斗的另一方无论是被吕布指定还是指定吕布，每轮都要出两张杀；
		// 这个 mod 只会在"吕布是这场决斗的一方"时被查到，所以恒定返回 2 即可
		shaNeededInDuel() {
			return 2;
		},
	},
};

// ─────────────────────────── 貂蝉 ───────────────────────────

const lijian: SkillDef = {
	id: 'lijian',
	cn: '离间',
	desc: '出牌阶段限一次，你可以弃置一张牌，令两名男性角色进行决斗。',
	active: {
		limit: 'turn',
		can(g, self) {
			if (self.hand.length + Object.keys(self.equip).length === 0) return false;
			return g.alivePlayers().filter((p) => p.gender === 'male').length >= 2;
		},
		async run(g, self) {
			const males = g.alivePlayers().filter((p) => p.gender === 'male').map((p) => p.id);
			const targets = await g.askPlayers(self.id, '离间：选择两名男性角色进行决斗', males, 2, 2, true);
			if (targets.length < 2) return;
			const pool = [
				...self.hand.map((id) => ({ id })),
				...Object.values(self.equip)
					.filter((x): x is number => typeof x === 'number')
					.map((id) => ({ id })),
			];
			const discard = await g.askCards(self.id, '离间：弃置一张牌', pool, 1, 1, true);
			if (discard.length === 0) return;
			markLimit(g, self, 'lijian', 'turn');
			await g.discardCards(discard, 'lijian', self.id);
			// 视为前者对后者使用【决斗】，貂蝉本人不是伤害来源
			const [a, b] = targets;
			await g.useCard(a, { name: 'juedou', cards: [] }, [b]);
		},
	},
};

const biyue: SkillDef = {
	id: 'biyue',
	cn: '闭月',
	desc: '锁定技，结束阶段开始时，你摸一张牌。',
	tags: ['locked'],
	triggers: [
		{
			timing: 'phaseStart',
			can(g, self, ev: PhaseEvent) {
				return ev.who === self.id && ev.phase === 'end';
			},
			async run(g, self) {
				await g.drawCards(self.id, 1, 'biyue');
			},
		},
	],
};

// ─────────────────────────── 张角（风包） ───────────────────────────

async function releijiRun(g: Game, self: PlayerState): Promise<void> {
	const others = g.othersFrom(self.id).map((p) => p.id);
	const picked = await g.askPlayers(self.id, '雷击：令一名其他角色进行判定', others, 1, 1, true);
	if (picked.length === 0) return;
	const target = picked[0];
	// 判定由目标进行（天妒/鬼道这类"你的判定"技能要认到人头上）
	const judgeEv = await g.judge(target, 'releiji', (c) => suitColor(c.suit) === 'black');
	const suit = judgeEv.card?.suit;
	if (suit === 'club') {
		await g.recover({ source: self.id, target: self.id, amount: 1 });
		await g.damage({ source: self.id, target, amount: 1, nature: 'thunder' });
	} else if (suit === 'spade') {
		await g.damage({ source: self.id, target, amount: 2, nature: 'thunder' });
	}
}

const releiji: SkillDef = {
	id: 'releiji',
	cn: '雷击',
	desc: '当你使用或打出一张【闪】时，你可令一名其他角色进行判定：若结果为梅花，你回复1点体力并对其造成1点雷电伤害；若结果为黑桃，你对其造成2点雷电伤害。',
	// "使用"和"打出"在引擎里是两条不相交的路：打出走 askForCard 的 onRespond，
	// 使用走 useCard 的 afterUse，两边都得挂。当前牌堆里【闪】其实只会被打出
	// （shan.canUse 恒 false，出牌阶段和转化技都枚举不出"使用闪"），afterUse 这条
	// 现在跑不到；留着是为了以后真出现"视为使用【闪】"的牌或技能时不漏触发。
	triggers: [
		{
			timing: 'onRespond',
			can(g, self, ev: { who: string; use: CardUse }) {
				return ev.who === self.id && ev.use.name === 'shan' && g.othersFrom(self.id).length > 0;
			},
			run: (g, self) => releijiRun(g, self),
		},
		{
			timing: 'afterUse',
			can(g, self, ev: UseEvent) {
				return ev.source === self.id && ev.use.name === 'shan' && g.othersFrom(self.id).length > 0;
			},
			run: (g, self) => releijiRun(g, self),
		},
	],
};

const guidao: SkillDef = {
	id: 'guidao',
	cn: '鬼道',
	desc: '一名角色的判定牌生效前，你可以打出一张黑色手牌代替之。',
	triggers: [
		{
			timing: 'beforeJudgeEffect',
			// 和鬼才一样不限制 ev.who===self：鬼道要能改任何人的判定
			can(g, self, ev: JudgeEvent) {
				return self.hand.some((id) => suitColor(g.card(id).suit) === 'black');
			},
			async run(g, self, ev: JudgeEvent) {
				const black = self.hand.filter((id) => suitColor(g.card(id).suit) === 'black');
				const picked = await g.askCards(
					self.id,
					`鬼道：是否打出一张黑色手牌代替 ${g.player(ev.who).nickname} 的判定牌？`,
					black.map((id) => ({ id })),
					1,
					1,
					true,
				);
				if (picked.length) await g.replaceJudgeCard(ev, picked[0]);
			},
		},
	],
};

// ─────────────────────────── 颜良文丑（火包） ───────────────────────────

function shuangxiongColor(self: PlayerState): Color | undefined {
	const raw = self.flags['turn:shuangxiong'];
	return raw === 'red' || raw === 'black' ? raw : undefined;
}

const shuangxiong: SkillDef = {
	id: 'shuangxiong',
	cn: '双雄',
	desc: '摸牌阶段，你可以改为进行一次判定并获得判定牌，然后本回合可将一张与判定牌颜色不同的手牌当【决斗】使用。',
	triggers: [
		{
			timing: 'drawPhaseNum',
			can(g, self, ev: DrawNumEvent) {
				return ev.who === self.id && !ev.replaced;
			},
			async run(g, self, ev: DrawNumEvent) {
				ev.replaced = true;
				// 判定结果本身不参与任何比较，这里只借判定流程翻一张牌出来（鬼才/鬼道仍可改它）
				const judgeEv = await g.judge(self.id, 'shuangxiong', () => true);
				const card = judgeEv.card;
				if (!card) return;
				g.setFlag(self.id, 'turn:shuangxiong', suitColor(card.suit));
				// judge() 收尾时已把判定牌丢进弃牌堆，从那里捞回；天妒之类可能先拿走了
				const zone = g.locate(card.id).zone;
				if (zone === 'discard' || zone === 'processing') {
					await g.gainCards(self.id, [card.id], 'shuangxiong');
				}
			},
		},
	],
	convert: {
		to: ['juedou'],
		usage: ['use'],
		can(g, self) {
			return shuangxiongColor(self) !== undefined;
		},
		filter(g, self, card) {
			return suitColor(card.suit) !== shuangxiongColor(self);
		},
	},
};

// ─────────────────────────── 袁绍（火包） ───────────────────────────

const SUIT_CN: Record<Suit, string> = { spade: '黑桃', heart: '红桃', club: '梅花', diamond: '方块' };
const SUIT_ORDER: readonly Suit[] = ['spade', 'heart', 'club', 'diamond'];

function luanjiSuits(g: Game, self: PlayerState): Suit[] {
	return SUIT_ORDER.filter((s) => self.hand.filter((id) => g.card(id).suit === s).length >= 2);
}

function luanjiTargets(g: Game, self: PlayerState): string[] {
	const fake: UseEvent = { source: self.id, use: { name: 'wanjianqifa', cards: [] }, targets: [] };
	return g
		.alivePlayers()
		.filter((p) => p.id !== self.id && g.canBeTargeted(self.id, p.id, fake))
		.map((p) => p.id);
}

const luanji: SkillDef = {
	id: 'luanji',
	cn: '乱击',
	desc: '出牌阶段，你可以将任意两张相同花色的手牌当【万箭齐发】使用。',
	// 写成 active 而不是 convert：options.ts 的转化技枚举有 `if (count !== 1) continue`，
	// 两张牌的转化技根本进不了选项表，写成 convert 就是永远点不出来的死代码
	active: {
		can(g, self) {
			return luanjiSuits(g, self).length > 0 && luanjiTargets(g, self).length > 0;
		},
		async run(g, self) {
			const suits = luanjiSuits(g, self);
			if (suits.length === 0) return;
			let suit = suits[0];
			if (suits.length > 1) {
				const choice = await g.askOption(
					self.id,
					'乱击：选择用哪个花色的两张手牌',
					suits.map((s) => ({ id: s, label: SUIT_CN[s] })),
					true,
				);
				if (!choice) return;
				suit = choice as Suit;
			}
			const pool = self.hand.filter((id) => g.card(id).suit === suit);
			const picked = await g.askCards(
				self.id,
				`乱击：选择两张${SUIT_CN[suit]}手牌当【万箭齐发】使用`,
				pool.map((id) => ({ id })),
				2,
				2,
				true,
			);
			if (picked.length < 2) return;
			const targets = luanjiTargets(g, self);
			if (targets.length === 0) return;
			await g.useCard(self.id, { name: 'wanjianqifa', cards: picked, viaSkill: 'luanji' }, targets);
		},
	},
};

const xueyi: SkillDef = {
	id: 'xueyi',
	cn: '血裔',
	desc: '主公技，锁定技，场上每有一名其他群雄角色存活，你的手牌上限便+2。',
	tags: ['lord', 'locked'],
	mods: {
		handLimit(g, self, base) {
			const others = g.alivePlayers().filter((p) => p.id !== self.id && p.faction === 'qun').length;
			return base + 2 * others;
		},
	},
};

// ─────────────────────────── 庞德（火包） ───────────────────────────

/** 火杀 / 雷杀的牌名都以 sha 结尾，鞬出对它们同样生效 */
function isSha(name: string): boolean {
	return name === 'sha' || name.endsWith('sha');
}

const jianchu: SkillDef = {
	id: 'jianchu',
	cn: '鞬出',
	desc: '当你使用【杀】指定一名角色为目标后，你可以弃置其一张牌：若为装备牌，此【杀】不可被【闪】响应；若不为装备牌，该角色获得此【杀】。',
	triggers: [
		{
			timing: 'onTargetChosen',
			can(g, self, ev: UseEvent) {
				if (ev.source !== self.id || !isSha(ev.use.name)) return false;
				return ev.targets.some((t) => {
					const p = g.player(t);
					return p.alive && p.hand.length + Object.keys(p.equip).length > 0;
				});
			},
			async run(g, self, ev: UseEvent) {
				for (const t of ev.targets) {
					const tp = g.player(t);
					if (!tp.alive) continue;
					const pool = [
						// 手牌背面选：不能让发动者看见点数花色再挑（同反馈）
						...tp.hand.map((id) => ({ id, unknown: true, from: tp.id, zone: 'hand' })),
						...Object.values(tp.equip)
							.filter((x): x is number => typeof x === 'number')
							.map((id) => ({ id, from: tp.id, zone: 'equip' })),
					];
					if (pool.length === 0) continue;
					const picked = await g.askCards(self.id, `鞬出：弃置 ${tp.nickname} 的一张牌`, pool, 1, 1, true);
					if (picked.length === 0) continue;
					const isEquip = g.cardDef(g.card(picked[0]).name).type === 'equip';
					await g.discardCards(picked, 'jianchu', self.id);
					if (isEquip) {
						ev.unavoidableFor = ev.unavoidableFor ?? [];
						if (!ev.unavoidableFor.includes(t)) ev.unavoidableFor.push(t);
						continue;
					}
					// 这张【杀】此刻在处理区，交出去只能走 moveCards（gainCards）；
					// 给出去之后 finishUse 就不会再把它丢进弃牌堆了
					const left = ev.use.cards.filter((id) => g.locate(id).zone === 'processing');
					if (left.length) await g.gainCards(t, left, 'jianchu', self.id);
				}
			},
		},
	],
};

export const QUN_SKILLS: Record<string, SkillDef> = {
	qingnang,
	jijiu,
	wushuang,
	lijian,
	biyue,
	releiji,
	guidao,
	shuangxiong,
	luanji,
	xueyi,
	jianchu,
};
