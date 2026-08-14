/**
 * 即时锦囊牌（12 张）：决斗 / 过河拆桥 / 顺手牵羊 / 无中生有 / 南蛮入侵 / 万箭齐发 /
 * 桃园结义 / 五谷丰登 / 借刀杀人 / 无懈可击 / 铁索连环 / 火攻。
 *
 * 锦囊默认 wuxieable=true（defs.ts 的注释），且 useCard() 已经在逐目标结算前统一问过
 * 无懈可击，这里不用再管"能不能被无懈"。
 */
import type { CardDef } from '../defs.js';
import type { Game } from '../game.js';
import type { UseEvent } from '../types.js';
import { allCardsOf, hasAnyCards } from './util.js';

export const juedou: CardDef = {
	name: 'juedou',
	cn: '决斗',
	type: 'trick',
	targetMin: 1,
	targetMax: 1,
	canTarget(_g, source, target) {
		return target !== source;
	},
	async onEffect(g, ev, target) {
		// 目标先出杀，然后来源，轮流打出，直到一方打不出为止；打不出的一方受对方 1 点伤害
		let turnPlayer = target;
		let other = ev.source;
		for (;;) {
			const need = g.shaNeededInDuel(other);
			let ok = true;
			for (let i = 0; i < need; i++) {
				const use = await g.askForCard(
					turnPlayer,
					'sha',
					need > 1 ? `决斗：请打出第 ${i + 1}/${need} 张【杀】` : '决斗：请打出一张【杀】，否则受到伤害',
					{ source: other, use: ev.use },
					'respond',
				);
				if (!use) {
					ok = false;
					break;
				}
			}
			if (!ok) {
				await g.damage({ source: other, target: turnPlayer, amount: 1, nature: undefined, card: ev.use });
				return;
			}
			[turnPlayer, other] = [other, turnPlayer];
		}
	},
};

export const guohechaiqiao: CardDef = {
	name: 'guohechaiqiao',
	cn: '过河拆桥',
	type: 'trick',
	targetMin: 1,
	targetMax: 1,
	canTarget(g, source, target) {
		return target !== source && hasAnyCards(g, target);
	},
	async onEffect(g, ev, target) {
		const pool = allCardsOf(g, target);
		if (pool.length === 0) return;
		const chosen = await g.askCards(
			ev.source,
			`过河拆桥：选择 ${g.player(target).nickname} 的一张牌弃置`,
			pool,
			1,
			1,
		);
		if (chosen.length === 0) return;
		await g.discardCards(chosen, 'guohe', ev.source);
	},
};

export const shunshouqianyang: CardDef = {
	name: 'shunshouqianyang',
	cn: '顺手牵羊',
	type: 'trick',
	targetMin: 1,
	targetMax: 1,
	canTarget(g, source, target) {
		if (target === source || !hasAnyCards(g, target)) return false;
		return g.ignoresDistance(source, 'shunshouqianyang') || g.distance(source, target) <= 1;
	},
	async onEffect(g, ev, target) {
		const pool = allCardsOf(g, target);
		if (pool.length === 0) return;
		const chosen = await g.askCards(
			ev.source,
			`顺手牵羊：选择 ${g.player(target).nickname} 的一张牌获得`,
			pool,
			1,
			1,
		);
		if (chosen.length === 0) return;
		await g.gainCards(ev.source, chosen, 'shunshou', ev.source);
	},
};

export const wuzhongshengyou: CardDef = {
	name: 'wuzhongshengyou',
	cn: '无中生有',
	type: 'trick',
	targetMin: 1,
	targetMax: 1,
	canTarget(_g, source, target) {
		return target === source;
	},
	async onEffect(g, ev, target) {
		await g.drawCards(target, 2, 'wuzhong');
	},
};

export const nanmanruqin: CardDef = {
	name: 'nanmanruqin',
	cn: '南蛮入侵',
	type: 'trick',
	targetMax: 'all',
	canTarget(_g, source, target) {
		return target !== source;
	},
	async onEffect(g, ev, target) {
		const use = await g.askForCard(
			target,
			'sha',
			'南蛮入侵：请打出一张【杀】，否则受到1点伤害',
			{ source: ev.source, use: ev.use },
			'respond',
		);
		if (!use) await g.damage({ source: ev.source, target, amount: 1, nature: undefined, card: ev.use });
	},
};

export const wanjianqifa: CardDef = {
	name: 'wanjianqifa',
	cn: '万箭齐发',
	type: 'trick',
	targetMax: 'all',
	canTarget(_g, source, target) {
		return target !== source;
	},
	async onEffect(g, ev, target) {
		const use = await g.askForCard(
			target,
			'shan',
			'万箭齐发：请打出一张【闪】，否则受到1点伤害',
			{ source: ev.source, use: ev.use },
			'respond',
		);
		if (!use) await g.damage({ source: ev.source, target, amount: 1, nature: undefined, card: ev.use });
	},
};

export const taoyuanjieyi: CardDef = {
	name: 'taoyuanjieyi',
	cn: '桃园结义',
	type: 'trick',
	targetMax: 'all',
	async onEffect(g, ev, target) {
		await g.recover({ source: ev.source, target, amount: 1, card: ev.use });
	},
};

/** 五谷丰登：亮出的这一批牌要在多次 onEffect 调用之间共享同一个"剩余牌池"，用 ev 作为 key */
const wuguPools = new WeakMap<UseEvent, number[]>();

