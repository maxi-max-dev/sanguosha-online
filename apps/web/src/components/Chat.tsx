import { useEffect, useRef, useState } from 'react';
import type { GameView } from '@sgs/engine';
import { useGame } from '../store.js';

/**
 * 社交层：聊天 + 快捷语 + 表情。
 *
 * 三种发言方式共用同一条 wire 报文（见 wire.ts 的 ClientMsg.chat），前端这边分成
 * 两类交互：
 *   - 广播类（QUICK_BROADCAST + 自由输入）：点一下 / 回车直接发，不需要指定对象。
 *   - 点名类（QUICK_TARGETED + 表情）：点了不会立刻发，而是进入"瞄准"状态
 *     （store.chatAim），提示玩家去点桌上的一张武将牌当对象——复用武将牌本来就有
 *     的点击面，不用在每张挤得很满的武将牌上再抠一个小按钮出来（那张卡片的
 *     overflow:hidden 塞不下更多角标了，见 app.css 的 .general 系列注释）。
 *     Table.tsx 的 Seat 组件负责在点击时把 chatAim 消费掉。
 *
 * 引擎边界：这个文件完全不 import @sgs/engine 之外的任何游戏规则模块，聊天的一切
 * 只经过 wire 报文和这个 store 字段，绝不碰 game.ts / view.ts 的决策路径。
 */

/** 广播类快捷语：说给全场听的，点一下立刻发 */
export const QUICK_BROADCAST = ['谁来救我！', '这波稳了', '我是忠臣', '小心内奸', '再来一局？'];

/** 点名类快捷语：点完还要再点一个人才真正发出去 */
export const QUICK_TARGETED = ['别打我了', '你不讲武德', '我信你个鬼', '打他打他！', '好牌！', '承让'];

/** 表情反应，点名类——道理跟上面的快捷语一样，对着谁发都得先点谁 */
export const EMOJIS = ['👍', '😂', '😱', '🍶', '💢'];

/** 客户端节流窗口，比服务端（room.ts 的 CHAT_THROTTLE_MS=2000）短一点，
 *  纯粹是为了给按钮转灰做即时反馈，真正防刷屏靠服务端 */
const CLIENT_COOLDOWN_MS = 1800;

function useChatCooldown(): boolean {
	const last = useGame((s) => s.lastChatSentAt);
	const [, bump] = useState(0);
	useEffect(() => {
		const left = CLIENT_COOLDOWN_MS - (Date.now() - last);
		if (left <= 0) return;
		const t = setTimeout(() => bump((x) => x + 1), left + 30);
		return () => clearTimeout(t);
	}, [last]);
	return Date.now() - last < CLIENT_COOLDOWN_MS;
}

function nick(view: GameView, id?: string): string {
	return view.players.find((p) => p.id === id)?.nickname ?? '';
}

/**
 * 瞄准提示条：点了点名类快捷语/表情之后出现，告诉玩家"接下来点谁"。
 * 摆在顶部正中、比对手席位（z-index 2）和换将过场（8）都高，短暂盖住一张武将牌
 * 的顶部是能接受的——这本来就是一次玩家主动发起、几秒内会结束的操作。
 */
export function ChatAimBanner() {
	const aim = useGame((s) => s.chatAim);
	const setChatAim = useGame((s) => s.setChatAim);
	if (!aim) return null;
	return (
		<div className="chat-aim">
			<span>
				点一张武将牌，对TA{aim.kind === 'emoji' ? '发' : '喊'}「{aim.text}」
			</span>
			<button className="btn ghost" onClick={() => setChatAim(undefined)}>
				取 消
			</button>
		</div>
	);
}

/**
 * 冒泡：新聊天消息出现在发言者的武将牌旁边，3~4 秒后淡出。
 * 写法照抄 Table.tsx 的 Floats——"游标记录已处理到哪条"，服务端不重推聊天历史，
 * 但 store.chat 数组本身在别的消息触发的 re-render 里也会被引用到，同样要去重。
 * 顶排的对手贴着屏幕上沿，气泡朝上会被裁掉一截，所以按card是在上半屏还是下半屏
 * 决定气泡往上冒还是往下冒（自己一定在下半屏，往上冒；对手一定在上半屏，往下冒）。
 */
