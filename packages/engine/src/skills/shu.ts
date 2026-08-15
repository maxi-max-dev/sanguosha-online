/**
 * 蜀势力技能：刘备 / 关羽 / 张飞 / 诸葛亮 / 赵云 / 马超 / 黄月英（标准包）；
 * 黄忠 / 魏延 / 庞统 / 卧龙诸葛亮（风 / 火扩充包，见 generals.ts 的 pack 字段）。
 */

import type { SkillDef } from '../defs.js';
import type { AskForCardEvent, Game } from '../game.js';
import { markLimit } from '../options.js';
import {
	suitColor,
	type DamageEvent,
	type DyingEvent,
	type PhaseEvent,
	type PlayerState,
	type UseEvent,
} from '../types.js';

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

// ─────────────────────────── 黄忠（风包） ───────────────────────────

/** 杀系牌名（杀/火杀/雷杀）。烈弓只关心"这是不是一张杀"，不关心属性 */
function isShaName(name: string | undefined): boolean {
	return name === 'sha' || name === 'huosha' || name === 'leisha';
}

/**
 * 一次使用的指纹。烈弓的"伤害+1"要绑在**发动时的那一次使用**上，不能顺延到
 * 本回合后面的第二张【杀】（诸葛连弩/奇谋在场时这是真会发生的），而 DamageEvent
 * 里能拿到的只有 CardUse —— 它的实体牌 id 就是最稳的区分依据。
 */
function useKey(cards: number[] | undefined): string {
	return cards && cards.length > 0 ? cards.join('-') : 'v';
}

const LIEGONG_DMG = 'turn:liegongDmg';

/**
 * 烈弓①：手牌里每张【杀】能额外够到哪些角色。
 * 只列"攻击范围外、但距离不大于点数"的人 —— 范围内的目标用正常出牌选项打就行，
 * 不必在菜单里重复一份。
 */
function liegongShots(g: Game, self: PlayerState): Array<{ id: number; targets: string[] }> {
	if (g.getFlag(self.id, 'turn:shaUsed') >= g.shaLimit(self.id)) return [];
	const out: Array<{ id: number; targets: string[] }> = [];
	for (const id of self.hand) {
		const c = g.card(id);
		if (!isShaName(c.name)) continue;
		const fakeEv: UseEvent = {
			source: self.id,
			use: { name: c.name, cards: [id], viaSkill: 'xinliegong' },
			targets: [],
		};
		const targets = g
			.alivePlayers()
			.filter(
				(p) =>
					p.id !== self.id &&
					!g.inAttackRange(self.id, p.id) &&
					g.distance(self.id, p.id) <= c.number &&
					g.canBeTargeted(self.id, p.id, fakeEv),
			)
			.map((p) => p.id);
		if (targets.length > 0) out.push({ id, targets });
	}
	return out;
}

const xinliegong: SkillDef = {
	id: 'xinliegong',
	cn: '烈弓',
	desc: '①你使用【杀】可以选择你距离不大于此【杀】点数的角色为目标。②当你使用【杀】指定一个目标后，你可以根据下列条件执行相应效果：其手牌数不大于你的手牌数，此【杀】不可被响应；其体力值不小于你的体力值，此【杀】伤害+1。',
	// ①放宽的是目标合法性，而 options.ts 的 targetsFor 把距离判断写死成 inAttackRange，
	// ModSpec 里也没有"按这张牌的点数放宽射程"的钩子。不动引擎就只能换个入口：
	// 做成出牌阶段的主动技，由技能自己算目标再走正常的 useCard —— 结算路径与普通【杀】完全一致
	active: {
		can(g, self) {
			return liegongShots(g, self).length > 0;
		},
		async run(g, self) {
			const shots = liegongShots(g, self);
			if (shots.length === 0) return;
			const picked = await g.askCards(
				self.id,
				'烈弓：选择一张【杀】，可指定距离不大于其点数的角色',
				shots.map((s) => ({ id: s.id })),
				1,
				1,
				true,
			);
			const shot = shots.find((s) => s.id === picked[0]);
			if (!shot) return;
			const targets = await g.askPlayers(self.id, '烈弓：选择攻击范围外的一名角色', shot.targets, 1, 1, true);
			if (targets.length === 0) return;
			const c = g.card(shot.id);
			await g.useCard(
				self.id,
				{ name: c.name, nature: g.cardDef(c.name).nature, cards: [shot.id], viaSkill: 'xinliegong' },
				targets,
			);
		},
	},
	triggers: [
		{
			timing: 'onTargetChosen',
			can(g, self, ev: UseEvent) {
				if (ev.source !== self.id || !isShaName(ev.use.name)) return false;
				return ev.targets.some((t) => {
					const tp = g.player(t);
					return tp.alive && (tp.hand.length <= self.hand.length || tp.hp >= self.hp);
				});
			},
			async run(g, self, ev: UseEvent) {
				ev.unavoidableFor = ev.unavoidableFor ?? [];
				const boosted: string[] = [];
				let asked = false;
				for (const t of ev.targets) {
					const tp = g.player(t);
					if (!tp.alive) continue;
					const silent = tp.hand.length <= self.hand.length;
					const heavier = tp.hp >= self.hp;
					if (!silent && !heavier) continue;
					// 一张【杀】可能有多个目标：第一个由 trigger() 外层问过了，之后逐个再问
					if (asked && !(await g.askConfirm(self.id, 'xinliegong', `是否对 ${tp.nickname} 发动【烈弓】？`))) continue;
					asked = true;
					if (silent && !ev.unavoidableFor.includes(t)) ev.unavoidableFor.push(t);
					if (heavier) boosted.push(t);
				}
				if (boosted.length > 0) g.setFlag(self.id, LIEGONG_DMG, `${useKey(ev.use.cards)}#${boosted.join(',')}`);
			},
		},
	],
	mods: {
		damageBonus(g, self, ev) {
			if (!isShaName(ev.card?.name)) return 0;
			const raw = self.flags[LIEGONG_DMG];
			if (typeof raw !== 'string') return 0;
			const [key, list] = raw.split('#');
			if (key !== useKey(ev.card?.cards)) return 0;
			return list.split(',').includes(ev.target) ? 1 : 0;
		},
	},
};

