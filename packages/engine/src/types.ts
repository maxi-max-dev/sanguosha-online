/**
 * 三国杀领域模型。整个引擎的类型契约都在这里 —— 所有卡牌和武将实现都写在这套类型之上。
 *
 * 硬性约束：这里的每个类型都必须可 JSON 序列化。GameState 会被完整快照进 Durable Object，
 * 也会按玩家视角裁剪后发给前端，出现 Map/Set/函数/循环引用就会当场炸掉。
 * （函数只允许出现在 CardDef / SkillDef 这类静态注册表里，它们不进 GameState。）
 */

// ─────────────────────────── 牌 ───────────────────────────

export type Suit = 'heart' | 'diamond' | 'spade' | 'club';

export const RED_SUITS: readonly Suit[] = ['heart', 'diamond'];
export const BLACK_SUITS: readonly Suit[] = ['spade', 'club'];

export type Color = 'red' | 'black';

export function suitColor(suit: Suit): Color {
	return suit === 'heart' || suit === 'diamond' ? 'red' : 'black';
}

/** 伤害属性。undefined = 普通伤害 */
export type Nature = 'fire' | 'thunder' | undefined;

export type CardType = 'basic' | 'trick' | 'equip';

export type EquipSlot = 'weapon' | 'armor' | 'horsePlus' | 'horseMinus';

/**
 * 一张具体的牌（实例）。id 全局唯一且在一局内不变 —— 前端靠它做动画的 FLIP 追踪，
 * 引擎靠它区分"同名不同张"。
 */
export interface Card {
	id: number;
	/** 对应 CardDef 的 name，如 'sha' / 'shan' / 'qinglongyanyuedao' */
	name: string;
	suit: Suit;
	/** 1–13，A=1 J=11 Q=12 K=13 */
	number: number;
}

/**
 * 一次"使用/打出"。可能是实体牌，也可能是转化技造出来的虚拟牌
 * （武圣把红色牌当【杀】：name='sha'，cards=[那张红牌的 id]，viaSkill='wusheng'）。
 */
export interface CardUse {
	/** 生效的牌名 */
	name: string;
	nature?: Nature;
	/** 底下的实体牌 id。转化技可能是 0 张（无中生有类技能）或多张 */
	cards: number[];
	/** 由哪个技能转化而来 */
	viaSkill?: string;
	/** 虚拟牌的花色/点数：单张转化时继承原牌，多张时为 undefined */
	suit?: Suit;
	number?: number;
}

// ─────────────────────────── 区域 ───────────────────────────

/** 牌所在的区域。牌的移动全部走 moveCards()，不允许直接改数组 */
export type Zone =
	| 'hand'
	| 'equip'
	| 'judge'
	| 'draw'
	| 'discard'
	/** 处理区：正在结算的牌暂存于此，防止被"获得牌"类技能提前偷走 */
	| 'processing';

export interface CardLocation {
	zone: Zone;
	/** hand/equip/judge 时为角色 id */
	owner?: string;
}

// ─────────────────────────── 角色 ───────────────────────────

export type Faction = 'wei' | 'shu' | 'wu' | 'qun';
export type Gender = 'male' | 'female';

/** 身份局身份 */
export type Identity = 'lord' | 'loyalist' | 'rebel' | 'spy';

export interface PlayerState {
	id: string;
	/** 座次，0 起。主公恒为 0 */
	seat: number;
	nickname: string;

	general: string;
	faction: Faction;
	gender: Gender;

	identity: Identity;
	/** 主公开局即明置；其余角色死亡时翻开 */
	identityRevealed: boolean;

	maxHp: number;
	hp: number;

	hand: number[];
	equip: Partial<Record<EquipSlot, number>>;
	/** 判定区，先进先出结算（后置入的先判定：实际按栈顶→栈底，见 judgePhase） */
	judge: number[];

	alive: boolean;
	/** 横置（铁索连环） */
	chained: boolean;
	/** 翻面（本回合跳过） */
	turnedOver: boolean;

	skills: string[];
	/** 已失效/被废除的技能 */
	disabledSkills: string[];

	/**
	 * 技能计数与临时标记。
	 * 约定前缀：turn: 回合结束清空 / round: 一轮结束清空 / game: 整局保留
	 * 例：flags['turn:zhiheng'] = 1
	 */
	flags: Record<string, number | string | boolean>;

	/** 掉线中（自动托管） */
	offline: boolean;
}

// ─────────────────────────── 阶段与回合 ───────────────────────────

export type Phase =
	| 'start'
	| 'judge'
	| 'draw'
	| 'play'
	| 'discard'
	| 'end';

export const PHASE_ORDER: readonly Phase[] = ['start', 'judge', 'draw', 'play', 'discard', 'end'];

// ─────────────────────────── 游戏状态 ───────────────────────────

