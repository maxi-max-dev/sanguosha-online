/**
 * 游戏引擎核心。
 *
 * ## 为什么这样设计
 *
 * 游戏流程用普通的 async/await 写（`await this.askForCard(p, 'shan')`），因为三国杀的结算
 * 天然是嵌套的 —— 杀→闪→技能→判定→再触发，锦囊→无懈→无懈→……写成显式状态机会失控。
 *
 * 但 async 调用栈没法序列化，而 Durable Object 随时会休眠。解决办法是**事件溯源**：
 * 一局游戏 = 种子 + 决策日志。ask() 有两个模式 ——
 *   · 重放模式：日志里还有没消费的决策，直接返回，瞬间跑回原位
 *   · 实时模式：日志耗尽，挂起 Promise 等真人输入
 * 于是 DO 唤醒时只要 `new Game(record)` 重放一遍就回到断点，断线重连、观战回放、
 * bug 精确复现全部免费得到。
 *
 * 代价是引擎里**不允许有任何日志外的随机性和副作用**：所有随机走 this.rng，
 * 所有玩家输入走 this.ask。这条守住了，重放就是精确的。
 */

import type { CardDef, GeneralDef, SkillDef } from './defs.js';
import { Rng } from './rng.js';
import type {
	AskInput,
	AskRequest,
	Decision,
	DecisionPayload,
	GameRecord,
	GameSetup,
	PlayOption,
} from './protocol.js';
import {
	PHASE_ORDER,
	type Card,
	type CardLocation,
	type CardMoveEvent,
	type CardUse,
	type DamageEvent,
	type DyingEvent,
	type EquipSlot,
	type GameState,
	type JudgeEvent,
	type Phase,
	type PhaseEvent,
	type PlayerState,
	type RecoverEvent,
	type Suit,
	type Timing,
	type UseEvent,
} from './types.js';

export interface Registry {
	cards: Record<string, CardDef>;
	skills: Record<string, SkillDef>;
	generals: Record<string, GeneralDef>;
	/** 构建牌堆：返回所有牌的静态定义 */
	buildDeck(packs: string[]): Array<Omit<Card, 'id'>>;
}

/** 面向前端的可见事件（用于播动画和战报），不参与规则 */
export interface LogEntry {
	t: number;
	kind: string;
	[k: string]: unknown;
}

/** 'beforeAskForCard' 的载荷。技能写入 use 即代表"由我代为响应" */
export interface AskForCardEvent {
	who: string;
	need: string;
	mode: 'use' | 'respond';
	trigger?: { source?: string; use: CardUse };
	use?: CardUse;
}

/** 合法动作枚举器。实现见 options.ts，构造后注入以打断模块循环依赖 */
export interface OptionProvider {
	play(g: Game, who: string): PlayOption[];
	respond(g: Game, who: string, need: string, mode: 'use' | 'respond', ev?: UseEvent): PlayOption[];
	rescue(g: Game, rescuer: string, dying: string): PlayOption[];
}

export class GameOver extends Error {
	constructor(public winners: string[], public reason: string) {
		super(reason);
	}
}

/** 重放时决策日志与请求对不上 —— 说明有 bug，必须炸而不是将错就错 */
export class ReplayDesyncError extends Error {}

export class Game {
	readonly state: GameState;
	readonly rng: Rng;
	readonly registry: Registry;
	readonly setup: GameSetup;
	readonly seed: number;

	/** 决策日志。这就是这局游戏的全部历史 */
	readonly decisions: Decision[] = [];
	/** 重放游标：cursor < decisions.length 时处于重放模式 */
	private cursor = 0;
	/** 请求序号 */
	private seq = 0;

	private pending?: {
		req: AskRequest;
		resolve: (p: DecisionPayload) => void;
		reject: (e: unknown) => void;
	};

	private idleWaiters: Array<() => void> = [];
	private started = false;

	/** 可见事件日志，用于前端动画。重放时不重复推送（由 replaying 判断） */
	log: LogEntry[] = [];
	private logSeq = 0;

	constructor(record: GameRecord, registry: Registry) {
		this.seed = record.seed;
		this.rng = new Rng(record.seed);
		this.registry = registry;
		this.setup = record.setup;
		this.decisions.push(...record.decisions);
		this.state = this.initState();
	}

	/** 当前是否在重放已有决策（重放时不应产生对外的副作用，如推送动画） */
	get replaying(): boolean {
		return this.cursor < this.decisions.length;
	}

	// ─────────────────────── 初始化 ───────────────────────

	private initState(): GameState {
		// 先打乱牌的定义再分配 id，让 id → 牌面的映射每局都不同。
		// 否则 id 就是按固定的牌堆构建顺序分配的，客户端只要知道构建顺序
		// 就能从"别人手牌的 id"反推出牌面 —— 视角裁剪会被绕过去。
		const defs = this.rng.shuffle(this.registry.buildDeck(this.setup.packs));
		const cards: Record<number, Card> = {};
		const locations: Record<number, CardLocation> = {};
		const ids: number[] = [];
		defs.forEach((d, i) => {
			const id = i + 1;
			cards[id] = { id, ...d };
			locations[id] = { zone: 'draw' };
			ids.push(id);
		});
		this.rng.shuffle(ids);

		return {
			cards,
			locations,
			players: [],
			seating: [],
			drawPile: ids,
			discardPile: [],
			processing: [],
			currentPlayer: '',
			phase: 'start',
			round: 0,
			reshuffles: 0,
		};
	}

	// ─────────────────────── ask 机制 ───────────────────────

