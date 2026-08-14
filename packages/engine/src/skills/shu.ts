/**
 * 蜀势力技能：刘备 / 关羽 / 张飞 / 诸葛亮 / 赵云 / 马超 / 黄月英。
 */

import type { SkillDef } from '../defs.js';
import type { AskForCardEvent, Game } from '../game.js';
import { suitColor, type PhaseEvent, type UseEvent } from '../types.js';

// ─────────────────────────── 刘备 ───────────────────────────

const rende: SkillDef = {
	id: 'rende',
	cn: '仁德',
	desc: '出牌阶段，你可以将任意张手牌交给一名其他角色。若你本回合内以此法给出的牌达到两张，你回复 1 点体力（每回合限一次）。',
	active: {
		// 不设 limit：仁德本身可以反复发动，真正限一次的是"给够两张回体力"这个附加效果
		can(g, self) {
			return self.hand.length > 0 && g.othersFrom(self.id).length > 0;
		},
		async run(g, self) {
			const targets = await g.askPlayers(
				self.id,
				'仁德：选择一名角色',
				g.othersFrom(self.id).map((p) => p.id),
				1,
				1,
				true,
			);
			if (targets.length === 0) return;
			const cards = await g.askCards(
				self.id,
				'仁德：选择要交给对方的手牌',
				self.hand.map((id) => ({ id })),
				1,
				self.hand.length,
				true,
			);
			if (cards.length === 0) return;
			await g.gainCards(targets[0], cards, 'rende', self.id);
			const given = g.addFlag(self.id, 'turn:rendeGiven', cards.length);
			if (given >= 2 && g.getFlag(self.id, 'turn:rendeHeal') < 1) {
				g.addFlag(self.id, 'turn:rendeHeal', 1);
				await g.recover({ source: self.id, target: self.id, amount: 1 });
			}
		},
	},
};

const jijiang: SkillDef = {
	id: 'jijiang',
	cn: '激将',
	desc: '你需要使用或打出【杀】时，可令一名其他蜀势力角色代替你打出。',
	tags: ['lord'],
	triggers: [
		{
			timing: 'beforeAskForCard',
			can(g, self, ev: AskForCardEvent) {
				return ev.who === self.id && ev.need === 'sha' && !ev.use;
			},
			async run(g, self, ev: AskForCardEvent) {
				for (const p of g.othersFrom(self.id)) {
					if (p.faction !== 'shu') continue;
					const use = await g.askForCard(
						p.id,
						'sha',
						`激将：是否代 ${self.nickname} 打出一张【杀】？`,
						ev.trigger,
					);
					if (use) {
						ev.use = use;
						return;
					}
				}
			},
		},
	],
};

// ─────────────────────────── 关羽 ───────────────────────────

const wusheng: SkillDef = {
	id: 'wusheng',
	cn: '武圣',
	desc: '你可以将一张红色牌当【杀】使用或打出。',
	convert: {
		to: ['sha'],
		usage: ['use', 'respond'],
		from: ['hand', 'equip'],
		filter(g, self, card) {
			return suitColor(card.suit) === 'red';
		},
	},
};

// ─────────────────────────── 张飞 ───────────────────────────

const paoxiao: SkillDef = {
	id: 'paoxiao',
	cn: '咆哮',
	desc: '锁定技，你使用【杀】没有次数限制。',
	tags: ['locked'],
	mods: {
		shaLimit() {
			return Infinity;
		},
	},
};

// ─────────────────────────── 诸葛亮 ───────────────────────────

const guanxing: SkillDef = {
	id: 'guanxing',
	cn: '观星',
	desc: '回合开始阶段，你可以观看牌堆顶的 X 张牌（X 为存活角色数，至多 5），然后以任意顺序放回牌堆顶或牌堆底。',
	triggers: [
		{
			timing: 'phaseStart',
			can(g, self, ev: PhaseEvent) {
				return ev.who === self.id && ev.phase === 'start';
			},
			async run(g, self) {
				const n = Math.min(5, g.alivePlayers().length);
				const peeked = g.peekPile(n);
				if (peeked.length === 0) return;
				const r = await g.ask({
					kind: 'arrange',
					who: self.id,
					prompt: '观星：将这些牌排列后放回牌堆顶或牌堆底',
					cards: peeked,
					topLabel: '牌堆顶',
					bottomLabel: '牌堆底',
					maxTop: peeked.length,
					cancelable: false,
					timeout: 30,
				});
				let topPile: number[] = [];
				let bottomPile: number[] = [];
				if (r.type === 'arrange') {
					// 服务端是规则的最终裁决者：客户端给的排列要按 peeked 校验，
					// 漏掉的牌兜底塞回牌堆底，绝不能凭空丢牌或多出牌
					const seen = new Set<number>();
					for (const id of r.top) {
						if (peeked.includes(id) && !seen.has(id)) {
							topPile.push(id);
							seen.add(id);
						}
					}
					for (const id of r.bottom) {
						if (peeked.includes(id) && !seen.has(id)) {
							bottomPile.push(id);
							seen.add(id);
						}
					}
					for (const id of peeked) if (!seen.has(id)) bottomPile.push(id);
				} else {
					topPile = peeked;
				}
				// 这些牌本来就在牌堆顶，只是重排顺序，没有换区域，不走 moveCards
				const rest = g.state.drawPile.filter((id) => !peeked.includes(id));
				g.state.drawPile = [...topPile, ...rest, ...bottomPile];
				g.pushLog({ kind: 'guanxing', who: self.id, top: topPile, bottom: bottomPile });
			},
		},
	],
};

