/**
 * 客户端状态。只有一个真相来源：服务端推来的 GameView。
 *
 * 本地**不做任何规则推导** —— 哪张牌能点、能点谁，全部读 view.ask 里服务端算好的
 * PlayOption。客户端只负责"把选择收集齐了发回去"。
 */

import { create } from 'zustand';
import type {
	AskHint,
	ClientMsg,
	GameView,
	LobbyPlayer,
	LogEntry,
	PlayOption,
	ServerMsg,
	Suit,
} from '@sgs/engine';

/** 玩家身份：随机生成一次存本地，断线重连靠它认回座位 */
function getPid(): string {
	const k = 'sgs.pid';
	let v = localStorage.getItem(k);
	if (!v) {
		v = Math.random().toString(36).slice(2) + Date.now().toString(36);
		localStorage.setItem(k, v);
	}
	return v;
}

export type Screen = 'home' | 'lobby' | 'table';

interface State {
	pid: string;
	name: string;
	room: string;
	screen: Screen;
	connected: boolean;
	error?: string;

	lobby: LobbyPlayer[];
	canStart: boolean;

	view?: GameView;
	hint?: AskHint;
	deadline?: number;
	log: LogEntry[];
	chat: Array<{ from: string; text: string; at: number }>;

	/** 当前选中的手牌 / 目标 / 出牌选项 */
	pickedCards: number[];
	pickedTargets: string[];
	pickedOption?: string;
	/** distribute（郭嘉遗计）专用：每张牌分给了谁，没在这里出现就是留给自己 */
	pickedAssign: Array<{ card: number; to: string }>;
	/** arrange（观星）专用：牌堆顶/牌堆底两个区当前的排列，顶区的顺序就是接下来摸牌的顺序 */
	arrangeTop: number[];
	arrangeBottom: number[];
	/** 当前展开"用法"浮层的手牌 id——只有一张牌有多种打法（转化技/重铸）时才用得上 */
	cardMenu?: number;

	setName(n: string): void;
	connect(room: string): void;
	disconnect(): void;
	send(m: ClientMsg): void;

	toggleCard(id: number): void;
	toggleTarget(pid: string): void;
	pickOption(id: string | undefined): void;
	/** distribute：把一张牌分给 to；to 为 undefined 表示撤销分配（留给自己） */
	setAssign(card: number, to: string | undefined): void;
	/** arrange：把一张牌在牌堆顶/牌堆底两个区之间挪动，顶区满了（到 maxTop）就不让再放进去 */
	moveArrangeCard(id: number, zone: 'top' | 'bottom'): void;
	/** arrange：顶区里跟相邻一张交换位置，用来调先后手顺序 */
	moveArrangeOrder(id: number, dir: -1 | 1): void;
	/** 展开/收起某张手牌的"用法"浮层；再点一次同一张牌就收起 */
	setCardMenu(id: number | undefined): void;
	/** 多选一：点了就直接提交，不再要一次"确定" */
	pickAndCommitOption(id: string): void;
	/** 花色四选一（反间）：同样是原子选择，点了即提交 */
	pickAndCommitSuit(suit: Suit): void;
	clearPick(): void;
	/** 把当前选择提交上去 */
	commit(): void;
	/** 放弃/取消 */
	pass(): void;
}

let ws: WebSocket | undefined;
let retry = 0;
let heartbeat: ReturnType<typeof setInterval> | undefined;

