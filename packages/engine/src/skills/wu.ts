/**
 * 吴势力技能：孙权 / 甘宁 / 吕蒙 / 黄盖 / 周瑜 / 大乔 / 陆逊 / 孙尚香。
 */

import type { SkillDef } from '../defs.js';
import { markLimit } from '../options.js';
import {
	suitColor,
	type CardMoveEvent,
	type CardUse,
	type DrawNumEvent,
	type PhaseEvent,
	type UseEvent,
} from '../types.js';

// ─────────────────────────── 孙权 ───────────────────────────

const zhiheng: SkillDef = {
	id: 'zhiheng',
	cn: '制衡',
	desc: '出牌阶段限一次，你可以弃置任意张牌，然后摸等量的牌。',
	active: {
		limit: 'turn',
		can(g, self) {
			return self.hand.length + Object.keys(self.equip).length > 0;
		},
		async run(g, self) {
			const pool = [
				...self.hand.map((id) => ({ id })),
				...Object.values(self.equip)
					.filter((x): x is number => typeof x === 'number')
					.map((id) => ({ id })),
			];
			const chosen = await g.askCards(self.id, '制衡：弃置任意张牌，然后摸等量的牌', pool, 1, pool.length, true);
			if (chosen.length === 0) return; // 中途放弃：不占用本回合的发动次数
			markLimit(g, self, 'zhiheng', 'turn');
			await g.discardCards(chosen, 'zhiheng', self.id);
			await g.drawCards(self.id, chosen.length, 'zhiheng');
		},
	},
};

const jiuyuan: SkillDef = {
	id: 'jiuyuan',
	cn: '救援',
	desc: '锁定技，其他吴势力角色对你使用【桃】时，你回复的体力+1。',
	tags: ['lord', 'locked'],
	triggers: [
		{
			timing: 'beforeRecover',
			can(g, self, ev: { source?: string; target: string; amount: number; card?: CardUse }) {
				return (
					ev.target === self.id &&
					ev.card?.name === 'tao' &&
					!!ev.source &&
					ev.source !== self.id &&
					g.player(ev.source).faction === 'wu'
				);
			},
			async run(g, self, ev: { amount: number }) {
				ev.amount += 1;
			},
		},
	],
};

// ─────────────────────────── 甘宁 ───────────────────────────

const qixi: SkillDef = {
	id: 'qixi',
	cn: '奇袭',
	desc: '你可以将一张黑色牌当【过河拆桥】使用。',
	convert: {
		to: ['guohechaiqiao'],
		usage: ['use'],
		filter(g, self, card) {
			return suitColor(card.suit) === 'black';
		},
	},
};

// ─────────────────────────── 吕蒙 ───────────────────────────

const keji: SkillDef = {
	id: 'keji',
	cn: '克己',
	desc: '若你于出牌阶段未使用或打出过【杀】，你可以跳过弃牌阶段。',
	// 整个技能设为锁定技：内部挂了一个只做记账、不该弹确认框的 onRespond 钩子——
	// tags 是整技能生效的，没法只锁其中一个 trigger；若做成非锁定，"发动确认"本身
	// 就会变成一个可被理性玩家用来避开记账的漏洞（拒绝确认 = 记账不生效）
	tags: ['locked'],
	triggers: [
		{
			// cards 那边的 turn:shaUsed 只统计"使用"，这里补上"打出"（响应模式）的杀
			timing: 'onRespond',
			can(g, self, ev: { who: string; use: CardUse }) {
				return ev.who === self.id && (ev.use.name === 'sha' || ev.use.name.endsWith('sha'));
			},
			async run(g, self) {
				g.setFlag(self.id, 'turn:shaResponded', 1);
			},
		},
		{
			timing: 'phaseStart',
			can(g, self, ev: PhaseEvent) {
				if (ev.who !== self.id || ev.phase !== 'discard') return false;
				return g.getFlag(self.id, 'turn:shaUsed') === 0 && g.getFlag(self.id, 'turn:shaResponded') === 0;
			},
			async run(g, self, ev: PhaseEvent) {
				ev.skipped = true;
			},
		},
	],
};