	/**
	 * 引擎的唯一输入口。重放模式下从日志读，实时模式下挂起等玩家。
	 */
	async ask(req: AskInput): Promise<DecisionPayload> {
		// 胜负已分时立刻抛出，让还在栈上的结算流程整体退栈，
		// 而不是继续追问已经结束的对局。
		if (this.state.finished) {
			throw new GameOver(this.state.finished.winners, this.state.finished.reason);
		}
		const full = { ...req, seq: this.seq++ } as AskRequest;

		if (this.cursor < this.decisions.length) {
			const d = this.decisions[this.cursor++];
			if (d.seq !== full.seq) {
				throw new ReplayDesyncError(
					`决策日志错位：期望 seq=${full.seq}(${full.kind}/${full.who})，日志是 seq=${d.seq}(${d.who})`,
				);
			}
			if (d.who !== full.who) {
				throw new ReplayDesyncError(
					`决策日志错位：seq=${full.seq} 期望 ${full.who} 决策，日志是 ${d.who}`,
				);
			}
			return d.payload;
		}

		return new Promise<DecisionPayload>((resolve, reject) => {
			this.pending = { req: full, resolve, reject };
			this.notifyIdle();
		});
	}

	/** 当前待玩家处理的请求；undefined 表示引擎正在跑或已结束 */
	getPendingAsk(): AskRequest | undefined {
		return this.pending?.req;
	}

	/**
	 * 提交一个决策，引擎继续跑到下一个 ask。
	 * 返回时保证引擎已停在下一个请求上（或游戏已结束）。
	 */
	/**
	 * @param wait 传 false 则只投递决策就返回，不等引擎 settle。
	 * 只有在**没有 runGame() 驱动**的场景才需要（例如单测里直接调 `g.damage()` 再逐个喂请求）：
	 * 那种情况下结算跑完既不会产生新请求也不会 finish，waitIdle() 会永远挂住。
	 */
	async submit(who: string, payload: DecisionPayload, wait = true): Promise<void> {
		const p = this.pending;
		if (!p) throw new Error('当前没有待处理的请求');
		if (p.req.who !== who) throw new Error(`该 ${p.req.who} 决策，不是 ${who}`);

		this.pending = undefined;
		this.decisions.push({ seq: p.req.seq, who, payload, at: Date.now() });
		this.cursor = this.decisions.length;
		p.resolve(payload);
		if (wait) await this.waitIdle();
	}

	/** 超时/掉线时按引擎给的安全默认值自动决策 */
	async submitAuto(): Promise<void> {
		const p = this.pending;
		if (!p) return;
		const payload = defaultDecision(p.req);
		const who = p.req.who;
		this.pending = undefined;
		this.decisions.push({ seq: p.req.seq, who, payload, auto: true, at: Date.now() });
		this.cursor = this.decisions.length;
		p.resolve(payload);
		await this.waitIdle();
	}

	/** 等引擎跑到"需要输入"或"已结束"为止 */
	waitIdle(): Promise<void> {
		if (this.pending || this.state.finished) return Promise.resolve();
		return new Promise((r) => this.idleWaiters.push(r));
	}

	private notifyIdle(): void {
		const ws = this.idleWaiters;
		this.idleWaiters = [];
		for (const w of ws) w();
	}

	// ─────────────────────── ask 便捷封装 ───────────────────────

	async askConfirm(who: string, skill: string, prompt?: string): Promise<boolean> {
		const def = this.registry.skills[skill];
		const r = await this.ask({
			kind: 'confirmSkill',
			who,
			skill,
			skillName: def?.cn ?? skill,
			prompt: prompt ?? `是否发动【${def?.cn ?? skill}】？`,
			cancelable: true,
			timeout: 20,
		});
		return r.type === 'confirm' ? r.yes : false;
	}

	async askOption(
		who: string,
		prompt: string,
		options: Array<{ id: string; label: string; disabled?: boolean }>,
		cancelable = false,
		timeout = 25,
	): Promise<string | null> {
		const r = await this.ask({ kind: 'chooseOption', who, prompt, options, cancelable, timeout });
		if (r.type === 'option') return r.optionId;
		return null;
	}

	async askPlayers(
		who: string,
		prompt: string,
		candidates: string[],
		min = 1,
		max = 1,
		cancelable = false,
	): Promise<string[]> {
		if (candidates.length === 0) return [];
		const r = await this.ask({
			kind: 'choosePlayers',
			who,
			prompt,
			candidates,
			min,
			max,
			cancelable,
			timeout: 25,
		});
		if (r.type !== 'players') return [];
		// 防御：客户端可能传非法值，这里做最终裁决
		const valid = r.players.filter((p) => candidates.includes(p)).slice(0, max);
		return valid.length >= min ? valid : cancelable ? [] : candidates.slice(0, min);
	}

	async askCards(
		who: string,
		prompt: string,
		candidates: Array<{ id: number; unknown?: boolean; from?: string; zone?: string }>,
		min = 1,
		max = 1,
		cancelable = false,
	): Promise<number[]> {
		if (candidates.length === 0) return [];
		const r = await this.ask({
			kind: 'chooseCards',
			who,
			prompt,
			candidates,
			min,
			max,
			cancelable,
			timeout: 25,
		});
		const ids = candidates.map((c) => c.id);
		if (r.type !== 'cards') return cancelable ? [] : ids.slice(0, min);
		const valid = r.cards.filter((c) => ids.includes(c)).slice(0, max);
		return valid.length >= min ? valid : cancelable ? [] : ids.slice(0, min);
	}

	async askSuit(who: string, prompt: string): Promise<Suit> {
		const r = await this.ask({
			kind: 'chooseSuit',
			who,
			prompt,
			options: ['heart', 'diamond', 'spade', 'club'],
			cancelable: false,
			timeout: 20,
		});
		return r.type === 'suit' ? r.suit : 'heart';
	}

	// ─────────────────────── 状态访问 ───────────────────────

	player(id: string): PlayerState {
		const p = this.state.players.find((x) => x.id === id);
		if (!p) throw new Error(`没有这个角色: ${id}`);
		return p;
	}

	card(id: number): Card {
		return this.state.cards[id];
	}