// ─────────────────────────── 魏延（风包） ───────────────────────────

const xinkuanggu: SkillDef = {
	id: 'xinkuanggu',
	cn: '狂骨',
	desc: '当你造成 1 点伤害后，若你与受伤角色的距离不大于 1，你可以回复 1 点体力或摸一张牌。',
	triggers: [
		{
			// 用 afterDamage 而不是 afterDamaged：狂骨看的是"你造成伤害"，是来源侧的时机。
			// 此时目标即使已被打到 0 点也还没进濒死结算，仍在存活列表里，距离算得出来
			timing: 'afterDamage',
			can(g, self, ev: DamageEvent) {
				return ev.source === self.id && ev.amount > 0 && g.distance(self.id, ev.target) <= 1;
			},
			async run(g, self, ev: DamageEvent) {
				for (let i = 0; i < ev.amount; i++) {
					// 伤害 N 点触发 N 次：第一次外层已经问过了，之后每次自己再问一遍
					if (i > 0 && !(await g.askConfirm(self.id, 'xinkuanggu', '是否再次发动【狂骨】？'))) break;
					const choice =
						self.hp < self.maxHp
							? await g.askOption(self.id, '狂骨：请选择', [
									{ id: 'recover', label: '回复 1 点体力' },
									{ id: 'draw', label: '摸一张牌' },
								])
							: 'draw';
					if (choice === 'recover') await g.recover({ source: self.id, target: self.id, amount: 1 });
					else await g.drawCards(self.id, 1, 'xinkuanggu');
				}
			},
		},
	],
};

const qimou: SkillDef = {
	id: 'qimou',
	cn: '奇谋',
	desc: '限定技，出牌阶段，你可以失去任意点体力，然后直到回合结束，你计算与其他角色的距离 -X，且你可以多使用 X 张【杀】（X 为你失去的体力值）。',
	tags: ['limit'],
	active: {
		limit: 'game',
		can(g, self) {
			return self.hp > 0;
		},
		async run(g, self) {
			const options = [];
			for (let i = 1; i <= self.hp; i++) options.push({ id: String(i), label: `失去 ${i} 点体力` });
			const choice = await g.askOption(self.id, '奇谋：选择失去的体力点数', options, true);
			const x = Number(choice);
			if (!Number.isFinite(x) || x < 1) return;
			// 先记限定技再掉血：失去体力可能直接把自己打进濒死，那时技能已经被清空了
			markLimit(g, self, 'qimou', 'game');
			g.setFlag(self.id, 'turn:qimou', x);
			await g.loseHp(self.id, x, 'qimou');
		},
	},
	mods: {
		distanceFrom(g, self) {
			return -g.getFlag(self.id, 'turn:qimou');
		},
		shaLimit(g, self, base) {
			return base + g.getFlag(self.id, 'turn:qimou');
		},
	},
};

// ─────────────────────────── 庞统（火包） ───────────────────────────

