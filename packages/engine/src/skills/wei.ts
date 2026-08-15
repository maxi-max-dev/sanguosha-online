/**
 * 魏势力技能：曹操 / 司马懿 / 夏侯惇 / 张辽 / 许褚 / 郭嘉 / 甄姬（标准包）；
 * 曹仁 / 夏侯渊 / 典韦 / 荀彧（风 / 火扩充包，见 generals.ts 的 pack 字段）。
 */

import type { SkillDef } from '../defs.js';
import type { AskForCardEvent, Game } from '../game.js';
import { markLimit } from '../options.js';
import {
	suitColor,
	type DamageEvent,
	type DrawNumEvent,
	type JudgeEvent,
	type PhaseEvent,
	type PlayerState,
} from '../types.js';
import { pindian } from './util.js';

// ─────────────────────────── 曹操 ───────────────────────────

const jianxiong: SkillDef = {
	id: 'jianxiong',
	cn: '奸雄',
	desc: '当你受到伤害后，你可以获得造成伤害的牌。',
	triggers: [
		{
			timing: 'afterDamaged',
			can(g, self, ev: DamageEvent) {
				if (ev.target !== self.id) return false;
				const cards = ev.card?.cards ?? [];
				// 结算到这里时牌通常还在处理区；万一已经被别的技能连带丢进弃牌堆也认
				return cards.some((id) => ['processing', 'discard'].includes(g.locate(id).zone));
			},
			async run(g, self, ev: DamageEvent) {
				const cards = (ev.card?.cards ?? []).filter((id) =>
					['processing', 'discard'].includes(g.locate(id).zone),
				);
				if (cards.length) await g.gainCards(self.id, cards, 'jianxiong');
			},
		},
	],
};