// ─────────────────────────── 黄盖 ───────────────────────────

const kurou: SkillDef = {
	id: 'kurou',
	cn: '苦肉',
	desc: '你可以失去 1 点体力，然后摸两张牌。',
	active: {
		can() {
			return true;
		},
		async run(g, self) {
			await g.loseHp(self.id, 1, 'kurou');
			if (!self.alive) return; // 濒死未获救而死，不再摸牌
			await g.drawCards(self.id, 2, 'kurou');
		},
	},
};

// ─────────────────────────── 周瑜 ───────────────────────────

const yingzi: SkillDef = {
	id: 'yingzi',
	cn: '英姿',
	desc: '锁定技，摸牌阶段，你多摸一张牌。',
	tags: ['locked'],
	triggers: [
		{
			timing: 'drawPhaseNum',
			can(g, self, ev: DrawNumEvent) {
				return ev.who === self.id;
			},
			async run(g, self, ev: DrawNumEvent) {
				ev.num += 1;
			},
		},
	],
};

const fanjian: SkillDef = {
	id: 'fanjian',
	cn: '反间',
	desc: '出牌阶段限一次，你可以令一名其他角色选择一种花色，然后获得你的一张手牌并展示。若该花色和牌的花色不同，你对其造成 1 点伤害。',
	active: {
		limit: 'turn',
		can(g, self) {
			return self.hand.length > 0 && g.othersFrom(self.id).length > 0;
		},
		async run(g, self) {
			const targets = await g.askPlayers(
				self.id,
				'反间：选择一名其他角色',
				g.othersFrom(self.id).map((p) => p.id),
				1,
				1,
				true,
			);
			if (targets.length === 0) return;
			const cards = await g.askCards(
				self.id,
				'反间：选择交给对方的一张手牌',
				self.hand.map((id) => ({ id })),
				1,
				1,
				true,
			);
			if (cards.length === 0) return;
			markLimit(g, self, 'fanjian', 'turn');
			const target = targets[0];
			const card = g.card(cards[0]);
			const suit = await g.askSuit(target, '反间：请选择一种花色');
			await g.gainCards(target, cards, 'fanjian', self.id);
			if (suit !== card.suit) {
				await g.damage({ source: self.id, target, amount: 1, nature: undefined });
			}
		},
	},
};

// ─────────────────────────── 大乔 ───────────────────────────

const guose: SkillDef = {
	id: 'guose',
	cn: '国色',
	desc: '你可以将一张方块牌当【乐不思蜀】使用。',
	convert: {
		to: ['lebusishu'],
		usage: ['use'],
		filter(g, self, card) {
			return card.suit === 'diamond';
		},
	},
};

const liuli: SkillDef = {
	id: 'liuli',
	cn: '流离',
	desc: '当你成为【杀】的目标时，你可以弃置一张牌，将此【杀】转移给你攻击范围内的一名其他角色。',
	triggers: [
		{
			timing: 'onBecomeTarget',
			can(g, self, ev: UseEvent) {
				if (ev.use.name !== 'sha' || ev.currentTarget !== self.id) return false;
				if (self.hand.length + Object.keys(self.equip).length === 0) return false;
				return g.othersFrom(self.id).some((p) => p.id !== ev.source && g.inAttackRange(self.id, p.id));
			},
			async run(g, self, ev: UseEvent) {
				const pool = [
					...self.hand.map((id) => ({ id })),
					...Object.values(self.equip)
						.filter((x): x is number => typeof x === 'number')
						.map((id) => ({ id })),
				];
				const discard = await g.askCards(
					self.id,
					'流离：弃置一张牌，将此【杀】转移给攻击范围内的另一名角色',
					pool,
					1,
					1,
					true,
				);
				if (discard.length === 0) return;
				const candidates = g
					.othersFrom(self.id)
					.filter((p) => p.id !== ev.source && g.inAttackRange(self.id, p.id))
					.map((p) => p.id);
				const newTarget = await g.askPlayers(self.id, '流离：选择转移的新目标', candidates, 1, 1, true);
				if (newTarget.length === 0) return;
				await g.discardCards(discard, 'liuli', self.id);
				ev.cancelledFor!.push(self.id);
				// useCard() 对 ev.targets 用 for...of 迭代：结算中途 push 进去的新目标
				// 会被同一个循环继续访问到，这张【杀】就会在本次使用里对新目标结算
				ev.targets.push(newTarget[0]);
			},
		},
	],
};