	cardDef(name: string): CardDef {
		const d = this.registry.cards[name];
		if (!d) throw new Error(`未注册的牌: ${name}`);
		return d;
	}

	alivePlayers(): PlayerState[] {
		return this.state.players.filter((p) => p.alive);
	}

	/** 从 from 开始（含）按座次顺序的存活角色。不传则从当前回合角色开始 */
	playersFrom(from?: string): PlayerState[] {
		const alive = this.alivePlayers().slice().sort((a, b) => a.seat - b.seat);
		if (alive.length === 0) return [];
		const startId = from ?? this.state.currentPlayer;
		let idx = alive.findIndex((p) => p.id === startId);
		if (idx < 0) {
			// 起点已死（如濒死结算中途死亡），退化为按座次找下一个
			const seat = this.state.players.find((p) => p.id === startId)?.seat ?? 0;
			idx = alive.findIndex((p) => p.seat >= seat);
			if (idx < 0) idx = 0;
		}
		return [...alive.slice(idx), ...alive.slice(0, idx)];
	}

	/** 其他存活角色，按座次顺序（从 self 的下家开始） */
	othersFrom(self: string): PlayerState[] {
		return this.playersFrom(self).filter((p) => p.id !== self);
	}

	/** 收集所有存活角色身上生效的规则修正器 */
	private mods(): Array<{ p: PlayerState; skill: SkillDef }> {
		const out: Array<{ p: PlayerState; skill: SkillDef }> = [];
		for (const p of this.alivePlayers()) {
			for (const sid of p.skills) {
				if (p.disabledSkills.includes(sid)) continue;
				const s = this.registry.skills[sid];
				if (s?.mods) out.push({ p, skill: s });
			}
		}
		return out;
	}

	/** 座位距离（较短的一侧），再叠加马匹与技能修正，最小为 1 */
	distance(fromId: string, toId: string): number {
		if (fromId === toId) return 0;
		const alive = this.alivePlayers().slice().sort((a, b) => a.seat - b.seat);
		const i = alive.findIndex((p) => p.id === fromId);
		const j = alive.findIndex((p) => p.id === toId);
		if (i < 0 || j < 0) return Infinity;
		const raw = Math.abs(i - j);
		let d = Math.min(raw, alive.length - raw);

		const from = this.player(fromId);
		const to = this.player(toId);
		// -1 马让自己算别人近，+1 马让别人算自己远
		if (from.equip.horseMinus) d -= 1;
		if (to.equip.horsePlus) d += 1;

		for (const { p, skill } of this.mods()) {
			if (p.id === fromId && skill.mods!.distanceFrom) d += skill.mods!.distanceFrom(this, from, to);
			if (p.id === toId && skill.mods!.distanceTo) d += skill.mods!.distanceTo(this, to, from);
		}
		return Math.max(1, d);
	}

	/** 攻击范围：武器给的，没武器为 1 */
	attackRange(id: string): number {
		const p = this.player(id);
		const w = p.equip.weapon;
		if (!w) return 1;
		return this.cardDef(this.card(w).name).range ?? 1;
	}

	inAttackRange(fromId: string, toId: string): boolean {
		return this.distance(fromId, toId) <= this.attackRange(fromId);
	}

	/** 弃牌阶段的手牌上限 */
	handLimit(id: string): number {
		const p = this.player(id);
		let n = p.hp;
		for (const { p: mp, skill } of this.mods()) {
			if (mp.id === id && skill.mods!.handLimit) n = skill.mods!.handLimit(this, p, n);
		}
		return Math.max(0, n);
	}

	/** 出牌阶段【杀】的次数上限 */
	shaLimit(id: string): number {
		const p = this.player(id);
		let n = 1;
		for (const { p: mp, skill } of this.mods()) {
			if (mp.id === id && skill.mods!.shaLimit) n = skill.mods!.shaLimit(this, p, n);
		}
		return n;
	}

	/**
	 * 抵消这张【杀】需要几张【闪】（无双）。
	 * 修正器挂在**使用者**身上而不是目标身上 —— 是吕布让别人多出闪，不是别人自己要多出。
	 */
	shanNeeded(ev: UseEvent, base = 1): number {
		let n = base;
		for (const { p, skill } of this.mods()) {
			if (p.id !== ev.source || !skill.mods!.shanNeeded) continue;
			n = skill.mods!.shanNeeded(this, p, ev, n);
		}
		return Math.max(1, n);
	}

	/** 【决斗】中该角色每次需要打出几张【杀】（无双）。修正器同样挂在对手身上 */
	shaNeededInDuel(opponentId: string, base = 1): number {
		let n = base;
		for (const { p, skill } of this.mods()) {
			if (p.id !== opponentId || !skill.mods!.shaNeededInDuel) continue;
			n = skill.mods!.shaNeededInDuel(this, p, n);
		}
		return Math.max(1, n);
	}

	/** 使用这张牌时是否无视距离限制（奇才） */
	ignoresDistance(id: string, cardName: string): boolean {
		const p = this.state.players.find((x) => x.id === id);
		if (!p) return false;
		for (const { p: mp, skill } of this.mods()) {
			if (mp.id !== id || !skill.mods!.ignoreDistance) continue;
			if (skill.mods!.ignoreDistance(this, p, cardName)) return true;
		}
		return false;
	}

	/** 目标是否可以被指定（空城、谦逊这类"不能成为目标"的技能） */
	canBeTargeted(sourceId: string, targetId: string, use: UseEvent): boolean {
		const target = this.player(targetId);
		for (const { p, skill } of this.mods()) {
			if (p.id !== targetId || !skill.mods!.targetable) continue;
			if (!skill.mods!.targetable(this, target, use, sourceId)) return false;
		}
		const def = this.registry.cards[use.use.name];
		if (def?.canTarget && !def.canTarget(this, sourceId, targetId, use)) return false;
		return true;
	}