const hujia: SkillDef = {
	id: 'hujia',
	cn: '护驾',
	desc: '你需要使用或打出【闪】时，可令一名其他魏势力角色代替你打出。',
	tags: ['lord'],
	triggers: [
		{
			timing: 'beforeAskForCard',
			can(g, self, ev: AskForCardEvent) {
				return ev.who === self.id && ev.need === 'shan' && !ev.use;
			},
			async run(g, self, ev: AskForCardEvent) {
				// 依次问一圈，谁先给了就用谁的，不必问完所有人
				for (const p of g.othersFrom(self.id)) {
					if (p.faction !== 'wei') continue;
					const use = await g.askForCard(
						p.id,
						'shan',
						`护驾：是否代 ${self.nickname} 打出一张【闪】？`,
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

// ─────────────────────────── 司马懿 ───────────────────────────

const fankui: SkillDef = {
	id: 'fankui',
	cn: '反馈',
	desc: '当你受到伤害后，你可以获得伤害来源的一张牌。',
	triggers: [
		{
			timing: 'afterDamaged',
			can(g, self, ev: DamageEvent) {
				if (ev.target !== self.id || !ev.source) return false;
				const src = g.player(ev.source);
				return src.alive && src.hand.length + Object.keys(src.equip).length > 0;
			},
			async run(g, self, ev: DamageEvent) {
				const src = g.player(ev.source!);
				const candidates = [
					// 手牌背面选：不能让发动者看见点数花色再挑
					...src.hand.map((id) => ({ id, unknown: true, from: src.id, zone: 'hand' })),
					...Object.values(src.equip)
						.filter((x): x is number => typeof x === 'number')
						.map((id) => ({ id, from: src.id, zone: 'equip' })),
				];
				const picked = await g.askCards(self.id, `反馈：获得 ${src.nickname} 的一张牌`, candidates, 1, 1, true);
				if (picked.length) await g.gainCards(self.id, picked, 'fankui', src.id);
			},
		},
	],
};

const guicai: SkillDef = {
	id: 'guicai',
	cn: '鬼才',
	desc: '一名角色的判定牌生效前，你可以打出一张手牌代替之。',
	triggers: [
		{
			timing: 'beforeJudgeEffect',
			// 不限制 ev.who===self：鬼才要能改任何人的判定，不只是自己的
			can(g, self, ev: JudgeEvent) {
				return self.hand.length > 0;
			},
			async run(g, self, ev: JudgeEvent) {
				const picked = await g.askCards(
					self.id,
					`鬼才：是否打出一张手牌代替 ${g.player(ev.who).nickname} 的判定牌？`,
					self.hand.map((id) => ({ id })),
					1,
					1,
					true,
				);
				if (picked.length) await g.replaceJudgeCard(ev, picked[0]);
			},
		},
	],
};

// ─────────────────────────── 夏侯惇 ───────────────────────────

const ganglie: SkillDef = {
	id: 'ganglie',
	cn: '刚烈',
	desc: '当你受到伤害后，你可以进行判定：若结果不为红桃，伤害来源需弃置两张手牌，否则你对其造成 1 点伤害。',
	triggers: [
		{
			timing: 'afterDamaged',
			can(g, self, ev: DamageEvent) {
				return ev.target === self.id && !!ev.source && g.player(ev.source).alive;
			},
			async run(g, self, ev: DamageEvent) {
				const source = g.player(ev.source!);
				const judgeEv = await g.judge(self.id, 'ganglie', (c) => c.suit !== 'heart');
				if (!judgeEv.result) return; // 红桃：无事发生
				if (source.hand.length >= 2) {
					const chosen = await g.askCards(
						source.id,
						`刚烈：弃置两张手牌，否则将受到 ${self.nickname} 造成的 1 点伤害`,
						source.hand.map((id) => ({ id })),
						2,
						2,
						true,
					);
					if (chosen.length >= 2) {
						await g.discardCards(chosen, 'ganglie', source.id);
						return;
					}
				}
				// 手牌不足两张，或主动放弃弃牌：只能受伤
				await g.damage({ source: self.id, target: source.id, amount: 1, nature: undefined });
			},
		},
	],
};

// ─────────────────────────── 张辽 ───────────────────────────

const tuxi: SkillDef = {
	id: 'tuxi',
	cn: '突袭',
	desc: '摸牌阶段，你可以放弃摸牌，改为获得至多两名其他角色各一张手牌。',
	triggers: [
		{
			timing: 'drawPhaseNum',
			can(g, self, ev: DrawNumEvent) {
				return ev.who === self.id && g.othersFrom(self.id).some((p) => p.hand.length > 0);
			},
			async run(g, self, ev: DrawNumEvent) {
				const candidates = g
					.othersFrom(self.id)
					.filter((p) => p.hand.length > 0)
					.map((p) => p.id);
				const targets = await g.askPlayers(
					self.id,
					'突袭：选择至多两名其他角色，各获得其一张手牌',
					candidates,
					1,
					Math.min(2, candidates.length),
					true,
				);
				if (targets.length === 0) return; // 放弃发动，正常摸牌
				ev.replaced = true;
				for (const t of targets) {
					const tp = g.player(t);
					if (!tp.alive || tp.hand.length === 0) continue;
					const picked = await g.askCards(
						self.id,
						`突袭：获得 ${tp.nickname} 的一张手牌`,
						tp.hand.map((id) => ({ id, unknown: true, from: tp.id, zone: 'hand' })),
						1,
						1,
					);
					if (picked.length) await g.gainCards(self.id, picked, 'tuxi', tp.id);
				}
			},
		},
	],
};

// ─────────────────────────── 许褚 ───────────────────────────

const luoyi: SkillDef = {
	id: 'luoyi',
	cn: '裸衣',
	desc: '摸牌阶段，你可以少摸一张牌。若如此做，你本回合使用【杀】或【决斗】造成的伤害+1。',
	triggers: [
		{
			timing: 'drawPhaseNum',
			can(g, self, ev: DrawNumEvent) {
				return ev.who === self.id && ev.num > 0;
			},
			async run(g, self, ev: DrawNumEvent) {
				ev.num -= 1;
				g.setFlag(self.id, 'turn:luoyi', 1);
			},
		},
	],
	mods: {
		damageBonus(g, self, ev) {
			if (g.getFlag(self.id, 'turn:luoyi') <= 0) return 0;
			const name = ev.card?.name;
			return name && ['sha', 'huosha', 'leisha', 'juedou'].includes(name) ? 1 : 0;
		},
	},
};

// ─────────────────────────── 郭嘉 ───────────────────────────

/** 遗计专用：把摸到的牌分给其他角色，没分配的自动留在自己手里 */
async function distributeCards(g: Game, who: string, cards: number[]): Promise<void> {
	const others = g.othersFrom(who).map((p) => p.id);
	if (others.length === 0 || cards.length === 0) return;
	const r = await g.ask({
		kind: 'distribute',
		who,
		prompt: '将摸到的牌分给其他角色，未分配的自己保留',
		cards,
		candidates: others,
		cancelable: true,
		timeout: 25,
	});
	if (r.type !== 'distribute') return;
	for (const { card, to } of r.assign) {
		if (!cards.includes(card) || !others.includes(to)) continue;
		// 同一张牌被重复分配时，第二次已经不在 who 手里了，跳过
		if (g.locate(card).zone !== 'hand' || g.locate(card).owner !== who) continue;
		await g.gainCards(to, [card], 'yiji', who);
	}
}

const tiandu: SkillDef = {
	id: 'tiandu',
	cn: '天妒',
	desc: '你的判定牌生效后，你可以获得此牌。',
	triggers: [
		{
			timing: 'afterJudgeEffect',
			can(g, self, ev: JudgeEvent) {
				return ev.who === self.id && !!ev.card && g.locate(ev.card.id).zone === 'processing';
			},
			async run(g, self, ev: JudgeEvent) {
				await g.gainCards(self.id, [ev.card!.id], 'tiandu');
			},
		},
	],
};

const yiji: SkillDef = {
	id: 'yiji',
	cn: '遗计',
	desc: '每受到 1 点伤害后，你可以摸两张牌，然后将其中任意张交给其他角色。',
	triggers: [
		{
			timing: 'afterDamaged',
			can(g, self, ev: DamageEvent) {
				return ev.target === self.id && ev.amount > 0;
			},
			async run(g, self, ev: DamageEvent) {
				// 伤害 N 点触发 N 次：第一次已经由引擎的 trigger() 问过了，之后每次自己再问一遍
				for (let i = 0; i < ev.amount; i++) {
					if (i > 0) {
						const again = await g.askConfirm(self.id, 'yiji', '是否再次发动【遗计】？');
						if (!again) break;
					}
					const drawn = await g.drawCards(self.id, 2, 'yiji');
					if (drawn.length === 0) break;
					await distributeCards(g, self.id, drawn);
				}
			},
		},
	],
};

// ─────────────────────────── 甄姬 ───────────────────────────

const luoshen: SkillDef = {
	id: 'luoshen',
	cn: '洛神',
	desc: '回合开始阶段，你可以进行判定：若结果为黑色，你获得此牌，然后可以再次发动。',
	triggers: [
		{
			timing: 'phaseStart',
			can(g, self, ev: PhaseEvent) {
				return ev.who === self.id && ev.phase === 'start';
			},
			async run(g, self, ev: PhaseEvent) {
				for (;;) {
					const judgeEv = await g.judge(self.id, 'luoshen', (c) => suitColor(c.suit) === 'black');
					if (!judgeEv.result) break;
					// judge() 收尾时已把判定牌丢进弃牌堆，这里直接从弃牌堆捞回即可
					await g.gainCards(self.id, [judgeEv.card!.id], 'luoshen');
					const again = await g.askConfirm(self.id, 'luoshen', '判定为黑色，是否再次发动【洛神】？');
					if (!again) break;
				}
			},
		},
	],
};

const qingguo: SkillDef = {
	id: 'qingguo',
	cn: '倾国',
	desc: '你可以将一张黑色手牌当【闪】使用或打出。',
	convert: {
		to: ['shan'],
		usage: ['use', 'respond'],
		filter(g, self, card) {
			return suitColor(card.suit) === 'black';
		},
	},
};

// ─────────────────────────── 曹仁（风包） ───────────────────────────

const jushou: SkillDef = {
	id: 'jushou',
	cn: '据守',
	desc: '结束阶段，你可以摸三张牌，然后将你的武将牌翻面（下个回合开始时跳过）。',
	triggers: [
		{
			timing: 'phaseStart',
			can(g, self, ev: PhaseEvent) {
				return ev.who === self.id && ev.phase === 'end';
			},
			// 不在这里再问一次"是否发动"：trigger() 外层已经为非锁定技问过一次通用确认框了，
			// 这里问的是"要不要摸三张牌并翻面"——和外层是同一个问题，不能重复问
			async run(g, self) {
				await g.drawCards(self.id, 3, 'jushou');
				self.turnedOver = true;
			},
		},
	],
};

// ─────────────────────────── 夏侯渊（风包） ───────────────────────────

const xinshensu: SkillDef = {
	id: 'xinshensu',
	cn: '神速',
	desc: '回合开始时，你可以选择至多三项：1. 跳过判定阶段和摸牌阶段；2. 跳过出牌阶段并弃置一张装备牌；3. 跳过弃牌阶段并将武将牌翻面。每选择一项，视为你对一名其他角色使用一张没有距离限制的【杀】。',
	// 三个子选项本身就是三次独立的"是否"询问，不需要外层再套一次笼统的"是否发动神速"确认框
	tags: ['locked'],
	triggers: [
		{
			timing: 'turnStart',
			can(g, self, ev: { who: string }) {
				return ev.who === self.id && g.othersFrom(self.id).length > 0;
			},
			async run(g, self) {
				const others = g.othersFrom(self.id).map((p) => p.id);

				const fireVirtualSha = async () => {
					const targets = await g.askPlayers(self.id, '神速：选择一名角色使用一张无距离限制的【杀】', others, 1, 1, true);
					if (targets.length === 0) return;
					await g.useCard(self.id, { name: 'sha', cards: [], viaSkill: 'xinshensu' }, targets);
				};

				const skipJudgeDraw = await g.askConfirm(self.id, 'xinshensu', '神速：是否跳过判定阶段和摸牌阶段？');
				if (skipJudgeDraw) {
					g.setFlag(self.id, 'turn:xinshensuSkipJudgeDraw', 1);
					await fireVirtualSha();
				}

				const equipIds = Object.values(self.equip).filter((x): x is number => typeof x === 'number');
				if (equipIds.length > 0) {
					const skipPlay = await g.askConfirm(self.id, 'xinshensu', '神速：是否跳过出牌阶段并弃置一张装备牌？');
					if (skipPlay) {
						const picked = await g.askCards(
							self.id,
							'神速：弃置一张装备牌',
							equipIds.map((id) => ({ id })),
							1,
							1,
							true,
						);
						if (picked.length) {
							await g.discardCards(picked, 'xinshensu', self.id);
							g.setFlag(self.id, 'turn:xinshensuSkipPlay', 1);
							await fireVirtualSha();
						}
					}
				}

				const skipDiscard = await g.askConfirm(self.id, 'xinshensu', '神速：是否跳过弃牌阶段并翻面？');
				if (skipDiscard) {
					g.setFlag(self.id, 'turn:xinshensuSkipDiscard', 1);
					await fireVirtualSha();
				}
			},
		},
		{
			timing: 'phaseStart',
			can(g, self, ev: PhaseEvent) {
				if (ev.who !== self.id) return false;
				if (ev.phase === 'judge' || ev.phase === 'draw') return g.getFlag(self.id, 'turn:xinshensuSkipJudgeDraw') > 0;
				if (ev.phase === 'play') return g.getFlag(self.id, 'turn:xinshensuSkipPlay') > 0;
				if (ev.phase === 'discard') return g.getFlag(self.id, 'turn:xinshensuSkipDiscard') > 0;
				return false;
			},
			async run(g, self, ev: PhaseEvent) {
				ev.skipped = true;
				// "翻面"是弃牌阶段那一项的代价：本回合到这里已经没有后续阶段了，直接标记翻面即可
				if (ev.phase === 'discard') self.turnedOver = true;
			},
		},
	],
};

// ─────────────────────────── 典韦（火包） ───────────────────────────

/** 强袭本回合已经命中过的目标（存成逗号分隔的 id 列表，flags 只存 number/string/boolean，没有数组） */
function qiangxiHit(self: PlayerState): string[] {
	const raw = self.flags['turn:qiangxiHit'];
	return typeof raw === 'string' && raw.length > 0 ? raw.split(',') : [];
}

function qiangxiCandidates(g: Game, self: PlayerState): string[] {
	const hit = new Set(qiangxiHit(self));
	return g
		.alivePlayers()
		.filter((p) => p.id !== self.id && g.inAttackRange(self.id, p.id) && !hit.has(p.id))
		.map((p) => p.id);
}

const qiangxix: SkillDef = {
	id: 'qiangxix',
	cn: '强袭',
	desc: '出牌阶段限两次，你可以选择一项：1. 失去1点体力；2. 弃置一张武器牌；然后对攻击范围内一名本阶段未被强袭过的其他角色造成1点伤害。',
	active: {
		limit: 2,
		can(g, self) {
			if (self.hp <= 1 && self.equip.weapon === undefined) return false;
			return qiangxiCandidates(g, self).length > 0;
		},
		async run(g, self) {
			const candidates = qiangxiCandidates(g, self);
			if (candidates.length === 0) return;
			const canLoseHp = self.hp > 1;
			const canDiscardWeapon = self.equip.weapon !== undefined;
			let useWeapon = canDiscardWeapon && !canLoseHp;
			if (canLoseHp && canDiscardWeapon) {
				const choice = await g.askOption(self.id, '强袭：请选择失去1点体力，还是弃置一张武器牌', [
					{ id: 'hp', label: '失去1点体力' },
					{ id: 'weapon', label: '弃置一张武器牌' },
				]);
				useWeapon = choice === 'weapon';
			} else if (!canLoseHp && !canDiscardWeapon) {
				return;
			}
			const targets = await g.askPlayers(self.id, '强袭：选择攻击范围内的一名其他角色', candidates, 1, 1, true);
			if (targets.length === 0) return;
			markLimit(g, self, 'qiangxix', 2);
			if (useWeapon) {
				await g.discardCards([self.equip.weapon!], 'qiangxix', self.id);
			} else {
				await g.loseHp(self.id, 1, 'qiangxix');
				if (!self.alive) return;
			}
			g.setFlag(self.id, 'turn:qiangxiHit', [...qiangxiHit(self), targets[0]].join(','));
			await g.damage({ source: self.id, target: targets[0], amount: 1, nature: undefined });
		},
	},
};

// ─────────────────────────── 荀彧（火包） ───────────────────────────

const quhu: SkillDef = {
	id: 'quhu',
	cn: '驱虎',
	desc: '出牌阶段限一次，你可以与一名体力值大于你的角色拼点。若你赢，该角色对其攻击范围内由你指定的另一名角色造成1点伤害；若你没赢，该角色对你造成1点伤害。',
	active: {
		limit: 'turn',
		can(g, self) {
			return (
				self.hand.length > 0 &&
				g.alivePlayers().some((p) => p.id !== self.id && p.hp > self.hp && p.hand.length > 0)
			);
		},
		async run(g, self) {
			const candidates = g
				.alivePlayers()
				.filter((p) => p.id !== self.id && p.hp > self.hp && p.hand.length > 0)
				.map((p) => p.id);
			const picked = await g.askPlayers(self.id, '驱虎：选择一名体力值大于你的角色拼点', candidates, 1, 1, true);
			if (picked.length === 0) return;
			const opponent = picked[0];
			markLimit(g, self, 'quhu', 'turn');
			const result = await pindian(g, self.id, opponent, 'quhu');
			if (!result) return;
			const op = g.player(opponent);
			if (result.initiatorWins) {
				const victims = g
					.alivePlayers()
					.filter((p) => p.id !== opponent && g.inAttackRange(opponent, p.id))
					.map((p) => p.id);
				if (victims.length === 0) return;
				const victim = await g.askPlayers(
					self.id,
					`驱虎：指定 ${op.nickname} 攻击范围内的一名角色，令其对其造成1点伤害`,
					victims,
					1,
					1,
					true,
				);
				if (victim.length === 0) return;
				await g.damage({ source: opponent, target: victim[0], amount: 1, nature: undefined });
			} else {
				await g.damage({ source: opponent, target: self.id, amount: 1, nature: undefined });
			}
		},
	},
};

const jieming: SkillDef = {
	id: 'jieming',
	cn: '节命',
	desc: '当你受到伤害后，你可以令一名角色将手牌摸至体力上限（至多5张）。',
	triggers: [
		{
			timing: 'afterDamaged',
			can(g, self, ev: DamageEvent) {
				return ev.target === self.id && ev.amount > 0;
			},
			async run(g, self) {
				const targets = await g.askPlayers(
					self.id,
					'节命：选择一名角色将手牌摸至体力上限（至多5张）',
					g.alivePlayers().map((p) => p.id),
					1,
					1,
					true,
				);
				if (targets.length === 0) return;
				const t = g.player(targets[0]);
				const upTo = Math.min(5, t.maxHp);
				if (t.hand.length < upTo) await g.drawCards(t.id, upTo - t.hand.length, 'jieming');
			},
		},
	],
};

export const WEI_SKILLS: Record<string, SkillDef> = {
	jianxiong,
	hujia,
	fankui,
	guicai,
	ganglie,
	tuxi,
	luoyi,
	tiandu,
	yiji,
	luoshen,
	qingguo,
	jushou,
	xinshensu,
	qiangxix,
	quhu,
	jieming,
};
