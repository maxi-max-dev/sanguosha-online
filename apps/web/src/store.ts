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

	setName(n: string): void;
	connect(room: string): void;
	disconnect(): void;
	send(m: ClientMsg): void;

	toggleCard(id: number): void;
	toggleTarget(pid: string): void;
	pickOption(id: string | undefined): void;
	/** 多选一：点了就直接提交，不再要一次"确定" */
	pickAndCommitOption(id: string): void;
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

	setName(n) {
		localStorage.setItem('sgs.name', n);
		set({ name: n });
	},

	connect(room) {
		const code = room.toUpperCase();
		set({ room: code, error: undefined });
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
			const msg = JSON.parse(e.data as string) as ServerMsg;
			switch (msg.t) {
				case 'lobby':
					set({ screen: 'lobby', lobby: msg.players, canStart: msg.canStart });
					break;
				case 'view':
					// 换了新请求就清空上一轮的选择，否则会把旧的选中态带进新一轮
					set((s) => {
						const changed = s.view?.ask?.seq !== msg.view.ask?.seq;
						return {
							screen: 'table',
							view: msg.view,
							hint: msg.hint,
							deadline: msg.deadline,
							...(changed ? { pickedCards: [], pickedTargets: [], pickedOption: undefined } : {}),
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

	pickAndCommitOption(id) {
		const s = get();
		const ask = s.view?.ask;
		if (ask?.kind !== 'chooseOption') return;
		s.send({ t: 'decide', seq: ask.seq, payload: { type: 'option', optionId: id } });
		s.clearPick();
	},

	clearPick() {
		set({ pickedCards: [], pickedTargets: [], pickedOption: undefined });
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
				send({ type: 'suit', suit: (s.pickedOption as any) ?? 'heart' });
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

/** 点了某张手牌后，对应哪个出牌选项 */
export function optionForCard(view: GameView | undefined, cardId: number): PlayOption | undefined {
	const ask = view?.ask;
	if (!ask || (ask.kind !== 'playPhase' && ask.kind !== 'respond')) return undefined;
	return ask.options.find((o) => o.cards.length === 1 && o.cards[0] === cardId);
}