	// ─────────────────────── 标记 ───────────────────────

	getFlag(id: string, key: string): number {
		const v = this.player(id).flags[key];
		return typeof v === 'number' ? v : 0;
	}

	setFlag(id: string, key: string, v: number | string | boolean): void {
		this.player(id).flags[key] = v;
	}

	addFlag(id: string, key: string, n = 1): number {
		const v = this.getFlag(id, key) + n;
		this.player(id).flags[key] = v;
		return v;
	}

	private clearFlags(prefix: string, who?: string): void {
		const targets = who ? [this.player(who)] : this.state.players;
		for (const p of targets) {
			for (const k of Object.keys(p.flags)) {
				if (k.startsWith(prefix)) delete p.flags[k];
			}
		}
	}

	// ─────────────────────── 牌的移动 ───────────────────────

	/** 牌当前在哪 */
	locate(id: number): CardLocation {
		return this.state.locations[id];
	}

	private removeFromCurrent(id: number): void {
		const loc = this.state.locations[id];
		if (!loc) return;
		switch (loc.zone) {
			case 'draw':
				this.state.drawPile = this.state.drawPile.filter((c) => c !== id);
				break;
			case 'discard':
				this.state.discardPile = this.state.discardPile.filter((c) => c !== id);
				break;
			case 'processing':
				this.state.processing = this.state.processing.filter((c) => c !== id);
				break;
			case 'hand': {
				const p = this.player(loc.owner!);
				p.hand = p.hand.filter((c) => c !== id);
				break;
			}
			case 'equip': {
				const p = this.player(loc.owner!);
				for (const slot of Object.keys(p.equip) as EquipSlot[]) {
					if (p.equip[slot] === id) delete p.equip[slot];
				}
				break;
			}
			case 'judge': {
				const p = this.player(loc.owner!);
				p.judge = p.judge.filter((c) => c !== id);
				break;
			}
		}
	}

	/**
	 * 牌位置变更的唯一入口。所有得失牌都必须走这里，否则 locations 会和实际区域不一致，
	 * 相关技能（枭姬、连营、奸雄）就会漏触发。
	 */
	async moveCards(
		cards: number[],
		to: CardLocation,
		reason: string,
		source?: string,
	): Promise<void> {
		if (cards.length === 0) return;

		// 按原持有者分组，逐组触发失去牌事件
		const byOwner = new Map<string, number[]>();
		for (const id of cards) {
			const loc = this.state.locations[id];
			const key = loc?.owner ? `${loc.owner}:${loc.zone}` : `_:${loc?.zone ?? 'draw'}`;
			if (!byOwner.has(key)) byOwner.set(key, []);
			byOwner.get(key)!.push(id);
		}

		for (const [key, ids] of byOwner) {
			const [owner, zone] = key.split(':');
			if (owner === '_') continue;
			const ev: CardMoveEvent = {
				cards: ids,
				from: { zone: zone as CardLocation['zone'], owner },
				to,
				reason,
				source,
			};
			await this.trigger('onLoseCards', ev);
		}

		for (const id of cards) {
			this.removeFromCurrent(id);
			this.state.locations[id] = { ...to };
			switch (to.zone) {
				case 'draw':
					this.state.drawPile.unshift(id);
					break;
				case 'discard':
					this.state.discardPile.push(id);
					break;
				case 'processing':
					this.state.processing.push(id);
					break;
				case 'hand':
					this.player(to.owner!).hand.push(id);
					break;
				case 'judge':
					this.player(to.owner!).judge.push(id);
					break;
				case 'equip': {
					const p = this.player(to.owner!);
					const def = this.cardDef(this.card(id).name);
					const slot = def.subtype as EquipSlot;
					p.equip[slot] = id;
					break;
				}
			}
		}

		this.pushLog({ kind: 'move', cards, to, reason, source });

		if (to.zone === 'hand') {
			await this.trigger('onGainCards', {
				cards,
				to,
				reason,
				source,
				from: { zone: 'draw' },
			} as CardMoveEvent);
		}
		for (const [key, ids] of byOwner) {
			const [owner, zone] = key.split(':');
			if (owner === '_') continue;
			await this.trigger('afterLoseCards', {
				cards: ids,
				from: { zone: zone as CardLocation['zone'], owner },
				to,
				reason,
				source,
			} as CardMoveEvent);
		}
	}

	/** 从牌堆顶取 n 张。牌堆空了就洗牌，洗三次还空判平局 */
	private takeFromPile(n: number): number[] {
		const out: number[] = [];
		for (let i = 0; i < n; i++) {
			if (this.state.drawPile.length === 0) this.reshuffle();
			const id = this.state.drawPile.shift();
			if (id === undefined) break;
			out.push(id);
		}
		return out;
	}

	private reshuffle(): void {
		if (this.state.discardPile.length === 0) {
			this.finish([], '牌堆耗尽，平局');
			throw new GameOver([], '牌堆耗尽，平局');
		}
		this.state.reshuffles++;
		if (this.state.reshuffles > 5) {
			this.finish([], '洗牌次数过多，判平局');
			throw new GameOver([], '洗牌次数过多，判平局');
		}
		const pile = this.state.discardPile.slice();
		this.state.discardPile = [];
		this.rng.shuffle(pile);
		for (const id of pile) this.state.locations[id] = { zone: 'draw' };
		this.state.drawPile.push(...pile);
		this.pushLog({ kind: 'reshuffle', count: pile.length });
	}

	/** 摸牌 */
	async drawCards(who: string, n: number, reason = 'draw'): Promise<number[]> {
		if (n <= 0) return [];
		const ids = this.takeFromPile(n);
		for (const id of ids) this.state.locations[id] = { zone: 'processing' };
		await this.moveCards(ids, { zone: 'hand', owner: who }, reason);
		return ids;
	}