export const useGame = create<State>((set, get) => ({
	pid: getPid(),
	name: localStorage.getItem('sgs.name') ?? '',
	room: '',
	screen: 'home',
	connected: false,
	lobby: [],
	canStart: false,
	log: [],
	chat: [],
	pickedCards: [],
	pickedTargets: [],
	pickedAssign: [],
	arrangeTop: [],
	arrangeBottom: [],

	setName(n) {
		localStorage.setItem('sgs.name', n);
		set({ name: n });
	},

	connect(room) {
		const code = room.toUpperCase();
		set({ room: code, error: undefined });
		// 房间码要能挺过刷新和锁屏 —— 只存在内存里的话，手机息屏一次就出局了。
		// 同时写进 URL，这样分享出去的链接和自己刷新走的是同一条路。
		localStorage.setItem('sgs.room', code);
		if (new URLSearchParams(location.search).get('r') !== code) {
			history.replaceState(null, '', `/?r=${code}`);
		}
		ws?.close();

		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const sock = new WebSocket(`${proto}//${location.host}/api/ws?code=${code}`);
		ws = sock;

		sock.onopen = () => {
			retry = 0;
			set({ connected: true });
			const { pid, name } = get();
			sock.send(JSON.stringify({ t: 'hello', pid, name: name || '无名' } satisfies ClientMsg));
			clearInterval(heartbeat);
			heartbeat = setInterval(() => {
				if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'ping' }));
			}, 25_000);
		};

		sock.onmessage = (e) => {
			// 这里的抛错到不了 React 错误边界（事件回调不在渲染期），
			// 不兜住的话一条坏报文就能让整个连接静默失聪：后续消息照收，
			// 但状态再也不更新，界面卡在上一帧，玩家完全看不出发生了什么。
			try {
				handleMessage(e.data as string);
			} catch (err) {
				console.error('处理服务端消息失败', err, e.data);
				set({ error: '收到一条无法处理的消息，界面可能不同步，建议刷新' });
			}
		};

		const handleMessage = (raw: string) => {
			const msg = JSON.parse(raw) as ServerMsg;
			switch (msg.t) {
				case 'lobby':
					// 顺手清掉上一局的残留：开下一局时服务端会推 lobby，
					// 不清的话 view.finished 还挂着，结算界面会闪回来
					set({
						screen: 'lobby',
						lobby: msg.players,
						canStart: msg.canStart,
						view: undefined,
						hint: undefined,
						deadline: undefined,
						log: [],
						pickedCards: [],
						pickedTargets: [],
						pickedOption: undefined,
						pickedAssign: [],
						cardMenu: undefined,
						arrangeTop: [],
						arrangeBottom: [],
					});
					break;
				case 'view':
					// 换了新请求就清空上一轮的选择，否则会把旧的选中态带进新一轮；
					// arrange 请求还要按 maxTop 给个默认排列，等价于"不动它，直接摸最上面几张"
					set((s) => {
						const changed = s.view?.ask?.seq !== msg.view.ask?.seq;
						const ask = msg.view.ask;
						return {
							screen: 'table',
							view: msg.view,
							hint: msg.hint,
							deadline: msg.deadline,
							...(changed
								? {
										pickedCards: [],
										pickedTargets: [],
										pickedOption: undefined,
										pickedAssign: [],
										cardMenu: undefined,
										arrangeTop: ask?.kind === 'arrange' ? ask.cards.slice(0, ask.maxTop) : [],
										arrangeBottom: ask?.kind === 'arrange' ? ask.cards.slice(ask.maxTop) : [],
									}
								: {}),
						};
					});
					break;
				case 'log':
					set({ log: msg.entries });
					break;
				case 'chat':
					set((s) => ({
						chat: [...s.chat.slice(-20), { from: msg.from, text: msg.text, at: Date.now() }],
					}));
					break;
				case 'error':
					set({ error: msg.msg });
					setTimeout(() => set({ error: undefined }), 3000);
					break;
			}
		};

		sock.onclose = () => {
			set({ connected: false });
			clearInterval(heartbeat);
			// 指数退避重连，最多 8 秒一次
			if (get().room) {
				const wait = Math.min(8000, 500 * 2 ** retry++);
				setTimeout(() => {
					if (get().room === code) get().connect(code);
				}, wait);
			}
		};
	},

	disconnect() {
		set({ room: '', screen: 'home', view: undefined, lobby: [] });
		localStorage.removeItem('sgs.room');
		history.replaceState(null, '', '/');
		clearInterval(heartbeat);
		ws?.close();
		ws = undefined;
	},

	send(m) {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
	},

	toggleCard(id) {
		set((s) => ({
			pickedCards: s.pickedCards.includes(id)
				? s.pickedCards.filter((c) => c !== id)
				: [...s.pickedCards, id],
		}));
	},

	toggleTarget(pid) {
		set((s) => ({
			pickedTargets: s.pickedTargets.includes(pid)
				? s.pickedTargets.filter((p) => p !== pid)
				: [...s.pickedTargets, pid],
		}));
	},

	pickOption(id) {
		set({ pickedOption: id, pickedTargets: [] });
	},

	setAssign(card, to) {
		set((s) => ({
			pickedAssign: to
				? [...s.pickedAssign.filter((a) => a.card !== card), { card, to }]
				: s.pickedAssign.filter((a) => a.card !== card),
		}));
	},

	moveArrangeCard(id, zone) {
		const s = get();
		const ask = s.view?.ask;
		if (ask?.kind !== 'arrange') return;
		if (zone === 'top') {
			// 顶区放满了就拦下来，界面上表现为按钮点了没反应；服务端也会按 maxTop 兜底校验
			if (s.arrangeTop.length >= ask.maxTop || s.arrangeTop.includes(id)) return;
			set({ arrangeTop: [...s.arrangeTop, id], arrangeBottom: s.arrangeBottom.filter((x) => x !== id) });
		} else {
			if (s.arrangeBottom.includes(id)) return;
			set({ arrangeBottom: [...s.arrangeBottom, id], arrangeTop: s.arrangeTop.filter((x) => x !== id) });
		}
	},

	moveArrangeOrder(id, dir) {
		set((s) => {
			const i = s.arrangeTop.indexOf(id);
			const j = i + dir;
			if (i < 0 || j < 0 || j >= s.arrangeTop.length) return {};
			const next = [...s.arrangeTop];
			[next[i], next[j]] = [next[j], next[i]];
			return { arrangeTop: next };
		});
	},

	setCardMenu(id) {
		set({ cardMenu: id });
	},

	pickAndCommitOption(id) {
		const s = get();
		const ask = s.view?.ask;
		if (ask?.kind !== 'chooseOption') return;
		s.send({ t: 'decide', seq: ask.seq, payload: { type: 'option', optionId: id } });
		s.clearPick();
	},

	pickAndCommitSuit(suit) {
		const s = get();
		const ask = s.view?.ask;
		if (ask?.kind !== 'chooseSuit') return;
		s.send({ t: 'decide', seq: ask.seq, payload: { type: 'suit', suit } });
		s.clearPick();
	},

	clearPick() {
		set({ pickedCards: [], pickedTargets: [], pickedOption: undefined, pickedAssign: [], cardMenu: undefined });
	},

	commit() {
		const s = get();
		const ask = s.view?.ask;
		if (!ask) return;

		const send = (payload: Parameters<State['send']>[0] extends never ? never : any) =>
			s.send({ t: 'decide', seq: ask.seq, payload } as ClientMsg);

		switch (ask.kind) {
			case 'playPhase':
			case 'respond': {
				const opt = ask.options.find((o) => o.id === s.pickedOption);
				if (!opt) return;
				const targets = opt.targets.auto ? opt.targets.candidates : s.pickedTargets;
				send({ type: 'play', optionId: opt.id, targets });
				break;
			}
			case 'discard':
			case 'chooseCards':
				send({ type: 'cards', cards: s.pickedCards });
				break;
			case 'choosePlayers':
				send({ type: 'players', players: s.pickedTargets });
				break;
			case 'confirmSkill':
				send({ type: 'confirm', yes: true });
				break;
			case 'chooseOption':
				send({ type: 'option', optionId: s.pickedOption ?? ask.options[0].id });
				break;
			case 'chooseSuit':
				// 花色走 pickAndCommitSuit 点一下就提交，不经过这里；
				// 留个兜底只为把 switch 写全，别再把 pickedOption（存的是 option/牌 id）当花色用
				send({ type: 'suit', suit: ask.options[0] });
				break;
			case 'distribute':
				send({ type: 'distribute', assign: s.pickedAssign });
				break;
			case 'arrange':
				send({ type: 'arrange', top: s.arrangeTop, bottom: s.arrangeBottom });
				break;
		}
		s.clearPick();
	},

	pass() {
		const s = get();
		const ask = s.view?.ask;
		if (!ask) return;
		const payload =
			ask.kind === 'confirmSkill' ? { type: 'confirm' as const, yes: false } : { type: 'pass' as const };
		s.send({ t: 'decide', seq: ask.seq, payload } as ClientMsg);
		s.clearPick();
	},
}));

/** 当前请求下，某张手牌是否可选 */
export function cardSelectable(view: GameView | undefined, cardId: number): boolean {
	const ask = view?.ask;
	if (!ask) return false;
	switch (ask.kind) {
		case 'playPhase':
		case 'respond':
			return ask.options.some((o) => o.cards.includes(cardId));
		case 'discard':
			return ask.candidates.includes(cardId);
		case 'chooseCards':
			return ask.candidates.some((c) => c.id === cardId);
		default:
			return false;
	}
}

/**
 * 点了某张手牌后，对应的全部出牌选项。一张牌可能有多种打法——普通使用、
 * 转化技当另一张牌用、重铸——服务端把它们都算成独立的 option 一起下发；
 * 前端不筛第一个，只有一种时 UI 层直接选中，多种时弹"用法"菜单让玩家自己挑。
 */
export function optionsForCard(view: GameView | undefined, cardId: number): PlayOption[] {
	const ask = view?.ask;
	if (!ask || (ask.kind !== 'playPhase' && ask.kind !== 'respond')) return [];
	return ask.options.filter((o) => o.cards.length === 1 && o.cards[0] === cardId);
}
