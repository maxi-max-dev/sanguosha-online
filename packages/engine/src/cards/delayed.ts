/**
 * 延时锦囊（3 张）：乐不思蜀 / 闪电 / 兵粮寸断。
 *
 * 这三张牌打出后不结算 onEffect，而是被 useCard() 直接放进目标的判定区，
 * 到目标自己的判定阶段由 game.ts 的 judgePhase() 统一摸牌判定、调用 delayed.check/onHit/onMiss。
 *
 * 乐不思蜀/兵粮寸断中招后要"跳过下一个阶段"，但 PhaseEvent.skipped 只能在 'phaseStart'
 * 时机的触发器里改——而判定阶段结算发生在出牌/摸牌阶段的 PhaseEvent 造出来之前，delayed.onHit
 * 拿不到那个未来的 PhaseEvent。所以这里借道一个跨两张牌共用的"内部标记技能"
 * （定义在 skills/equip.ts 的 DELAYED_PHASE_SKIP，onHit 时挂到目标身上）来搭桥，
 * 不然没法在不碰 game.ts 的前提下实现"这一次判定命中，影响的是之后才发生的另一个阶段"。
 */
import type { CardDef } from '../defs.js';
import { DELAYED_PHASE_SKIP_SKILL } from '../skills/equip.js';

/** 命中后跳过 `phase` 阶段：把桥接技能挂上去（幂等）+ 置位对应 flag */
function markSkipPhase(g: import('../game.js').Game, who: string, phase: 'draw' | 'play'): void {
	const p = g.player(who);
	if (!p.skills.includes(DELAYED_PHASE_SKIP_SKILL)) p.skills.push(DELAYED_PHASE_SKIP_SKILL);
	g.setFlag(who, `skipPhase:${phase}`, 1);
}

export const lebusishu: CardDef = {
	name: 'lebusishu',
	cn: '乐不思蜀',
	type: 'trick',
	subtype: 'delayed',
	targetMin: 1,
	targetMax: 1,
	canTarget(_g, source, target) {
		return target !== source;
	},
	delayed: {
		check(card) {
			return card.suit !== 'heart';
		},
		async onHit(g, who) {
			markSkipPhase(g, who, 'play');
		},
	},
};

export const shandian: CardDef = {
	name: 'shandian',
	cn: '闪电',
	type: 'trick',
	subtype: 'delayed',
	targetMin: 1,
	targetMax: 1,
	canTarget(_g, source, target) {
		return target === source;
	},
	delayed: {
		check(card) {
			return card.suit === 'spade' && card.number >= 2 && card.number <= 9;
		},
		async onHit(g, who) {
			await g.damage({ target: who, amount: 3, nature: 'thunder' });
		},
		async onMiss(g, who) {
			// 闪电本体此刻应该还躺在处理区（judgePhase 在判定前把它挪过去的），按牌名找回来
			const id = g.state.processing.find((cid) => g.card(cid).name === 'shandian');
			if (id === undefined) return;
			const next = g.othersFrom(who)[0];
			if (!next) {
				await g.discardCards([id], 'shandian-nowhere');
				return;
			}
			await g.moveCards([id], { zone: 'judge', owner: next.id }, 'shandian-pass');
		},
	},
};

export const bingliangcunduan: CardDef = {
	name: 'bingliangcunduan',
	cn: '兵粮寸断',
	type: 'trick',
	subtype: 'delayed',
	targetMin: 1,
	targetMax: 1,
	canTarget(g, source, target) {
		return target !== source && g.distance(source, target) === 1;
	},
	delayed: {
		check(card) {
			return card.suit !== 'club';
		},
		async onHit(g, who) {
			markSkipPhase(g, who, 'draw');
		},
	},
};

export const DELAYED_CARDS: Record<string, CardDef> = {
	lebusishu,
	shandian,
	bingliangcunduan,
};