	/** 看牌堆顶 n 张（不移动） */
	peekPile(n: number): number[] {
		while (this.state.drawPile.length < n && this.state.discardPile.length > 0) this.reshuffle();
		return this.state.drawPile.slice(0, n);
	}

	/** 弃置牌（进弃牌堆） */
	async discardCards(cards: number[], reason = 'discard', source?: string): Promise<void> {
		await this.moveCards(cards, { zone: 'discard' }, reason, source);
	}

	/** 获得牌（进手牌） */
	async gainCards(who: string, cards: number[], reason = 'gain', source?: string): Promise<void> {
		await this.moveCards(cards, { zone: 'hand', owner: who }, reason, source);
	}

	/** 装备牌：替换同槽位的旧装备 */
	async equipCard(who: string, cardId: number): Promise<void> {
		const p = this.player(who);
		const def = this.cardDef(this.card(cardId).name);
		const slot = def.subtype as EquipSlot;
		const old = p.equip[slot];
		if (old !== undefined) {
			const oldSkill = this.cardDef(this.card(old).name).equipSkill;
			if (oldSkill) p.skills = p.skills.filter((s) => s !== oldSkill);
			await this.discardCards([old], 'equip-replace', who);
		}
		await this.moveCards([cardId], { zone: 'equip', owner: who }, 'equip');
		if (def.equipSkill && !p.skills.includes(def.equipSkill)) p.skills.push(def.equipSkill);
	}

	// ─────────────────────── 时机总线 ───────────────────────

	/**
	 * 触发一个时机。按"当前回合角色起，座次顺序"收集并依次结算 ——
	 * 这是三国杀的标准触发顺序。锁定技不询问直接发动。
	 */
	async trigger(timing: Timing, ev: any): Promise<void> {
		const cands: Array<{ pid: string; skill: SkillDef; spec: NonNullable<SkillDef['triggers']>[number] }> = [];

		for (const p of this.playersFrom()) {
			for (const sid of p.skills) {
				if (p.disabledSkills.includes(sid)) continue;
				const s = this.registry.skills[sid];
				if (!s?.triggers) continue;
				for (const spec of s.triggers) {
					if (spec.timing !== timing) continue;
					cands.push({ pid: p.id, skill: s, spec });
				}
			}
		}

		cands.sort((a, b) => (b.spec.priority ?? 0) - (a.spec.priority ?? 0));

		for (const c of cands) {
			const p = this.state.players.find((x) => x.id === c.pid);
			// 结算过程中角色可能已死亡/技能已失效，每次都重新检查
			if (!p || !p.alive || p.disabledSkills.includes(c.skill.id)) continue;
			if (!p.skills.includes(c.skill.id)) continue;
			let can = false;
			try {
				can = c.spec.can(this, p, ev);
			} catch {
				can = false;
			}
			if (!can) continue;

			const locked = c.skill.tags?.includes('locked');
			if (!locked) {
				const yes = await this.askConfirm(p.id, c.skill.id);
				if (!yes) continue;
			}
			this.pushLog({ kind: 'skill', who: p.id, skill: c.skill.id });
			await c.spec.run(this, p, ev);
		}
	}

	// ─────────────────────── 伤害与体力 ───────────────────────

	async damage(ev: DamageEvent): Promise<void> {
		const target = this.state.players.find((p) => p.id === ev.target);
		if (!target?.alive || ev.amount <= 0) return;

		// 伤害值修正（裸衣等）
		for (const { p, skill } of this.mods()) {
			if (!skill.mods!.damageBonus) continue;
			if (ev.source && p.id === ev.source) ev.amount += skill.mods!.damageBonus(this, p, ev);
		}

		await this.trigger('beforeDamage', ev);
		if (ev.cancelled || ev.amount <= 0) return;

		await this.trigger('onDamage', ev);
		if (ev.cancelled || ev.amount <= 0) return;

		target.hp -= ev.amount;
		this.pushLog({
			kind: 'damage',
			source: ev.source,
			target: ev.target,
			amount: ev.amount,
			nature: ev.nature,
			hp: target.hp,
		});

		await this.trigger('afterDamage', ev);
		await this.trigger('afterDamaged', ev);

		// 铁索连环：属性伤害传导给其他所有横置角色，传导伤害不再传导
		if (ev.nature && !ev.chainReaction) {
			const chained = this.alivePlayers().filter((p) => p.chained);
			if (target.chained) target.chained = false;
			for (const p of chained) {
				if (p.id === ev.target || !p.alive) continue;
				p.chained = false;
				this.pushLog({ kind: 'chainSpread', target: p.id });
				await this.damage({
					source: ev.source,
					target: p.id,
					amount: ev.amount,
					nature: ev.nature,
					card: ev.card,
					chainReaction: true,
				});
			}
		}

		if (target.hp <= 0) await this.dying(target.id, ev.source);
	}

	async loseHp(who: string, amount = 1, reason = 'loseHp'): Promise<void> {
		const p = this.player(who);
		if (!p.alive) return;
		p.hp -= amount;
		this.pushLog({ kind: 'loseHp', target: who, amount, hp: p.hp, reason });
		await this.trigger('onLoseHp', { who, amount, reason });
		if (p.hp <= 0) await this.dying(who);
	}

	async recover(ev: RecoverEvent): Promise<void> {
		const p = this.player(ev.target);
		if (!p.alive) return;
		await this.trigger('beforeRecover', ev);
		if (ev.amount <= 0) return;
		const before = p.hp;
		p.hp = Math.min(p.maxHp, p.hp + ev.amount);
		if (p.hp === before) return;
		this.pushLog({ kind: 'recover', target: ev.target, amount: p.hp - before, hp: p.hp });
		await this.trigger('onRecover', ev);
	}