const lianhuan: SkillDef = {
	id: 'lianhuan',
	cn: '连环',
	desc: '你可以将一张♣手牌当【铁索连环】使用或重铸。',
	// 没写成 convert：重铸是 options.ts 里另一条只认实体牌的枚举通道，转化技进不去；
	// 而同一个技能不能既有 convert 又有 active（playPhase 会把带 viaSkill 的选项
	// 一律派给 active.run）。做成主动技是唯一能同时给出"使用"和"重铸"两种用法的写法
	active: {
		can(g, self) {
			return self.hand.some((id) => g.card(id).suit === 'club');
		},
		async run(g, self) {
			const clubs = self.hand.filter((id) => g.card(id).suit === 'club');
			if (clubs.length === 0) return;
			const picked = await g.askCards(
				self.id,
				'连环：选择一张♣手牌',
				clubs.map((id) => ({ id })),
				1,
				1,
				true,
			);
			if (picked.length === 0) return;
			const use = { name: 'tiesuolianhuan', cards: picked, viaSkill: 'lianhuan' };
			const fakeEv: UseEvent = { source: self.id, use, targets: [] };
			const candidates = g
				.alivePlayers()
				.filter((p) => g.canBeTargeted(self.id, p.id, fakeEv))
				.map((p) => p.id);

			const choice =
				candidates.length > 0
					? await g.askOption(
							self.id,
							'连环：请选择',
							[
								{ id: 'use', label: '当【铁索连环】使用' },
								{ id: 'recast', label: '重铸（弃置并摸一张牌）' },
							],
							true,
						)
					: 'recast';

			if (choice === 'use') {
				const targets = await g.askPlayers(
					self.id,
					'连环：选择一至两名角色',
					candidates,
					1,
					Math.min(2, candidates.length),
					true,
				);
				if (targets.length > 0) await g.useCard(self.id, use, targets);
				return;
			}
			if (choice !== 'recast') return;
			g.pushLog({ kind: 'recast', who: self.id, name: 'tiesuolianhuan', cards: picked });
			await g.discardCards(picked, 'recast', self.id);
			await g.drawCards(self.id, 1, 'recast');
		},
	},
};

const oldniepan: SkillDef = {
	id: 'oldniepan',
	cn: '涅槃',
	desc: '限定技，当你处于濒死状态时，你可以弃置你区域内的所有牌并复原你的武将牌，然后摸三张牌并将体力回复至 3 点。',
	tags: ['limit'],
	triggers: [
		{
			timing: 'onDying',
			can(g, self, ev: DyingEvent) {
				return ev.who === self.id && g.getFlag(self.id, 'game:oldniepan') < 1;
			},
			async run(g, self) {
				g.addFlag(self.id, 'game:oldniepan', 1);
				const all = [
					...self.hand,
					...Object.values(self.equip).filter((x): x is number => typeof x === 'number'),
					...self.judge,
				];
				if (all.length > 0) await g.discardCards(all, 'oldniepan', self.id);
				// "复原武将牌" = 翻回正面 + 解除横置，两样都要
				self.turnedOver = false;
				self.chained = false;
				await g.drawCards(self.id, 3, 'oldniepan');
				if (self.hp < 3) await g.recover({ source: self.id, target: self.id, amount: 3 - self.hp });
			},
		},
	],
};

// ─────────────────────────── 卧龙诸葛亮（火包） ───────────────────────────

const bazhen: SkillDef = {
	id: 'bazhen',
	cn: '八阵',
	desc: '锁定技，若你的防具栏内没有牌，则你视为装备着【八卦阵】。',
	// 不打 locked：锁定的是"视为装备着八卦阵"这件事，而八卦阵本身是"你可以进行判定"，
	// 判定与否仍归玩家。写法与 equip.ts 的 bagua 保持一致，只多一条"防具栏为空"
	triggers: [
		{
			timing: 'beforeAskForCard',
			can(g, self, ev: AskForCardEvent) {
				return ev.who === self.id && ev.need === 'shan' && !ev.use && self.equip.armor === undefined;
			},
			async run(g, self, ev: AskForCardEvent) {
				const judgeEv = await g.judge(self.id, 'bazhen', (card) => suitColor(card.suit) === 'red');
				if (judgeEv.result) ev.use = { name: 'shan', cards: [], viaSkill: 'bazhen' };
			},
		},
	],
};

const huoji: SkillDef = {
	id: 'huoji',
	cn: '火计',
	desc: '你可以将一张红色手牌当【火攻】使用。',
	convert: {
		to: ['huogong'],
		usage: ['use'],
		filter(g, self, card) {
			return suitColor(card.suit) === 'red';
		},
	},
};

const kanpo: SkillDef = {
	id: 'kanpo',
	cn: '看破',
	desc: '你可以将你的任意一张黑色手牌当【无懈可击】使用。',
	convert: {
		// to 必须写牌名全称：respond() 和 convertOptions() 都拿它和引擎问的 need
		// 直接比对。这个技能一度做不出来，正是因为引擎那边问的是简称 'wuxie'
		// （见 game.ts 里那处修复和 test/wuxie.test.ts）
		to: ['wuxiekeji'],
		// 【无懈可击】只在别人使用锦囊时被动打出，没有"出牌阶段主动用"这一说
		usage: ['respond'],
		filter(g, self, card) {
			return suitColor(card.suit) === 'black';
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
	xinliegong,
	xinkuanggu,
	qimou,
	lianhuan,
	oldniepan,
	bazhen,
	huoji,
	kanpo,
};
