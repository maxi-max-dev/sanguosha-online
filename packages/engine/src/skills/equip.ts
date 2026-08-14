/**
 * 装备牌附带的技能。每张装备牌的 CardDef.equipSkill 指向这里的一个 id，
 * equipCard() 会在穿上/脱下装备时自动把技能加进/摘出 p.skills，我们只用管技能本身怎么写。
 *
 * 坐骑（+1马/-1马）不出现在这里：距离修正是 game.ts 的 distance() 直接读
 * p.equip.horsePlus/horseMinus 算出来的，不需要技能。
 */
import type { AskForCardEvent, Game } from '../game.js';
import { shaDodgedTargets } from '../cards/basic.js';
import { allCardsOf, hasAnyCards } from '../cards/util.js';
import type { SkillDef } from '../defs.js';
import { suitColor, type CardMoveEvent, type DamageEvent, type PhaseEvent, type UseEvent } from '../types.js';

/** 是否是"杀"这一系（杀/火杀/雷杀），供只关心"这是不是一张杀"而不关心属性的技能判断用 */
function isShaName(name: string | undefined): boolean {
	return name === 'sha' || name === 'huosha' || name === 'leisha';
}

/** 攻击者是否装备了青釭剑（防具免疫类技能要让位给它） */
function attackerIgnoresArmor(g: Game, sourceId: string): boolean {
	const weapon = g.player(sourceId).equip.weapon;
	return weapon !== undefined && g.card(weapon).name === 'qinggangjian';
}

/** 一次使用的花色：优先看实体牌，虚拟牌（转化技）退回 CardUse 自带的 suit */
function useSuit(g: Game, ev: UseEvent) {
	const id = ev.use.cards[0];
	return id !== undefined ? g.card(id).suit : ev.use.suit;
}

// ─────────────────────────── 延时锦囊的内部桥接技能 ───────────────────────────

/**
 * 乐不思蜀/兵粮寸断命中后要跳过"之后才会发生"的某个阶段，但 PhaseEvent 只能在
 * 'phaseStart' 触发器里改 skipped——而判定阶段结算时，出牌/摸牌阶段的 PhaseEvent
 * 还没造出来。这里用一个通用的桥接技能：命中时把它挂到目标身上 + 置位对应 flag，
 * 到了目标阶段自己的 phaseStart 时机由它读 flag 决定要不要跳过。
 * 挂载后不摘除也没关系，flag 消耗掉之后它就是个恒为 false 的死技能。
 */
export const DELAYED_PHASE_SKIP_SKILL = 'delayed_phase_skip';