	/** 濒死结算：从濒死者开始按座次问一圈桃 */
	async dying(who: string, source?: string): Promise<void> {
		const p = this.player(who);
		if (!p.alive || p.hp > 0) return;

		const ev: DyingEvent = { who, source };
		this.pushLog({ kind: 'dying', who });
		await this.trigger('onDying', ev);
		if (p.hp > 0) return;

		for (const rescuer of this.playersFrom(who)) {
			while (p.hp <= 0 && rescuer.alive) {
				const need = 1 - p.hp;
				const opts = this.rescueOptions(rescuer.id, who);
				if (opts.length === 0) break;
				const r = await this.ask({
					kind: 'respond',
					who: rescuer.id,
					need: 'tao',
					mode: 'use',
					prompt:
						rescuer.id === who
							? `你濒死，需要 ${need} 个【桃】`
							: `${p.nickname} 濒死，是否使用【桃】救援？（还需 ${need} 个）`,
					options: opts,
					cancelable: true,
					timeout: 25,
				});
				if (r.type !== 'play') break;
				const opt = opts.find((o) => o.id === r.optionId);
				if (!opt) break;
				await this.useCard(rescuer.id, optionToUse(opt), [who]);
			}
			if (p.hp > 0) return;
		}

		await this.die(who, source);
	}

	/** 濒死时可用的救援选项：桃；自己濒死时还可用酒 */
	private rescueOptions(rescuerId: string, dyingId: string): PlayOption[] {
		// 由 options.ts 注入，避免循环依赖
		return this.optionProvider?.rescue(this, rescuerId, dyingId) ?? [];
	}

	/** 由 options.ts 在构造后注入（拆成具名接口，避免与 options.ts 互相推断成 any） */
	optionProvider?: OptionProvider;

	async die(who: string, killer?: string): Promise<void> {
		const p = this.player(who);
		if (!p.alive) return;
		p.alive = false;
		p.identityRevealed = true;
		this.pushLog({ kind: 'die', who, killer, identity: p.identity });

		await this.trigger('onDie', { who, killer });

		// 死亡角色的所有牌进弃牌堆
		const all = [...p.hand, ...Object.values(p.equip), ...p.judge].filter(
			(x): x is number => typeof x === 'number',
		);
		if (all.length) await this.discardCards(all, 'die', who);
		p.skills = [];

		await this.onDeathReward(who, killer);
		this.checkWin();
	}

	/** 开局布置（分身份、选将、发初始手牌），由模式层覆写 */
	protected async setupGame(): Promise<void> {}

	/** 身份局的死亡奖惩，由模式层覆写 */
	protected async onDeathReward(_who: string, _killer?: string): Promise<void> {}

	/** 胜负判定，由模式层覆写 */
	protected checkWin(): void {}

	finish(winners: string[], reason: string): void {
		if (this.state.finished) return;
		this.state.finished = { winners, reason };
		this.pushLog({ kind: 'finish', winners, reason });
		this.notifyIdle();
	}

	// ─────────────────────── 判定 ───────────────────────

	async judge(who: string, reason: string, check: (c: Card) => boolean): Promise<JudgeEvent> {
		const ids = this.takeFromPile(1);
		const card = this.card(ids[0]);
		await this.moveCards(ids, { zone: 'processing' }, 'judge');

		const ev: JudgeEvent = { who, reason, card };
		this.pushLog({ kind: 'judge', who, reason, card: ids[0] });

		// 鬼才/改判类技能在这里插手
		await this.trigger('beforeJudgeEffect', ev);

		ev.result = check(ev.card!);
		this.pushLog({ kind: 'judgeResult', who, reason, card: ev.card!.id, result: ev.result });

		await this.trigger('afterJudgeEffect', ev);

		// 天妒之类可能已经把判定牌拿走了
		if (this.locate(ev.card!.id).zone === 'processing') {
			await this.discardCards([ev.card!.id], 'judge');
		}
		return ev;
	}

	/** 供改判技能使用：用一张牌替换当前判定牌 */
	async replaceJudgeCard(ev: JudgeEvent, newCardId: number): Promise<void> {
		const old = ev.card!;
		if (this.locate(old.id).zone === 'processing') {
			await this.discardCards([old.id], 'judge-replaced');
		}
		await this.moveCards([newCardId], { zone: 'processing' }, 'judge-replace');
		ev.card = this.card(newCardId);
		this.pushLog({ kind: 'judgeReplace', who: ev.who, card: newCardId });
	}

	// ─────────────────────── 用牌结算 ───────────────────────

	/**
	 * 使用一张牌的完整结算。
	 * 顺序：移入处理区 → onUse → 逐目标询问无懈 → 逐目标 onEffect → afterUse → 进弃牌堆
	 */
	async useCard(
		source: string,
		use: CardUse,
		targets: string[],
		opts: { noCount?: boolean } = {},
	): Promise<UseEvent> {
		const ev: UseEvent = { source, use, targets: targets.slice(), cancelledFor: [], noCount: opts.noCount };
		const def = this.cardDef(use.name);

		if (use.cards.length) await this.moveCards(use.cards, { zone: 'processing' }, 'use', source);
		this.pushLog({ kind: 'use', source, name: use.name, nature: use.nature, cards: use.cards, targets });

		await this.trigger('beforeUse', ev);
		await this.trigger('onUse', ev);
		if (def.onUse) await def.onUse(this, ev);
		await this.trigger('onTargetChosen', ev);

		// 装备牌直接穿上，不走目标结算
		if (def.type === 'equip') {
			await this.equipCard(source, use.cards[0]);
			await this.trigger('afterUse', ev);
			return ev;
		}
		// 延时锦囊放进目标判定区
		if (def.subtype === 'delayed') {
			const t = ev.targets[0];
			if (t && !(await this.askWuxie(ev, t))) {
				await this.moveCards(use.cards, { zone: 'judge', owner: t }, 'delayed');
				await this.trigger('afterUse', ev);
				return ev;
			}
			await this.finishUse(ev);
			return ev;
		}

		for (const t of ev.targets) {
			if (ev.negated) break;
			if (ev.cancelledFor!.includes(t)) continue;
			const tp = this.state.players.find((p) => p.id === t);
			if (!tp?.alive) continue;

			if (def.wuxieable ?? def.type === 'trick') {
				if (await this.askWuxie(ev, t)) {
					this.pushLog({ kind: 'negated', target: t, name: use.name });
					continue;
				}
			}

			ev.currentTarget = t;
			await this.trigger('onBecomeTarget', ev);
			if (ev.cancelledFor!.includes(t)) continue;

			await this.trigger('onEffectStart', ev);
			if (!ev.cancelledFor!.includes(t) && def.onEffect) {
				await def.onEffect(this, ev, t);
			}
			await this.trigger('onEffectEnd', ev);
		}

		await this.finishUse(ev);
		return ev;
	}

