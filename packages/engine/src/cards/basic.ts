/**
 * 基本牌：杀 / 火杀 / 雷杀 / 闪 / 桃 / 酒。
 */
import type { CardDef } from '../defs.js';
import type { Game } from '../game.js';
import type { Nature, UseEvent } from '../types.js';

/**
 * 杀被成功闪避的目标记录在这里，供青龙偃月刀/贯石斧这类"杀被闪避后……"的装备技能读取。
 * UseEvent 本身没有"是否被闪避"这个字段（闪避与否是 onEffect 内部的事），
 * 用 WeakMap 以 ev 为 key 挂一份旁路数据，比在 UseEvent 上硬加字段更不侵入类型契约。
 */
export const shaDodgedTargets = new WeakMap<UseEvent, Set<string>>();

/** 杀/火杀/雷杀共用同一套结算逻辑，区别只在 nature */
function buildSha(name: string, cn: string, nature: Nature): CardDef {
	return {
		name,
		cn,
		type: 'basic',
		nature,
		targetMin: 1,
		targetMax: 1,
		useDistance: true,
		canTarget(_g, source, target) {
			return target !== source;
		},
		async onUse(g, ev) {
			// options.ts 靠 turn:shaUsed 做次数限制
			g.addFlag(ev.source, 'turn:shaUsed', 1);
			// 酒的"下一张杀伤害+1"只认本次使用一次，且要对这次杀的所有目标一视同仁，
			// 所以在 onUse（逐目标结算前）就把判定结果定下来，别放进 onEffect 里逐目标各判一次。
			const boosted = g.getFlag(ev.source, 'turn:jiuActive') > 0;
			if (boosted) g.setFlag(ev.source, 'turn:jiuActive', 0);
			g.setFlag(ev.source, 'turn:shaDamageBonus', boosted ? 1 : 0);
		},
		async onEffect(g: Game, ev: UseEvent, target: string) {
			// 铁骑类技能标记的目标不能用闪响应，直接判定命中
			const forced = ev.unavoidableFor?.includes(target) ?? false;
			let dodged = false;
			if (!forced) {
				const need = g.shanNeeded(ev);
				dodged = true;
				for (let i = 0; i < need; i++) {
					const use = await g.askForCard(
						target,
						'shan',
						need > 1
							? `请打出第 ${i + 1}/${need} 张【闪】，否则受到伤害`
							: '你被【杀】指向，请打出一张【闪】',
						{ source: ev.source, use: ev.use },
						'respond',
					);
					if (!use) {
						dodged = false;
						break;
					}
				}
			}
			if (dodged) {
				let set = shaDodgedTargets.get(ev);
				if (!set) {
					set = new Set();
					shaDodgedTargets.set(ev, set);
				}
				set.add(target);
				return;
			}

			let amount = 1;
			if (g.getFlag(ev.source, 'turn:shaDamageBonus') > 0) amount += 1;
			await g.damage({ source: ev.source, target, amount, nature: ev.use.nature, card: ev.use });
		},
	};
}

export const shan: CardDef = {
	name: 'shan',
	cn: '闪',
	type: 'basic',
	// 闪只能用来响应【杀】，不能在出牌阶段主动使用
	canUse: () => false,
};

export const tao: CardDef = {
	name: 'tao',
	cn: '桃',
	type: 'basic',
	targetMin: 1,
	targetMax: 1,
	// 濒死救援走引擎的 rescue 通道（dying()），不经过这里的 canUse/canTarget
	canUse(g, source) {
		const p = g.player(source);
		return p.hp < p.maxHp;
	},
	canTarget(_g, source, target) {
		return target === source;
	},
	async onEffect(g, ev, target) {
		await g.recover({ source: ev.source, target, amount: 1, card: ev.use });
	},
};

export const jiu: CardDef = {
	name: 'jiu',
	cn: '酒',
	type: 'basic',
	targetMin: 1,
	targetMax: 1,
	canUse(g, source) {
		// 出牌阶段的"加伤"用法每回合限一次；濒死自救走 rescue 通道不受此限
		return g.getFlag(source, 'turn:jiuUsed') < 1;
	},
	canTarget(_g, source, target) {
		return target === source;
	},
	async onEffect(g, ev, target) {
		const p = g.player(target);
		if (p.hp <= 0) {
			// 濒死时的酒：直接回复 1 点体力
			await g.recover({ source: ev.source, target, amount: 1, card: ev.use });
		} else {
			// 出牌阶段的酒：标记本回合下一张杀伤害+1
			g.addFlag(target, 'turn:jiuUsed', 1);
			g.setFlag(target, 'turn:jiuActive', 1);
		}
	},
};

export const sha = buildSha('sha', '杀', undefined);
export const huosha = buildSha('huosha', '火杀', 'fire');
export const leisha = buildSha('leisha', '雷杀', 'thunder');

export const BASIC_CARDS: Record<string, CardDef> = {
	sha,
	huosha,
	leisha,
	shan,
	tao,
	jiu,
};