export function ChatBubbles({ view }: { view: GameView }) {
	const chat = useGame((s) => s.chat);
	const [bubbles, setBubbles] = useState<
		Array<{ key: number; x: number; y: number; below: boolean; text: string; emoji: boolean }>
	>([]);
	const seen = useRef(0);

	useEffect(() => {
		const fresh = chat.filter((c) => c.at > seen.current);
		if (fresh.length === 0) return;
		seen.current = chat[chat.length - 1].at;

		const spawned: typeof bubbles = [];
		for (const c of fresh) {
			const el = document.querySelector<HTMLElement>(`[data-pid="${CSS.escape(c.fromId)}"]`);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			const below = r.top < window.innerHeight / 2;
			const text = c.kind === 'emoji' ? c.text : c.to ? `${c.text}　→ ${nick(view, c.to)}` : c.text;
			spawned.push({
				key: c.at * 1000 + spawned.length,
				x: r.left + r.width / 2,
				y: below ? r.bottom : r.top,
				below,
				text,
				emoji: c.kind === 'emoji',
			});
		}
		if (spawned.length === 0) return;

		setBubbles((prev) => [...prev, ...spawned]);
		const keys = new Set(spawned.map((b) => b.key));
		setTimeout(() => setBubbles((prev) => prev.filter((b) => !keys.has(b.key))), 3600);
	}, [chat, view]);

	return (
		<div className="floats">
			{bubbles.map((b) => (
				<div
					key={b.key}
					className={`chat-bubble${b.below ? ' chat-bubble--below' : ''}${b.emoji ? ' chat-bubble--emoji' : ''}`}
					style={{ left: b.x, top: b.y }}
				>
					{b.text}
				</div>
			))}
		</div>
	);
}

/**
 * 聊天记录 + 快捷语 + 表情 + 自由输入，整块塞进 Table.tsx 里"战报/聊天"两个标签页
 * 共用的那个面板（见 LogPanel）。观战/已阵亡的人也能发——这里完全不看 view.ask
 * 或任何决策状态，只要连着房间就能发言。
 */
export function ChatLog({ view }: { view: GameView }) {
	const chat = useGame((s) => s.chat);
	const sendChat = useGame((s) => s.sendChat);
	const setChatAim = useGame((s) => s.setChatAim);
	const cooling = useChatCooldown();
	const [draft, setDraft] = useState('');
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chat]);

	function submit() {
		const text = draft.trim();
		if (!text || cooling) return;
		sendChat(text);
		setDraft('');
	}

	return (
		<div className="chat-dock">
			<div className="chat-dock__list" ref={listRef}>
				{chat.length === 0 && <div className="chat-dock__empty">还没人说话，抢个头彩？</div>}
				{chat.map((c, i) => (
					<div className="chat-dock__line" key={i}>
						<b>{c.from}</b>
						{c.to && <span className="chat-dock__to"> → {nick(view, c.to)}</span>}
						{c.kind === 'emoji' ? <span className="chat-dock__emoji">{c.text}</span> : `：${c.text}`}
					</div>
				))}
			</div>

			{/*
			  快捷语 + 表情挤成一条横向滚动带，而不是照常换行堆成好几排——手机横屏那点
			  高度（战报/聊天这块面板顶多能占屏幕高度的一半，不然会顶到手牌）根本堆不下
			  11 个快捷语 + 5 个表情还要留出输入框的位置。横向滚动只占一行的高度，
			  不管加多少条快捷语都不会把输入框挤出屏幕外（真的挤出去过，见验收记录）。
			*/}
			<div className="chat-dock__quick">
				{QUICK_BROADCAST.map((t) => (
					<button key={t} className="btn ghost chat-dock__phrase" disabled={cooling} onClick={() => sendChat(t)}>
						{t}
					</button>
				))}
				{QUICK_TARGETED.map((t) => (
					<button
						key={t}
						className="btn ghost chat-dock__phrase chat-dock__phrase--aim"
						disabled={cooling}
						onClick={() => setChatAim({ text: t, kind: 'text' })}
					>
						🎯 {t}
					</button>
				))}
				{EMOJIS.map((e) => (
					<button
						key={e}
						className="emoji-btn"
						disabled={cooling}
						onClick={() => setChatAim({ text: e, kind: 'emoji' })}
					>
						{e}
					</button>
				))}
			</div>

			<div className="chat-dock__input">
				<input
					value={draft}
					maxLength={80}
					placeholder="说点什么…"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && submit()}
				/>
				<button className="btn" disabled={cooling || !draft.trim()} onClick={submit}>
					发送
				</button>
			</div>
		</div>
	);
}