const kongcheng: SkillDef = {
	id: 'kongcheng',
	cn: '空城',
	desc: '锁定技，若你没有手牌，你不能成为【杀】或【决斗】的目标。',
	tags: ['locked'],
	mods: {
		targetable(g, self, use) {
			if (self.hand.length > 0) return true;
			return !['sha', 'huosha', 'leisha', 'juedou'].includes(use.use.name);
		},
	},
};

// ─────────────────────────── 赵云 ───────────────────────────

const longdan: SkillDef = {
	id: 'longdan',
	cn: '龙胆',
	desc: '你可以将一张【杀】当【闪】，或将一张【闪】当【杀】使用或打出。',
	convert: {
		// filter 拿不到"目标要转成什么"，没法在这里排除"杀转杀/闪转闪"的无意义项，
		// 这类去重交给 options.ts 统一处理（见交付报告）
		to: ['sha', 'shan'],
		usage: ['use', 'respond'],
		filter(g, self, card) {
			return card.name === 'sha' || card.name === 'shan';
		},
	},
};

// ─────────────────────────── 马超 ───────────────────────────

const mashu: SkillDef = {
	id: 'mashu',
	cn: '马术',
	desc: '锁定技，你计算与其他角色的距离-1。',
	tags: ['locked'],
	mods: {
		distanceFrom() {
			return -1;
		},
	},
};

const tieji: SkillDef = {
	id: 'tieji',
	cn: '铁骑',
	desc: '你使用【杀】指定目标后，你可以对该目标进行判定：若结果为红色，此目标不能使用【闪】响应这张【杀】。',
	triggers: [
		{
			timing: 'onTargetChosen',
			can(g, self, ev: UseEvent) {
				return ev.source === self.id && ev.use.name === 'sha' && ev.targets.some((t) => g.player(t).alive);
			},
			async run(g, self, ev: UseEvent) {
				ev.unavoidableFor = ev.unavoidableFor ?? [];
				// 一次杀可能有多个目标：逐个判定，第一个由引擎的 trigger() 已经问过了
				for (let i = 0; i < ev.targets.length; i++) {
					const t = ev.targets[i];
					if (!g.player(t).alive) continue;
					if (i > 0) {
						const again = await g.askConfirm(self.id, 'tieji', `是否对 ${g.player(t).nickname} 再次发动【铁骑】？`);
						if (!again) continue;
					}
					const judgeEv = await g.judge(t, 'tieji', (c) => suitColor(c.suit) === 'red');
					if (judgeEv.result) ev.unavoidableFor.push(t);
				}
			},
		},
	],
};

// ─────────────────────────── 黄月英 ───────────────────────────

const jizhi: SkillDef = {
	id: 'jizhi',
	cn: '集智',
	desc: '锁定技，你使用普通锦囊牌后，摸一张牌。',
	// 描述里没有"可以"字样（区别于本文件里其余触发技），按锁定技处理：
	// 无条件摸牌，不需要每次都弹"是否发动"确认框
	tags: ['locked'],
	triggers: [
		{
			timing: 'onUse',
			can(g, self, ev: UseEvent) {
				if (ev.source !== self.id) return false;
				const def = g.cardDef(ev.use.name);
				return def.type === 'trick' && def.subtype !== 'delayed';
			},
			async run(g, self) {
				await g.drawCards(self.id, 1, 'jizhi');
			},
		},
	],
};

const qicai: SkillDef = {
	id: 'qicai',
	cn: '奇才',
	desc: '锁定技，你使用锦囊牌无距离限制。',
	tags: ['locked'],
	mods: {
		ignoreDistance(g, self, cardName) {
			return g.cardDef(cardName).type === 'trick';
		},
	},
};

export const SHU_SKILLS: Record<string, SkillDef> = {
	rende,
	jijiang,
	wusheng,
	paoxiao,
	guanxing,
	kongcheng,
	longdan,
	mashu,
	tieji,
	jizhi,
	qicai,
};