export const EQUIP_SKILLS: Record<string, SkillDef> = {
	[DELAYED_PHASE_SKIP_SKILL]: {
		id: DELAYED_PHASE_SKIP_SKILL,
		cn: '(内部标记)',
		desc: '内部桥接技能：延时锦囊命中后跳过之后的某个阶段，不面向玩家展示。',
		tags: ['locked'],
		triggers: [
			{
				timing: 'phaseStart',
				can(g, self, ev: PhaseEvent) {
					return ev.who === self.id && g.getFlag(self.id, `skipPhase:${ev.phase}`) > 0;
				},
				async run(g, self, ev: PhaseEvent) {
					ev.skipped = true;
					g.setFlag(self.id, `skipPhase:${ev.phase}`, 0);
					g.pushLog({ kind: 'phaseSkip', who: self.id, phase: ev.phase });
				},
			},
		],
	},

	// ─────────────────────────── 武器 ───────────────────────────

	zhuge: {
		id: 'zhuge',
		cn: '诸葛连弩',
		desc: '锁定技，你于出牌阶段内使用【杀】无次数限制。',
		tags: ['locked', 'equip'],
		mods: {
			shaLimit() {
				return Infinity;
			},
		},
	},

	cixiong: {
		id: 'cixiong',
		cn: '雌雄双股剑',
		desc: '当你使用【杀】指定一名异性的目标角色后，你可以令其选择一项：1. 弃置一张手牌；2. 令你摸一张牌。',
		tags: ['equip'],
		triggers: [
			{
				timing: 'onBecomeTarget',
				can(g, self, ev: UseEvent) {
					if (ev.source !== self.id || ev.use.name !== 'sha' || !ev.currentTarget) return false;
					const t = g.player(ev.currentTarget);
					return t.gender !== self.gender;
				},
				async run(g, self, ev: UseEvent) {
					const target = ev.currentTarget!;
					const tp = g.player(target);
					let wantDiscard = false;
					if (tp.hand.length > 0) {
						const choice = await g.askOption(target, '雌雄双股剑：请选择', [
							{ id: 'discard', label: '弃置一张手牌' },
							{ id: 'draw', label: `令 ${self.nickname} 摸一张牌` },
						]);
						wantDiscard = choice === 'discard';
					}
					if (wantDiscard) {
						const chosen = await g.askCards(
							target,
							'雌雄双股剑：请弃置一张手牌',
							tp.hand.map((id) => ({ id })),
							1,
							1,
							false,
						);
						if (chosen.length) await g.discardCards(chosen, 'cixiong', self.id);
					} else {
						await g.drawCards(self.id, 1, 'cixiong');
					}
				},
			},
		],
	},

	/** 青釭剑本身没有独立效果：renwang/tengjia 的免疫判定会主动检查攻击者是否装备它 */
	qinggang: {
		id: 'qinggang',
		cn: '青釭剑',
		desc: '锁定技，你使用【杀】无视目标的防具。',
		tags: ['locked', 'equip'],
	},

	qinglong: {
		id: 'qinglong',
		cn: '青龙偃月刀',
		desc: '当你使用的【杀】被目标角色使用的【闪】抵消后，你可以对其再使用一张【杀】（无距离限制）。',
		tags: ['equip'],
		triggers: [
			{
				timing: 'afterUse',
				can(g, self, ev: UseEvent) {
					if (ev.source !== self.id || ev.use.name !== 'sha') return false;
					const dodged = shaDodgedTargets.get(ev);
					return !!dodged && dodged.size > 0;
				},
				async run(g, self, ev: UseEvent) {
					const dodged = Array.from(shaDodgedTargets.get(ev) ?? []);
					for (const t of dodged) {
						if (!g.player(t).alive) continue;
						const use = await g.askForCard(
							self.id,
							'sha',
							`青龙偃月刀：可对 ${g.player(t).nickname} 再使用一张【杀】（无距离限制）`,
							undefined,
							'use',
						);
						if (use) await g.useCard(self.id, use, [t]);
					}
				},
			},
		],
	},

	zhangba: {
		id: 'zhangba',
		cn: '丈八蛇矛',
		desc: '你可以将两张手牌当【杀】使用或打出。',
		tags: ['equip'],
		active: {
			can(g, self) {
				if (self.hand.length < 2) return false;
				return g.getFlag(self.id, 'turn:shaUsed') < g.shaLimit(self.id);
			},
			async run(g, self) {
				const chosen = await g.askCards(
					self.id,
					'丈八蛇矛：选两张手牌当一张【杀】使用',
					self.hand.map((id) => ({ id })),
					2,
					2,
					true,
				);
				if (chosen.length < 2) return;
				const candidates = g
					.alivePlayers()
					.filter((p) => p.id !== self.id && g.inAttackRange(self.id, p.id))
					.map((p) => p.id);
				const targets = await g.askPlayers(self.id, '丈八蛇矛：选择杀的目标', candidates, 1, 1, true);
				if (targets.length === 0) return;
				await g.useCard(self.id, { name: 'sha', cards: chosen, viaSkill: 'zhangba' }, targets);
			},
		},
	},

	guanshi: {
		id: 'guanshi',
		cn: '贯石斧',
		desc: '当你使用的【杀】被目标角色使用的【闪】抵消后，你可以弃置两张牌，令此【杀】依然对该角色造成 1 点伤害。',
		tags: ['equip'],
		triggers: [
			{
				timing: 'afterUse',
				can(g, self, ev: UseEvent) {
					if (ev.source !== self.id || ev.use.name !== 'sha') return false;
					const dodged = shaDodgedTargets.get(ev);
					if (!dodged || dodged.size === 0) return false;
					return self.hand.length + Object.keys(self.equip).length >= 2;
				},
				async run(g, self, ev: UseEvent) {
					const dodged = Array.from(shaDodgedTargets.get(ev) ?? []);
					for (const t of dodged) {
						if (!g.player(t).alive) continue;
						const pool = [
							...self.hand,
							...Object.values(self.equip).filter((x): x is number => typeof x === 'number'),
						];
						if (pool.length < 2) break;
						const chosen = await g.askCards(
							self.id,
							'贯石斧：弃置两张牌，令杀依然对目标造成伤害',
							pool.map((id) => ({ id })),
							2,
							2,
							true,
						);
						if (chosen.length < 2) continue;
						await g.discardCards(chosen, 'guanshi', self.id);
						await g.damage({ source: self.id, target: t, amount: 1, nature: ev.use.nature, card: ev.use });
					}
				},
			},
		],
	},

	fangtian: {
		id: 'fangtian',
		cn: '方天画戟',
		desc: '你使用的【杀】若是你最后的手牌，你可以额外选择至多两个目标（无距离限制）。',
		tags: ['locked', 'equip'],
		triggers: [
			{
				timing: 'onTargetChosen',
				can(g, self, ev: UseEvent) {
					if (ev.source !== self.id || ev.use.name !== 'sha') return false;
					if (ev.use.cards.length === 0) return false;
					return self.hand.length === 0;
				},
				async run(g, self, ev: UseEvent) {
					const already = new Set(ev.targets);
					const candidates = g
						.alivePlayers()
						.map((p) => p.id)
						.filter((id) => id !== self.id && !already.has(id) && g.canBeTargeted(self.id, id, ev));
					if (candidates.length === 0) return;
					const picked = await g.askPlayers(
						self.id,
						'方天画戟：可额外指定至多两名目标（无距离限制）',
						candidates,
						0,
						Math.min(2, candidates.length),
						true,
					);
					for (const id of picked) if (!ev.targets.includes(id)) ev.targets.push(id);
				},
			},
		],
	},

	qilin: {
		id: 'qilin',
		cn: '麒麟弓',
		desc: '当你使用【杀】对目标角色造成伤害时，你可以弃置其装备区里的一张坐骑牌。',
		tags: ['equip'],
		triggers: [
			{
				timing: 'afterDamage',
				can(g, self, ev: DamageEvent) {
					if (ev.source !== self.id || !isShaName(ev.card?.name)) return false;
					const t = g.player(ev.target);
					return !!(t.equip.horsePlus || t.equip.horseMinus);
				},
				async run(g, self, ev: DamageEvent) {
					const t = g.player(ev.target);
					const mounts = [t.equip.horsePlus, t.equip.horseMinus].filter(
						(x): x is number => typeof x === 'number',
					);
					if (mounts.length === 0) return;
					const chosen =
						mounts.length === 1
							? mounts
							: await g.askCards(
									self.id,
									'麒麟弓：选择弃置目标的一匹坐骑',
									mounts.map((id) => ({ id })),
									1,
									1,
									true,
								);
					if (chosen.length === 0) return;
					await g.discardCards([chosen[0]], 'qilin', self.id);
				},
			},
		],
	},

	hanbing: {
		id: 'hanbing',
		cn: '寒冰剑',
		desc: '当你使用【杀】造成伤害时，你可以防止此伤害，然后依次弃置目标角色的两张牌。',
		tags: ['equip'],
		triggers: [
			{
				timing: 'beforeDamage',
				can(g, self, ev: DamageEvent) {
					if (ev.source !== self.id || !isShaName(ev.card?.name)) return false;
					return hasAnyCards(g, ev.target);
				},
				async run(g, self, ev: DamageEvent) {
					ev.cancelled = true;
					const pool = allCardsOf(g, ev.target);
					const n = Math.min(2, pool.length);
					if (n === 0) return;
					const chosen = await g.askCards(self.id, '寒冰剑：依次弃置目标的牌', pool, n, n, false);
					if (chosen.length) await g.discardCards(chosen, 'hanbing', self.id);
				},
			},
		],
	},

	// ─────────────────────────── 防具 ───────────────────────────

	bagua: {
		id: 'bagua',
		cn: '八卦阵',
		desc: '当你需要使用或打出一张【闪】时，你可以进行判定，若结果为红色，则视为使用或打出了一张【闪】。',
		tags: ['equip'],
		triggers: [
			{
				timing: 'beforeAskForCard',
				can(g, self, ev: AskForCardEvent) {
					return ev.who === self.id && ev.need === 'shan' && !ev.use;
				},
				async run(g, self, ev: AskForCardEvent) {
					const judgeEv = await g.judge(self.id, 'bagua', (card) => suitColor(card.suit) === 'red');
					if (judgeEv.result) ev.use = { name: 'shan', cards: [], viaSkill: 'bagua' };
				},
			},
		],
	},

	renwang: {
		id: 'renwang',
		cn: '仁王盾',
		desc: '锁定技，黑色【杀】对你无效。',
		tags: ['locked', 'equip'],
		triggers: [
			{
				timing: 'onBecomeTarget',
				can(g, self, ev: UseEvent) {
					if (ev.currentTarget !== self.id || ev.use.name !== 'sha') return false;
					if (attackerIgnoresArmor(g, ev.source)) return false;
					return suitColor(useSuit(g, ev) ?? 'heart') === 'black';
				},
				async run(g, self, ev: UseEvent) {
					ev.cancelledFor = ev.cancelledFor ?? [];
					if (!ev.cancelledFor.includes(self.id)) ev.cancelledFor.push(self.id);
					g.pushLog({ kind: 'blocked', who: self.id, by: 'renwang' });
				},
			},
		],
	},

	tengjia: {
		id: 'tengjia',
		cn: '藤甲',
		desc: '锁定技。普通【杀】、【南蛮入侵】、【万箭齐发】对你无效；但你受到的火焰伤害+1。',
		tags: ['locked', 'equip'],
		triggers: [
			{
				timing: 'onBecomeTarget',
				can(g, self, ev: UseEvent) {
					if (ev.currentTarget !== self.id) return false;
					if (attackerIgnoresArmor(g, ev.source)) return false;
					if (ev.use.name === 'sha') return !ev.use.nature;
					return ev.use.name === 'nanmanruqin' || ev.use.name === 'wanjianqifa';
				},
				async run(g, self, ev: UseEvent) {
					ev.cancelledFor = ev.cancelledFor ?? [];
					if (!ev.cancelledFor.includes(self.id)) ev.cancelledFor.push(self.id);
					g.pushLog({ kind: 'blocked', who: self.id, by: 'tengjia' });
				},
			},
			{
				timing: 'beforeDamage',
				can(g, self, ev: DamageEvent) {
					return ev.target === self.id && ev.nature === 'fire';
				},
				async run(_g, _self, ev: DamageEvent) {
					ev.amount += 1;
				},
			},
		],
	},

	baiyin: {
		id: 'baiyin',
		cn: '白银狮子',
		desc: '锁定技。①当你受到的伤害大于 1 点时，将其减至 1 点。②当你失去装备区里的【白银狮子】后，回复 1 点体力。',
		tags: ['locked', 'equip'],
		triggers: [
			{
				timing: 'beforeDamage',
				priority: -100, // 尽量放到最后结算，确保是在别的加伤效果之后再封顶
				can(g, self, ev: DamageEvent) {
					return ev.target === self.id && ev.amount > 1;
				},
				async run(_g, _self, ev: DamageEvent) {
					ev.amount = 1;
				},
			},
			{
				timing: 'afterLoseCards',
				// 注意：equipCard() 换装时会先把旧装备的技能从 p.skills 摘掉，再触发失去牌事件，
				// 所以这里只能覆盖到"直接被弃置/被夺走/带走"（过河拆桥、顺手牵羊、角色死亡）的情形，
				// 覆盖不到"换装/替换掉白银狮子"这一种——见最终报告里的引擎限制说明。
				can(g, self, ev: CardMoveEvent) {
					if (ev.from.zone !== 'equip' || ev.from.owner !== self.id) return false;
					return ev.cards.some((id) => g.card(id).name === 'baiyinshizi');
				},
				async run(g, self) {
					await g.recover({ target: self.id, amount: 1 });
				},
			},
		],
	},
};
