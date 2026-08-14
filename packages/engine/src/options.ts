/**
 * 合法出牌/响应的枚举器。
 *
 * 前端**不做任何规则推导** —— 哪张牌能点、能点谁、要选几张，全部由这里算好随请求下发。
 * 好处有二：客户端改不了规则（防作弊），以及规则只有一份实现，不会前后端漂移。
 */

import type { ConvertSpec } from './defs.js';
import type { Game, OptionProvider } from './game.js';
import type { PlayOption, TargetSpec } from './protocol.js';
import type { Card, PlayerState, UseEvent } from './types.js';

/** 转化技造出的虚拟牌选项 id 要稳定可复现（决策日志靠它回放） */
function optId(parts: (string | number)[]): string {
	return parts.join(':');
}

/** 某张牌当前能否被 who 使用（不含目标合法性） */
function canUseCardNow(g: Game, who: string, name: string): boolean {
	const def = g.registry.cards[name];
	if (!def) return false;
	if (def.canUse && !def.canUse(g, who)) return false;
	// 【杀】的每回合次数限制
	if (name === 'sha' || def.nature) {
		if (name === 'sha' || name.endsWith('sha')) {
			const used = g.getFlag(who, 'turn:shaUsed');
			if (used >= g.shaLimit(who)) return false;
		}
	}
	return true;
}

/** 计算一张牌的合法目标 */
function targetsFor(g: Game, who: string, name: string, cards: number[], viaSkill?: string): TargetSpec {
	const def = g.registry.cards[name];
	const min = def.targetMin ?? 1;
	const max = def.targetMax ?? 1;
	const fakeEv: UseEvent = { source: who, use: { name, cards, viaSkill }, targets: [] };

	let pool: PlayerState[] = g.alivePlayers();

	// 距离限制：【杀】看攻击范围；锦囊看是否有无视距离的技能
	if (def.useDistance) {
		pool = pool.filter((p) => p.id === who || g.inAttackRange(who, p.id));
	}

	const candidates = pool
		.filter((p) => g.canBeTargeted(who, p.id, fakeEv))
		.map((p) => p.id);

	if (max === 'all') {
		return { min: candidates.length, max: candidates.length, candidates, auto: true };
	}
	return { min, max, candidates };
}

/** 一张实体牌变成一个出牌选项；目标不足则返回 null */
function optionFromCard(g: Game, who: string, card: Card): PlayOption | null {
	const def = g.registry.cards[card.name];
	if (!def) return null;
	if (!canUseCardNow(g, who, card.name)) return null;

	// 装备牌永远能穿
	if (def.type === 'equip') {
		return {
			id: optId(['card', card.id]),
			name: card.name,
			cards: [card.id],
			targets: { min: 0, max: 0, candidates: [], auto: true },
		};
	}

	const targets = targetsFor(g, who, card.name, [card.id]);
	if (targets.candidates.length < targets.min) return null;

	return {
		id: optId(['card', card.id]),
		name: card.name,
		nature: def.nature,
		cards: [card.id],
		targets,
	};
}

/** 转化技产出的选项 */
function convertOptions(
	g: Game,
	p: PlayerState,
	usage: 'use' | 'respond',
	need?: string,
): PlayOption[] {
	const out: PlayOption[] = [];

	for (const sid of p.skills) {
		if (p.disabledSkills.includes(sid)) continue;
		const sk = g.registry.skills[sid];
		const cv = sk?.convert;
		if (!cv || !cv.usage.includes(usage)) continue;
		if (cv.can && !cv.can(g, p)) continue;

		const zones = cv.from ?? ['hand'];
		const pool: number[] = [];
		if (zones.includes('hand')) pool.push(...p.hand);
		if (zones.includes('equip')) {
			pool.push(...Object.values(p.equip).filter((x): x is number => typeof x === 'number'));
		}

		const count = cv.count ?? 1;
		const usable = pool.filter((id) => cv.filter(g, p, g.card(id)));
		if (usable.length < count) continue;

		for (const to of cv.to) {
			if (need && to !== need) continue;
			if (usage === 'use' && !canUseCardNow(g, p.id, to)) continue;
			if (!g.registry.cards[to]) continue;

			// count>1 的转化技（本包暂无）留给技能自己在 active 里处理，这里只枚举单张
			if (count !== 1) continue;

			for (const id of usable) {
				// 把一张牌转化成它自己没有任何意义（龙胆的 filter 同时认【杀】和【闪】，
				// 不排掉就会冒出"用杀当杀"这种选项）。这条对所有转化技都成立。
				if (g.card(id).name === to) continue;

				const targets =
					usage === 'use'
						? targetsFor(g, p.id, to, [id], sid)
						: { min: 0, max: 0, candidates: [], auto: true };
				if (usage === 'use' && targets.candidates.length < targets.min) continue;

				out.push({
					id: optId(['skill', sid, id, to]),
					name: to,
					nature: cv.nature ?? g.registry.cards[to].nature,
					cards: [id],
					viaSkill: sid,
					targets,
				});
			}
		}
	}
	return out;
}