export const wugufengdeng: CardDef = {
	name: 'wugufengdeng',
	cn: '五谷丰登',
	type: 'trick',
	targetMax: 'all',
	async onUse(g, ev) {
		const ids = g.peekPile(ev.targets.length);
		await g.moveCards(ids, { zone: 'processing' }, 'wugu-reveal', ev.source);
		wuguPools.set(ev, ids.slice());
	},
	async onEffect(g, ev, target) {
		const pool = wuguPools.get(ev);
		if (!pool || pool.length === 0) return;
		const chosen = await g.askCards(
			target,
			'五谷丰登：从亮出的牌中选择一张',
			pool.map((id) => ({ id })),
			1,
			1,
		);
		const pick = chosen[0] ?? pool[0];
		const idx = pool.indexOf(pick);
		if (idx >= 0) pool.splice(idx, 1);
		await g.gainCards(target, [pick], 'wugu', ev.source);

		// 若后面轮到的目标已经不可能再来领牌（死亡/被无懈），多出来的牌直接进弃牌堆，
		// 避免永远卡在处理区。正常情况下 pool 会随目标一个个领取精确清零。
		const restFrom = ev.targets.indexOf(target) + 1;
		const futureAlive = ev.targets.slice(restFrom).filter((id) => g.player(id).alive).length;
		if (pool.length > futureAlive) {
			const extra = pool.splice(futureAlive);
			if (extra.length) await g.discardCards(extra, 'wugu-leftover');
		}
	},
};

export const jiedaosharen: CardDef = {
	name: 'jiedaosharen',
	cn: '借刀杀人',
	type: 'trick',
	targetMin: 1,
	targetMax: 1,
	canTarget(g, source, target) {
		return target !== source && !!g.player(target).equip.weapon;
	},
	async onEffect(g, ev, target) {
		const candidates = g.alivePlayers().map((p) => p.id).filter((id) => id !== target);
		if (candidates.length === 0) return;
		const picked = await g.askPlayers(
			ev.source,
			'借刀杀人：请指定一名角色，令目标对其使用【杀】',
			candidates,
			1,
			1,
		);
		const victim = picked[0];
		if (!victim) return;

		const weaponId = g.player(target).equip.weapon;
		const use = await g.askForCard(
			target,
			'sha',
			`借刀杀人：请对 ${g.player(victim).nickname} 使用一张【杀】，否则你的武器将被夺走`,
			{ source: ev.source, use: ev.use },
			'use',
		);
		if (use) {
			await g.useCard(target, use, [victim]);
		} else if (weaponId !== undefined) {
			await g.gainCards(ev.source, [weaponId], 'jiedao', ev.source);
		}
	},
};

export const wuxiekeji: CardDef = {
	name: 'wuxiekeji',
	cn: '无懈可击',
	type: 'trick',
	targetMin: 0,
	targetMax: 0,
	// 无懈可击只能在别的牌结算链条里被动打出（见 game.ts 的 askWuxie），
	// 不能在出牌阶段当成一张主动牌来用
	canUse: () => false,
};

export const tiesuolianhuan: CardDef = {
	name: 'tiesuolianhuan',
	cn: '铁索连环',
	type: 'trick',
	targetMin: 1,
	targetMax: 2,
	// 重铸：出牌阶段弃掉它摸一张，次数不限。引擎在 options.ts 里把它枚举成
	// 一个独立选项（id 前缀 recast:），在 playPhase 里单独结算，不走用牌流程
	recastable: true,
	async onEffect(g, ev, target) {
		const p = g.player(target);
		p.chained = !p.chained;
		g.pushLog({ kind: 'chain', who: target, chained: p.chained });
	},
};

export const huogong: CardDef = {
	name: 'huogong',
	cn: '火攻',
	type: 'trick',
	targetMin: 1,
	targetMax: 1,
	canTarget(g, _source, target) {
		return g.player(target).hand.length > 0;
	},
	async onEffect(g, ev, target) {
		const tp = g.player(target);
		if (tp.hand.length === 0) return;
		const shown = await g.askCards(
			target,
			'火攻：请展示一张手牌',
			tp.hand.map((id) => ({ id })),
			1,
			1,
			false,
		);
		const shownId = shown[0];
		if (shownId === undefined) return;
		const shownCard = g.card(shownId);
		g.pushLog({ kind: 'reveal', who: target, cards: [shownId] });

		const sp = g.player(ev.source);
		const matching = sp.hand.filter((id) => g.card(id).suit === shownCard.suit);
		if (matching.length === 0) return;
		const chosen = await g.askCards(
			ev.source,
			'火攻：可弃置一张与展示的牌同花色的手牌，对目标造成1点火焰伤害',
			matching.map((id) => ({ id })),
			1,
			1,
			true,
		);
		if (chosen.length === 0) return;
		await g.discardCards(chosen, 'huogong', ev.source);
		await g.damage({ source: ev.source, target, amount: 1, nature: 'fire', card: ev.use });
	},
};

export const TRICK_CARDS: Record<string, CardDef> = {
	juedou,
	guohechaiqiao,
	shunshouqianyang,
	wuzhongshengyou,
	nanmanruqin,
	wanjianqifa,
	taoyuanjieyi,
	wugufengdeng,
	jiedaosharen,
	wuxiekeji,
	tiesuolianhuan,
	huogong,
};
