/**
 * 群雄势力技能：华佗 / 吕布 / 貂蝉。
 */

import type { SkillDef } from '../defs.js';
import { markLimit } from '../options.js';
import { suitColor, type PhaseEvent } from '../types.js';

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

export const QUN_SKILLS: Record<string, SkillDef> = {
	qingnang,
	jijiu,
	wushuang,
	lijian,
	biyue,
};
