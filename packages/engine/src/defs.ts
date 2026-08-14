/**
 * 卡牌与技能的注册表契约。所有卡牌 / 武将实现都写成这两个接口的实例。
 *
 * 这些对象是**静态注册表**，不进 GameState，所以允许带函数。
 */

import type { Game } from './game.js';
import type {
	Card,
	CardType,
	DamageEvent,
	EquipSlot,
	Faction,
	Gender,
	JudgeEvent,
	Nature,
	PlayerState,
	Timing,
	UseEvent,
} from './types.js';

// ─────────────────────────── 卡牌 ───────────────────────────

export interface CardDef {
	/** 拼音 id，与图片文件名一致 */
	name: string;
	/** 中文名，用于界面和日志 */
	cn: string;
	type: CardType;
	/** 装备槽位；延时锦囊为 'delayed' */
	subtype?: EquipSlot | 'delayed';
	nature?: Nature;

	/** 目标数量。max 为 'all' 表示所有合法目标（南蛮入侵、万箭齐发、五谷丰登） */
	targetMin?: number;
	targetMax?: number | 'all';

	/** 目标是否受攻击范围限制（【杀】为 true） */
	useDistance?: boolean;

	/** 这张牌现在能不能用（不填=能）。例：【桃】只在自己受伤时能用 */
	canUse?(g: Game, source: string): boolean;

	/** 某个角色能不能被指定为目标（不填=能）。例：【杀】不能指向自己 */
	canTarget?(g: Game, source: string, target: string, use: UseEvent): boolean;

	/** 是否可以被【无懈可击】响应。锦囊默认 true，基本牌/装备默认 false */
	wuxieable?: boolean;

	/**
	 * 可重铸：出牌阶段可以弃置它并摸一张牌，次数不限。
	 * 军争标准里只有【铁索连环】有这个属性 —— 没有它铁索在多数局面是死牌。
	 */
	recastable?: boolean;

	/** 使用时（指定目标后、逐个结算前）触发一次 */
	onUse?(g: Game, ev: UseEvent): Promise<void>;

	/** 对单个目标结算 */
	onEffect?(g: Game, ev: UseEvent, target: string): Promise<void>;

	// ── 装备牌 ──
	/** 攻击范围（武器） */
	range?: number;
	/** 装备附带的技能 id */
	equipSkill?: string;

	// ── 延时锦囊 ──
	delayed?: {
		/** 判定生效条件，返回 true 表示"中招" */
		check(card: Card): boolean;
		/** 中招时的效果 */
		onHit(g: Game, who: string, ev: JudgeEvent): Promise<void>;
		/** 未中招时的效果（闪电要传给下家，所以未中招也有事做） */
		onMiss?(g: Game, who: string, ev: JudgeEvent): Promise<void>;
	};
}

// ─────────────────────────── 技能 ───────────────────────────

export type SkillTag =
	/** 锁定技：满足条件必须发动，不询问 */
	| 'locked'
	/** 主公技 */
	| 'lord'
	/** 限定技：整局一次 */
	| 'limit'
	/** 觉醒技 */
	| 'awaken'
	/** 装备技能，随装备存在 */
	| 'equip';

export interface TriggerSpec {
	timing: Timing;
	/**
	 * 注意：这里**没有** scope 字段。
	 * 不同时机的事件载荷形状不同（有的是 ev.who、有的是 ev.target/ev.source），
	 * 没法用一个通用规则判断"事件主体是不是技能拥有者"。所以监听范围一律由
	 * 各技能自己在 can() 里写清楚 —— 只关心自己就判 `ev.target === self.id`，
	 * 要管别人的（如鬼才改判定）就不判。
	 */
	/** 优先级，大的先触发。默认 0 */
	priority?: number;
	/** 能否触发 */
	can(g: Game, self: PlayerState, ev: any): boolean;
	/** 触发效果 */
	run(g: Game, self: PlayerState, ev: any): Promise<void>;
}

export interface ActiveSpec {
	/**
	 * 次数限制：
	 *  'turn'  每回合一次（出牌阶段限一次）
	 *  'round' 每轮一次
	 *  'game'  整局一次
	 *  数字    每回合 n 次
	 */
	limit?: 'turn' | 'round' | 'game' | number;
	/** 现在能不能发动 */
	can(g: Game, self: PlayerState): boolean;
	/** 发动效果。目标与选牌由技能自己通过 g.ask* 询问 */
	run(g: Game, self: PlayerState): Promise<void>;
}

export interface ConvertSpec {
	/** 能转化成什么牌。返回牌名列表 */
	to: string[];
	nature?: Nature;
	/** 使用场合：'use' 出牌阶段主动使用，'respond' 被动打出 */
	usage: Array<'use' | 'respond'>;
	/** 需要几张实体牌，默认 1 */
	count?: number;
	/** 哪些牌能被转化 */
	filter(g: Game, self: PlayerState, card: Card): boolean;
	/** 额外的可用性判断（如急救只在回合外） */
	can?(g: Game, self: PlayerState): boolean;
	/** 可用的牌来自哪些区域，默认 ['hand'] */
	from?: Array<'hand' | 'equip'>;
}

/**
 * 规则修正器。用于"锁定技改变规则"这一类技能 —— 它们不在某个时机触发，
 * 而是持续改变引擎的计算结果（距离、次数上限、目标合法性、伤害值…）。
 * 每个钩子都是纯函数，引擎在对应计算点收集所有存活角色的修正器依次应用。
 */
export interface ModSpec {
	/** 自己到他人的距离修正（马术 -1） */
	distanceFrom?(g: Game, self: PlayerState, to: PlayerState): number;
	/** 他人到自己的距离修正 */
	distanceTo?(g: Game, self: PlayerState, from: PlayerState): number;
	/** 出牌阶段【杀】的使用次数上限。返回 Infinity 表示无限（咆哮） */
	shaLimit?(g: Game, self: PlayerState, base: number): number;
	/** 能否成为某张牌的目标（空城、谦逊）。返回 false 则不能被指定 */
	targetable?(g: Game, self: PlayerState, use: UseEvent, source: string): boolean;
	/** 使用牌是否无视距离（奇才） */
	ignoreDistance?(g: Game, self: PlayerState, cardName: string): boolean;
	/** 需要几张【闪】才能抵消【杀】（无双） */
	shanNeeded?(g: Game, self: PlayerState, ev: UseEvent, base: number): number;
	/** 【决斗】需要几张【杀】（无双） */
	shaNeededInDuel?(g: Game, self: PlayerState, base: number): number;
	/** 伤害值修正（裸衣 +1） */
	damageBonus?(g: Game, self: PlayerState, ev: DamageEvent): number;
	/** 手牌上限修正（默认为当前体力值） */
	handLimit?(g: Game, self: PlayerState, base: number): number;
}

export interface SkillDef {
	/** 拼音 id */
	id: string;
	/** 中文名 */
	cn: string;
	/** 技能描述，展示用 */
	desc: string;
	tags?: SkillTag[];

	triggers?: TriggerSpec[];
	active?: ActiveSpec;
	convert?: ConvertSpec;
	mods?: ModSpec;
}

// ─────────────────────────── 武将 ───────────────────────────

export interface GeneralDef {
	/** 拼音 id，与立绘文件名一致（如 'caocao' → art/character/caocao.webp） */
	id: string;
	cn: string;
	faction: Faction;
	gender: Gender;
	maxHp: number;
	skills: string[];
	/** 所属卡牌包 */
	pack: string;
}