/** 主动技（出牌阶段按钮）*/
function activeOptions(g: Game, p: PlayerState): PlayOption[] {
	const out: PlayOption[] = [];
	for (const sid of p.skills) {
		if (p.disabledSkills.includes(sid)) continue;
		const sk = g.registry.skills[sid];
		if (!sk?.active) continue;
		if (!limitOk(g, p, sk.id, sk.active.limit)) continue;
		let ok = false;
		try {
			ok = sk.active.can(g, p);
		} catch {
			ok = false;
		}
		if (!ok) continue;
		out.push({
			id: optId(['active', sid]),
			name: sid,
			cards: [],
			viaSkill: sid,
			targets: { min: 0, max: 0, candidates: [], auto: true },
		});
	}
	return out;
}

export function limitOk(
	g: Game,
	p: PlayerState,
	skillId: string,
	limit: 'turn' | 'round' | 'game' | number | undefined,
): boolean {
	if (limit === undefined) return true;
	if (limit === 'turn') return g.getFlag(p.id, `turn:${skillId}`) < 1;
	if (limit === 'round') return g.getFlag(p.id, `round:${skillId}`) < 1;
	if (limit === 'game') return g.getFlag(p.id, `game:${skillId}`) < 1;
	return g.getFlag(p.id, `turn:${skillId}`) < limit;
}

/** 技能发动后记次数 */
export function markLimit(
	g: Game,
	p: PlayerState,
	skillId: string,
	limit: 'turn' | 'round' | 'game' | number | undefined,
): void {
	if (limit === undefined) return;
	const scope = limit === 'round' ? 'round' : limit === 'game' ? 'game' : 'turn';
	g.addFlag(p.id, `${scope}:${skillId}`, 1);
}

export const optionProvider: OptionProvider = {
	/** 出牌阶段的全部可选动作 */
	play(g: Game, who: string): PlayOption[] {
		const p = g.player(who);
		const out: PlayOption[] = [];

		for (const id of p.hand) {
			const o = optionFromCard(g, who, g.card(id));
			if (o) out.push(o);
			// 重铸和使用是两个独立选项，同一张牌可能两者都能选（铁索）
			const def = g.registry.cards[g.card(id).name];
			if (def?.recastable) {
				out.push({
					id: optId(['recast', id]),
					name: def.name,
					cards: [id],
					recast: true,
					targets: { min: 0, max: 0, candidates: [], auto: true },
				});
			}
		}
		out.push(...convertOptions(g, p, 'use'));
		out.push(...activeOptions(g, p));
		return out;
	},

	/** 响应/使用某张指定牌名的全部可选动作 */
	respond(
		g: Game,
		who: string,
		need: string,
		mode: 'use' | 'respond',
		ev?: UseEvent,
	): PlayOption[] {
		const p = g.state.players.find((x) => x.id === who);
		if (!p?.alive) return [];
		const out: PlayOption[] = [];

		for (const id of p.hand) {
			const c = g.card(id);
			if (c.name !== need) continue;
			// 【无懈可击】只对锦囊有效，且响应时不受"能否使用"限制
			out.push({
				id: optId(['card', id]),
				name: c.name,
				nature: g.registry.cards[c.name]?.nature,
				cards: [id],
				targets: { min: 0, max: 0, candidates: [], auto: true },
			});
		}
		out.push(...convertOptions(g, p, mode === 'use' ? 'use' : 'respond', need));

		// 转化技可能同时挂在 'use' 和 'respond' 上（如龙胆），去重
		const seen = new Set<string>();
		return out.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
	},

	/** 濒死救援：任何人可用【桃】；自己濒死时还能用【酒】 */
	rescue(g: Game, rescuerId: string, dyingId: string): PlayOption[] {
		const p = g.state.players.find((x) => x.id === rescuerId);
		if (!p?.alive) return [];
		const out: PlayOption[] = [];

		const push = (id: number, name: string, viaSkill?: string) => {
			out.push({
				id: viaSkill ? optId(['skill', viaSkill, id, name]) : optId(['card', id]),
				name,
				cards: [id],
				viaSkill,
				targets: { min: 1, max: 1, candidates: [dyingId], auto: true },
			});
		};

		for (const id of p.hand) {
			const c = g.card(id);
			if (c.name === 'tao') push(id, 'tao');
			else if (c.name === 'jiu' && rescuerId === dyingId) push(id, 'jiu');
		}

		// 急救这类"把牌当桃"的转化技
		for (const sid of p.skills) {
			if (p.disabledSkills.includes(sid)) continue;
			const cv: ConvertSpec | undefined = g.registry.skills[sid]?.convert;
			if (!cv || !cv.to.includes('tao')) continue;
			if (cv.can && !cv.can(g, p)) continue;
			const zones = cv.from ?? ['hand'];
			const pool: number[] = [];
			if (zones.includes('hand')) pool.push(...p.hand);
			if (zones.includes('equip')) {
				pool.push(...Object.values(p.equip).filter((x): x is number => typeof x === 'number'));
			}
			for (const id of pool) {
				if (cv.filter(g, p, g.card(id))) push(id, 'tao', sid);
			}
		}

		const seen = new Set<string>();
		return out.filter((o) => (seen.has(o.id) ? false : (seen.add(o.id), true)));
	},
};