// ─────────────────────────── 陆逊 ───────────────────────────

const qianxun: SkillDef = {
	id: 'qianxun',
	cn: '谦逊',
	desc: '锁定技，你不能成为【顺手牵羊】或【乐不思蜀】的目标。',
	tags: ['locked'],
	mods: {
		targetable(g, self, use) {
			return !['shunshouqianyang', 'lebusishu'].includes(use.use.name);
		},
	},
};

const lianying: SkillDef = {
	id: 'lianying',
	cn: '连营',
	desc: '锁定技，当你失去最后的手牌后，你摸一张牌。',
	tags: ['locked'],
	triggers: [
		{
			timing: 'afterLoseCards',
			can(g, self, ev: CardMoveEvent) {
				return ev.from.owner === self.id && ev.from.zone === 'hand' && self.hand.length === 0;
			},
			async run(g, self) {
				await g.drawCards(self.id, 1, 'lianying');
			},
		},
	],
};

// ─────────────────────────── 孙尚香 ───────────────────────────

const xiaoji: SkillDef = {
	id: 'xiaoji',
	cn: '枭姬',
	desc: '锁定技，当你失去装备区的牌后，你摸两张牌；失去几张就摸几次。',
	tags: ['locked'],
	triggers: [
		{
			timing: 'afterLoseCards',
			can(g, self, ev: CardMoveEvent) {
				return ev.from.owner === self.id && ev.from.zone === 'equip';
			},
			async run(g, self, ev: CardMoveEvent) {
				for (let i = 0; i < ev.cards.length; i++) {
					await g.drawCards(self.id, 2, 'xiaoji');
				}
			},
		},
	],
};

const jieyin: SkillDef = {
	id: 'jieyin',
	cn: '结姻',
	desc: '出牌阶段限一次，你可以弃置两张手牌，然后令一名已受伤的男性角色回复 1 点体力，你也回复 1 点体力。',
	active: {
		limit: 'turn',
		can(g, self) {
			if (self.hand.length < 2) return false;
			return g.alivePlayers().some((p) => p.gender === 'male' && p.hp < p.maxHp);
		},
		async run(g, self) {
			const candidates = g
				.alivePlayers()
				.filter((p) => p.gender === 'male' && p.hp < p.maxHp)
				.map((p) => p.id);
			const targets = await g.askPlayers(self.id, '结姻：选择一名已受伤的男性角色', candidates, 1, 1, true);
			if (targets.length === 0) return;
			const cards = await g.askCards(self.id, '结姻：弃置两张手牌', self.hand.map((id) => ({ id })), 2, 2, true);
			if (cards.length < 2) return;
			markLimit(g, self, 'jieyin', 'turn');
			await g.discardCards(cards, 'jieyin', self.id);
			await g.recover({ source: self.id, target: targets[0], amount: 1 });
			await g.recover({ source: self.id, target: self.id, amount: 1 });
		},
	},
};

export const WU_SKILLS: Record<string, SkillDef> = {
	zhiheng,
	jiuyuan,
	qixi,
	keji,
	kurou,
	yingzi,
	fanjian,
	guose,
	liuli,
	qianxun,
	lianying,
	xiaoji,
	jieyin,
};