	private async finishUse(ev: UseEvent): Promise<void> {
		await this.trigger('afterUse', ev);
		// 还在处理区的牌进弃牌堆（技能可能已经把它拿走了，如奸雄）
		const left = ev.use.cards.filter((c) => this.locate(c).zone === 'processing');
		if (left.length) await this.discardCards(left, 'used');
	}

	/**
	 * 【无懈可击】链。返回 true 表示该锦囊对该目标最终被抵消。
	 * 每轮问一圈，每张无懈翻转一次结果，直到没人再出。
	 */
	private async askWuxie(ev: UseEvent, target: string): Promise<boolean> {
		let negated = false;
		const targetName = this.player(target).nickname;

		for (;;) {
			let responded = false;
			for (const p of this.playersFrom()) {
				const opts = this.optionProvider?.respond(this, p.id, 'wuxie', 'respond', ev) ?? [];
				if (opts.length === 0) continue;

				const r = await this.ask({
					kind: 'respond',
					who: p.id,
					need: 'wuxie',
					mode: 'respond',
					prompt: negated
						? `是否对【无懈可击】使用【无懈可击】？`
						: `是否对 ${targetName} 的【${this.cardDef(ev.use.name).cn}】使用【无懈可击】？`,
					trigger: { source: ev.source, use: ev.use },
					options: opts,
					cancelable: true,
					timeout: 20,
				});
				if (r.type !== 'play') continue;
				const opt = opts.find((o) => o.id === r.optionId);
				if (!opt) continue;

				await this.useCard(p.id, optionToUse(opt), []);
				negated = !negated;
				responded = true;
				this.pushLog({ kind: 'wuxie', who: p.id, negated });
				break;
			}
			if (!responded) break;
		}
		return negated;
	}

	/**
	 * 要求某人打出/使用一张指定的牌（闪、杀、桃…）。返回是否成功。
	 * 转化技（龙胆、武圣、倾国）由 optionProvider 统一枚举进来。
	 */
	async askForCard(
		who: string,
		need: string,
		prompt: string,
		trigger?: { source?: string; use: CardUse },
		mode: 'use' | 'respond' = 'respond',
	): Promise<CardUse | null> {
		const p = this.state.players.find((x) => x.id === who);
		if (!p?.alive) return null;

		// 护驾/激将这类"令他人代为打出"的技能在这里插手：
		// 技能把结果写进 ev.use，引擎就直接采信，不再向本人求牌。
		const askEv: AskForCardEvent = { who, need, mode, trigger };
		await this.trigger('beforeAskForCard', askEv);
		if (askEv.use) return askEv.use;

		const opts = this.optionProvider?.respond(this, who, need, mode, undefined) ?? [];
		if (opts.length === 0) return null;

		const r = await this.ask({
			kind: 'respond',
			who,
			need,
			mode,
			prompt,
			trigger,
			options: opts,
			cancelable: true,
			timeout: 25,
		});
		if (r.type !== 'play') return null;
		const opt = opts.find((o) => o.id === r.optionId);
		if (!opt) return null;

		const use = optionToUse(opt);
		if (mode === 'respond') {
			if (use.cards.length) await this.moveCards(use.cards, { zone: 'processing' }, 'respond', who);
			this.pushLog({ kind: 'respond', who, name: use.name, cards: use.cards });
			await this.trigger('onRespond', { who, use });
			const left = use.cards.filter((c) => this.locate(c).zone === 'processing');
			if (left.length) await this.discardCards(left, 'responded');
		}
		return use;
	}

	// ─────────────────────── 回合流程 ───────────────────────

	async runGame(): Promise<void> {
		if (this.started) return;
		this.started = true;
		try {
			await this.setupGame();
			await this.trigger('gameStart', {});
			let guard = 0;
			while (!this.state.finished) {
				if (++guard > 2000) {
					this.finish([], '回合数异常，强制结束');
					break;
				}
				const cur = this.state.currentPlayer;
				await this.runTurn(cur);
				if (this.state.finished) break;
				this.advanceTurn();
			}
		} catch (e) {
			if (!(e instanceof GameOver)) throw e;
		} finally {
			this.notifyIdle();
		}
	}

	private advanceTurn(): void {
		const order = this.playersFrom(this.state.currentPlayer);
		const next = order[1] ?? order[0];
		if (!next) {
			this.finish([], '无人存活');
			return;
		}
		if (next.seat <= this.player(this.state.currentPlayer).seat) this.state.round++;
		this.state.currentPlayer = next.id;
	}

	async runTurn(who: string): Promise<void> {
		const p = this.state.players.find((x) => x.id === who);
		if (!p?.alive) return;

		this.clearFlags('turn:');
		this.pushLog({ kind: 'turnStart', who, round: this.state.round });

		if (p.turnedOver) {
			p.turnedOver = false;
			this.pushLog({ kind: 'turnSkipped', who, reason: 'turnedOver' });
			return;
		}

		await this.trigger('turnStart', { who });

		for (const phase of PHASE_ORDER) {
			if (!p.alive || this.state.finished) break;
			await this.runPhase(who, phase);
		}

		if (p.alive) await this.trigger('turnEnd', { who });
		this.clearFlags('turn:', who);
	}

