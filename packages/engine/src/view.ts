/**
 * 按玩家视角裁剪游戏状态。
 *
 * 这是防作弊的唯一边界：**服务端永远只发这个函数的输出**，绝不把 GameState 原样广播。
 * 别人的手牌只给 id 不给牌面（`cards` 字典里不放该条目），前端照样能用 id 做进出场动画，
 * 但拿不到花色点数。id 与牌面的映射每局随种子重新随机（见 game.ts 的 initState），
 * 所以知道 id 也推不出是什么牌。
 */

import type { AskRequest, GameSetup } from './protocol.js';
import type {
	Card,
	EquipSlot,
	GameState,
	Identity,
	Phase,
} from './types.js';

/** 发给客户端的角色视图 */
export interface PlayerView {
	id: string;
	seat: number;
	nickname: string;
	general: string;
	faction: string;
	gender: string;
	maxHp: number;
	hp: number;
	/** 手牌数量恒可见 */
	handCount: number;
	/** 手牌 id：只有自己（和已公开的牌）能拿到 */
	hand?: number[];
	equip: Partial<Record<EquipSlot, number>>;
	judge: number[];
	alive: boolean;
	chained: boolean;
	turnedOver: boolean;
	skills: string[];
	/** 未公开时为 undefined */
	identity?: Identity;
	offline: boolean;
	/** 展示用标记（如"已发动过制衡"），不含隐藏信息 */
	marks: Record<string, number>;
}

export interface GameView {
	you: string;
	/** 局的模式——前端靠它决定要不要展示身份局专属 UI（身份徽标、目标引导…） */
	mode: GameSetup['mode'];
	players: PlayerView[];
	seating: string[];
	currentPlayer: string;
	phase: Phase;
	round: number;
	drawCount: number;
	discardTop: number[];
	processing: number[];
	/** 只包含该玩家有权看到牌面的牌 */
	cards: Record<number, Card>;
	finished?: GameState['finished'];
	/** 轮到你决策时才有值 */
	ask?: AskRequest;
}

/** 供前端做"展示用标记"的 flag 前缀白名单 —— 只有这些会被下发 */
const PUBLIC_FLAG_PREFIXES = ['turn:', 'round:', 'game:'];

function publicMarks(flags: Record<string, number | string | boolean>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(flags)) {
		if (!PUBLIC_FLAG_PREFIXES.some((p) => k.startsWith(p))) continue;
		if (typeof v === 'number') out[k] = v;
		else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
	}
	return out;
}

/**
 * @param viewerId 观察者。传 null 得到观战视角（所有人手牌都不可见）
 * @param revealAll 复盘/结束后用，公开全部信息
 */
export function buildView(
	state: GameState,
	viewerId: string | null,
	ask: AskRequest | undefined,
	/** 默认给身份局，测试里一大批老调用点不传这个参数也不用改 */
	mode: GameSetup['mode'] = 'identity',
	revealAll = false,
): GameView {
	const finished = !!state.finished;
	const showAll = revealAll || finished;

	/** 请求只发给当事人，别人不该知道"他正在被问什么"的细节 */
	const myAsk = ask && viewerId !== null && ask.who === viewerId ? ask : undefined;

	/** 该玩家有权看到牌面的牌 id */
	const visible = new Set<number>();

	// 公共信息：弃牌堆、处理区、所有人的装备区和判定区
	for (const id of state.discardPile) visible.add(id);
	for (const id of state.processing) visible.add(id);
	for (const p of state.players) {
		for (const id of Object.values(p.equip)) if (typeof id === 'number') visible.add(id);
		for (const id of p.judge) visible.add(id);
	}

	/*
	 * 观星这类"看牌堆顶再排回去"的技能，牌自始至终没离开牌堆（见 skills/shu.ts），
	 * 按上面的规则会被当成普通牌堆牌藏掉，当事人只能看到几张牌背——技能就废了。
	 * 所以给 arrange 开一个豁免：牌面只跟着 myAsk 走，和请求本身同一个门，
	 * 别人拿不到请求也就拿不到牌面。别处不要再加这种豁免，要加就加在这一个地方。
	 */
	if (myAsk?.kind === 'arrange') for (const id of myAsk.cards) visible.add(id);

	const players: PlayerView[] = state.players.map((p) => {
		const isSelf = viewerId !== null && p.id === viewerId;
		if (isSelf || showAll) for (const id of p.hand) visible.add(id);

		return {
			id: p.id,
			seat: p.seat,
			nickname: p.nickname,
			general: p.general,
			faction: p.faction,
			gender: p.gender,
			maxHp: p.maxHp,
			hp: p.hp,
			handCount: p.hand.length,
			hand: isSelf || showAll ? p.hand.slice() : undefined,
			equip: { ...p.equip },
			judge: p.judge.slice(),
			alive: p.alive,
			chained: p.chained,
			turnedOver: p.turnedOver,
			skills: p.skills.slice(),
			identity: p.identityRevealed || isSelf || showAll ? p.identity : undefined,
			offline: p.offline,
			marks: publicMarks(p.flags),
		};
	});

	const cards: Record<number, Card> = {};
	for (const id of visible) {
		const c = state.cards[id];
		if (c) cards[id] = c;
	}

	return {
		you: viewerId ?? '',
		mode,
		players,
		seating: state.seating.slice(),
		currentPlayer: state.currentPlayer,
		phase: state.phase,
		round: state.round,
		// 牌堆只给数量，不给内容
		drawCount: state.drawPile.length,
		discardTop: state.discardPile.slice(-6),
		processing: state.processing.slice(),
		cards,
		finished: state.finished,
		ask: myAsk,
	};
}

/**
 * 给非当事人用的"某人正在决策"提示（不含牌面等隐藏信息）。
 * 前端据此显示读秒条和"等待 XX 出牌"。
 */
export interface AskHint {
	who: string;
	kind: AskRequest['kind'];
	prompt: string;
	timeout: number;
}

export function askHint(ask: AskRequest | undefined): AskHint | undefined {
	if (!ask) return undefined;
	return { who: ask.who, kind: ask.kind, prompt: ask.prompt, timeout: ask.timeout };
}