export interface GameState {
	/** 所有牌的静态信息，id -> Card。开局生成后不再变动 */
	cards: Record<number, Card>;
	/** id -> 当前所在区域。这是牌位置的唯一真相 */
	locations: Record<number, CardLocation>;

	players: PlayerState[];
	/** 座次顺序的玩家 id（按 seat 排好） */
	seating: string[];

	drawPile: number[];
	discardPile: number[];
	/** 正在结算的牌 */
	processing: number[];

	/** 当前回合角色 id */
	currentPlayer: string;
	phase: Phase;
	/** 第几轮（所有存活角色各行动一次为一轮） */
	round: number;

	finished?: {
		winners: string[];
		/** 胜利方描述，如 '反贼胜' */
		reason: string;
	};

	/** 牌堆洗牌次数。用尽三次仍无牌可摸则判平局，防死循环 */
	reshuffles: number;
}

// ─────────────────────────── 事件时机 ───────────────────────────

/**
 * 技能触发时机。三国杀所有技能本质都是"在某个时机做点什么"，
 * 这张表就是技能能挂载的全部钩子。加新时机必须同时在 game.ts 里补上 trigger 调用点。
 */
export type Timing =
	// 全局
	| 'gameStart'
	// 回合
	| 'turnStart'
	| 'turnEnd'
	| 'phaseStart'
	| 'phaseEnd'
	// 摸牌数修正（摸牌阶段专用，可改摸牌张数或整个替换摸牌）
	| 'drawPhaseNum'
	// 用牌
	| 'beforeUse'
	| 'onUse'
	| 'onTargetChosen'
	| 'onBecomeTarget'
	| 'onEffectStart'
	| 'onEffectEnd'
	| 'afterUse'
	// 打出（响应）
	| 'onRespond'
	/** 求牌之前。技能可在此代为响应（护驾/激将），或直接改写结果 */
	| 'beforeAskForCard'
	// 伤害链
	| 'beforeDamage'
	| 'onDamage'
	| 'afterDamage'
	| 'afterDamaged'
	// 体力
	| 'onLoseHp'
	/** 回复生效前，可改回复量（救援） */
	| 'beforeRecover'
	| 'onRecover'
	| 'onDying'
	| 'onDie'
	// 判定
	| 'beforeJudgeEffect'
	| 'afterJudgeEffect'
	// 得失牌
	| 'onGainCards'
	| 'onLoseCards'
	| 'afterLoseCards';

// ─────────────────────────── 事件载荷 ───────────────────────────

export interface UseEvent {
	source: string;
	use: CardUse;
	targets: string[];
	/** 已被【无懈可击】抵消 */
	negated?: boolean;
	/** 对特定目标无效（如流离转移后、被仁王盾挡下） */
	cancelledFor?: string[];
	/** 当前正在结算的目标 */
	currentTarget?: string;
	/** 本次使用不计入次数限制 */
	noCount?: boolean;
	/**
	 * 这些目标不能用【闪】响应（铁骑）。
	 * 做成结构化字段而不是字符串 flag，是为了让【杀】的实现和技能实现之间
	 * 有一个类型可查的契约，避免两边各写各的 key。
	 */
	unavoidableFor?: string[];
}

export interface DamageEvent {
	source?: string;
	target: string;
	amount: number;
	nature: Nature;
	/** 伤害来源的牌（如【杀】），用于奸雄/反馈这类"获得造成伤害的牌" */
	card?: CardUse;
	/** 铁索连环传导中，避免无限循环 */
	chainReaction?: boolean;
	cancelled?: boolean;
}

export interface RecoverEvent {
	source?: string;
	target: string;
	amount: number;
	card?: CardUse;
}

export interface JudgeEvent {
	who: string;
	/** 判定原因：延时锦囊名或技能 id */
	reason: string;
	card?: Card;
	/** 判定是否"成功"，由 reason 对应的 check 决定 */
	result?: boolean;
}

export interface DyingEvent {
	who: string;
	/** 由谁的行为导致濒死 */
	source?: string;
	rescued?: boolean;
}

export interface CardMoveEvent {
	cards: number[];
	from: CardLocation;
	to: CardLocation;
	/** 移动原因，技能可据此判断（如枭姬看 'equip' 失去） */
	reason: string;
	source?: string;
}

export interface PhaseEvent {
	who: string;
	phase: Phase;
	/** 置 true 可跳过该阶段（克己跳弃牌阶段） */
	skipped?: boolean;
}

export interface DrawNumEvent {
	who: string;
	num: number;
	/** 置 true 表示摸牌被技能整个替换掉（突袭） */
	replaced?: boolean;
}

/** 所有事件的联合，trigger() 的载荷 */
export type GameEvent =
	| UseEvent
	| DamageEvent
	| RecoverEvent
	| JudgeEvent
	| DyingEvent
	| CardMoveEvent
	| PhaseEvent
	| DrawNumEvent
	| Record<string, unknown>;