	private async runPhase(who: string, phase: Phase): Promise<void> {
		const p = this.player(who);
		this.state.phase = phase;
		const ev: PhaseEvent = { who, phase };
		await this.trigger('phaseStart', ev);
		if (ev.skipped || !p.alive || this.state.finished) {
			await this.trigger('phaseEnd', ev);
			return;
		}
		this.pushLog({ kind: 'phase', who, phase });

		switch (phase) {
			case 'judge':
				await this.judgePhase(who);
				break;
			case 'draw':
				await this.drawPhase(who);
				break;
			case 'play':
				await this.playPhase(who);
				break;
			case 'discard':
				await this.discardPhase(who);
				break;
		}

		if (this.state.players.find((x) => x.id === who)?.alive) {
			await this.trigger('phaseEnd', ev);
		}
	}

	/** 判定阶段：判定区的牌从后往前（最后置入的先结算） */
	private async judgePhase(who: string): Promise<void> {
		const p = this.player(who);
		while (p.judge.length > 0 && p.alive) {
			const id = p.judge[p.judge.length - 1];
			const def = this.cardDef(this.card(id).name);
			if (!def.delayed) {
				await this.discardCards([id], 'judge-invalid');
				continue;
			}
			await this.moveCards([id], { zone: 'processing' }, 'judge-start');
			const ev = await this.judge(who, def.name, def.delayed.check);
			if (ev.result) {
				await this.discardHelper(id);
				await def.delayed.onHit(this, who, ev);
			} else if (def.delayed.onMiss) {
				await def.delayed.onMiss(this, who, ev);
			} else {
				await this.discardHelper(id);
			}
		}
	}

	/** 延时锦囊牌本体如果还在处理区就丢进弃牌堆 */
	private async discardHelper(id: number): Promise<void> {
		if (this.locate(id).zone === 'processing') await this.discardCards([id], 'delayed-done');
	}

	private async drawPhase(who: string): Promise<void> {
		const ev = { who, num: 2, replaced: false };
		await this.trigger('drawPhaseNum', ev);
		if (!ev.replaced && ev.num > 0) await this.drawCards(who, ev.num, 'drawPhase');
	}

	private async playPhase(who: string): Promise<void> {
		for (;;) {
			const p = this.state.players.find((x) => x.id === who);
			if (!p?.alive || this.state.finished) return;
			if (this.state.phase !== 'play') return;

			const options = this.optionProvider?.play(this, who) ?? [];
			const r = await this.ask({
				kind: 'playPhase',
				who,
				prompt: '出牌阶段',
				options,
				cancelable: true,
				timeout: 40,
			});
			if (r.type !== 'play') return;

			const opt = options.find((o) => o.id === r.optionId);
			if (!opt) return;

			// 重铸：弃掉这张牌摸一张，不结算牌的效果，也不计入任何次数限制
			if (opt.recast) {
				this.pushLog({ kind: 'recast', who, name: opt.name, cards: opt.cards });
				await this.discardCards(opt.cards, 'recast', who);
				await this.drawCards(who, 1, 'recast');
				continue;
			}

			if (opt.viaSkill && this.registry.skills[opt.viaSkill]?.active) {
				const sk = this.registry.skills[opt.viaSkill]!;
				this.pushLog({ kind: 'skill', who, skill: sk.id });
				await sk.active!.run(this, p);
				continue;
			}

			const targets = opt.targets.auto ? opt.targets.candidates : r.targets;
			await this.useCard(who, optionToUse(opt), targets);
		}
	}

	private async discardPhase(who: string): Promise<void> {
		const p = this.player(who);
		const limit = this.handLimit(who);
		const excess = p.hand.length - limit;
		if (excess <= 0) return;
		const chosen = await this.askCards(
			who,
			`请弃置 ${excess} 张手牌`,
			p.hand.map((id) => ({ id })),
			excess,
			excess,
			false,
		);
		await this.discardCards(chosen, 'discardPhase', who);
	}

	// ─────────────────────── 日志 ───────────────────────

	pushLog(e: Omit<LogEntry, 't'>): void {
		this.log.push({ t: this.logSeq++, ...e } as LogEntry);
		if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
	}
}

// ─────────────────────── 工具 ───────────────────────

export function optionToUse(opt: PlayOption): CardUse {
	return {
		name: opt.name,
		nature: opt.nature,
		cards: opt.cards.slice(),
		viaSkill: opt.viaSkill,
	};
}

/** 超时/掉线时的安全默认：能不做就不做，必须做就选最少的 */
export function defaultDecision(req: AskRequest): DecisionPayload {
	switch (req.kind) {
		case 'playPhase':
		case 'respond':
			return { type: 'pass' };
		case 'confirmSkill':
			return { type: 'confirm', yes: false };
		case 'discard':
			return { type: 'cards', cards: req.candidates.slice(0, req.min) };
		case 'chooseCards':
			return { type: 'cards', cards: req.candidates.slice(0, req.min).map((c) => c.id) };
		case 'choosePlayers':
			return { type: 'players', players: req.candidates.slice(0, req.min) };
		case 'chooseOption':
			return { type: 'option', optionId: (req.options.find((o) => !o.disabled) ?? req.options[0]).id };
		case 'chooseSuit':
			return { type: 'suit', suit: 'heart' };
		case 'arrange':
			return { type: 'arrange', top: req.cards.slice(0, req.maxTop), bottom: req.cards.slice(req.maxTop) };
		case 'distribute':
			return {
				type: 'distribute',
				assign: req.cards.map((c) => ({ card: c, to: req.who })),
			};
	}
}
