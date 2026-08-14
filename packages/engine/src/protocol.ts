/**
 * 引擎 ↔ 玩家的交互契约。
 *
 * 引擎跑到需要人做决定的地方就抛出一个 AskRequest 并挂起；玩家回一个 Decision，引擎继续。
 * 每个 Decision 都会追加进决策日志 —— 「种子 + 决策日志」即一局游戏的全部信息。
 *
 * 设计原则：AskRequest 必须自带足够信息让前端**不做规则推导**就能画出界面
 * （哪些牌可选、哪些人可选、选几张、能不能取消）。规则判断只发生在服务端。
 */

import type { CardUse, Nature, Suit } from './types.js';

// ─────────────────────────── 请求 ───────────────────────────

interface AskBase {
	/** 请求序号，从 0 递增。用于校验决策日志没有错位 */
	seq: number;
	/** 该谁做决定 */
	who: string;
	/** 界面上方提示语，如 "请使用一张【闪】" */
	prompt: string;
	/** 可以放弃/取消（响应类一般可以，弃牌类不行） */
	cancelable: boolean;
	/** 超时秒数，超时后按 defaultDecision 自动处理 */
	timeout: number;
}

/** 出牌阶段的主行动：出牌、发动主动技、或结束出牌阶段 */
export interface PlayPhaseAsk extends AskBase {
	kind: 'playPhase';
	/** 当前可用的出牌选项（引擎已算好合法性） */
	options: PlayOption[];
}

/**
 * 一个可执行的出牌动作。前端把它渲染成"选中这张牌后可以点哪些人"。
 * 每张可用的牌/每个可发动的技能各是一个 option。
 */
export interface PlayOption {
	/** 唯一标识，Decision 回传这个 */
	id: string;
	/** 打出后的效果牌名 */
	name: string;
	nature?: Nature;
	/** 需要消耗的实体牌（前端高亮这些手牌/装备） */
	cards: number[];
	/** 来自哪个技能（转化技/主动技） */
	viaSkill?: string;
	/** 目标选择规则 */
	targets: TargetSpec;
	/** 这是"重铸"而非"使用"：弃掉它换一张牌，不结算牌的效果 */
	recast?: boolean;
}

export interface TargetSpec {
	min: number;
	max: number;
	/** 可以合法选中的角色 id。前端只让点这些 */
	candidates: string[];
	/** 目标不由玩家指定（如南蛮入侵、五谷丰登） */
	auto?: boolean;
}

/** 需要打出/使用一张指定的牌来响应 */
export interface RespondAsk extends AskBase {
	kind: 'respond';
	/** 需要什么牌，如 'shan' / 'sha' / 'tao' / 'wuxie' / 'jiu' */
	need: string;
	/** 是"使用"还是"打出"。桃/酒是使用，闪/无懈是打出 */
	mode: 'use' | 'respond';
	/**
	 * 触发这次响应的牌（前端展示"XX对你使用了【杀】"）。
	 * target 是这张牌当前正在结算的对象 —— 问【无懈可击】时必须带上，
	 * 否则应答方（人或 AI）根本不知道自己在救谁。
	 */
	trigger?: { source?: string; use: CardUse; target?: string };
	/** 可用的响应选项（含转化技，如龙胆把杀当闪） */
	options: PlayOption[];
}

/** 弃牌 */
export interface DiscardAsk extends AskBase {
	kind: 'discard';
	min: number;
	max: number;
	/** 可弃的牌 id */
	candidates: number[];
	/** 是否包含装备区 */
	includeEquip: boolean;
}

/** 从指定牌里选若干张（过河拆桥、五谷丰登、遗计…） */
export interface ChooseCardsAsk extends AskBase {
	kind: 'chooseCards';
	min: number;
	max: number;
	/** 可选牌。unknown=true 表示牌面对该玩家不可见（背面朝上，如选别人手牌） */
	candidates: Array<{ id: number; unknown?: boolean; from?: string; zone?: string }>;
}

/** 选角色 */
export interface ChoosePlayersAsk extends AskBase {
	kind: 'choosePlayers';
	min: number;
	max: number;
	candidates: string[];
}

/** 多选一（刚烈：弃两张牌 or 失去1点体力） */
export interface ChooseOptionAsk extends AskBase {
	kind: 'chooseOption';
	options: Array<{ id: string; label: string; disabled?: boolean }>;
}

/** 是否发动技能 */
export interface ConfirmSkillAsk extends AskBase {
	kind: 'confirmSkill';
	skill: string;
	skillName: string;
}

/** 选一个花色（反间） */
export interface ChooseSuitAsk extends AskBase {
	kind: 'chooseSuit';
	options: Suit[];
}

/** 排列牌堆顶若干张（观星） */
export interface ArrangeAsk extends AskBase {
	kind: 'arrange';
	cards: number[];
	/** 两个区：牌堆顶 / 牌堆底 */
	topLabel: string;
	bottomLabel: string;
	maxTop: number;
}

/** 把若干张牌分配给若干角色（遗计） */
export interface DistributeAsk extends AskBase {
	kind: 'distribute';
	cards: number[];
	candidates: string[];
}

export type AskRequest =
	| PlayPhaseAsk
	| RespondAsk
	| DiscardAsk
	| ChooseCardsAsk
	| ChoosePlayersAsk
	| ChooseOptionAsk
	| ConfirmSkillAsk
	| ChooseSuitAsk
	| ArrangeAsk
	| DistributeAsk;

/**
 * 普通 Omit 作用在联合类型上会塌缩成公共属性，把各分支自己的字段吃掉。
 * 这里按分支分配后再 Omit，保住每个 Ask 的独有字段。
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 引擎内部构造请求时用（seq 由引擎分配） */
export type AskInput = DistributiveOmit<AskRequest, 'seq'>;

// ─────────────────────────── 应答 ───────────────────────────

export type DecisionPayload =
	/** playPhase / respond：选中的 option 与目标；null = 放弃/结束出牌阶段 */
	| { type: 'play'; optionId: string; targets: string[] }
	| { type: 'pass' }
	| { type: 'cards'; cards: number[] }
	| { type: 'players'; players: string[] }
	| { type: 'option'; optionId: string }
	| { type: 'confirm'; yes: boolean }
	| { type: 'suit'; suit: Suit }
	| { type: 'arrange'; top: number[]; bottom: number[] }
	| { type: 'distribute'; assign: Array<{ card: number; to: string }> };

/**
 * 决策日志的一条。这就是整局游戏的可重放记录。
 * seq 必须和当时的 AskRequest.seq 对上，否则说明重放错位，直接抛错而不是将错就错。
 */
export interface Decision {
	seq: number;
	who: string;
	payload: DecisionPayload;
	/** 由超时/托管自动生成 */
	auto?: boolean;
	/** 服务器接收时间戳，仅用于回放展示，不参与逻辑 */
	at?: number;
}

// ─────────────────────────── 对局记录 ───────────────────────────

/** 一局游戏的完整定义。有这个就能精确重建任意时刻的状态 */
export interface GameRecord {
	seed: number;
	setup: GameSetup;
	decisions: Decision[];
}

export interface GameSetup {
	mode: 'identity';
	players: Array<{ id: string; nickname: string }>;
	/** 可选：固定武将，用于测试。不给则走选将流程 */
	generals?: Record<string, string>;
	/** 可选：固定身份，用于测试 */
	identities?: Record<string, string>;
	/** 启用的卡牌包 */
	packs: string[];
}
