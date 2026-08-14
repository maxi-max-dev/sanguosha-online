import { useEffect, useRef, useState } from 'react';
import { preloadSounds } from './sound.js';
import { useGame } from './store.js';
import Table from './components/Table.js';

export default function App() {
	const screen = useGame((s) => s.screen);
	const error = useGame((s) => s.error);

	/**
	 * 开局自动接回房间。两个来源：
	 *   · URL 的 ?r=XXXX —— 房主把链接丢群里，朋友点开就进
	 *   · localStorage —— 自己刷新、手机息屏后回来，不能把人踢回首页
	 * 断线重连本来就做好了（服务端按 pid 认座位），缺的只是"记得自己在哪个房间"。
	 */
	useEffect(() => {
		const s = useGame.getState();
		if (!s.name) return;
		const code = new URLSearchParams(location.search).get('r') || localStorage.getItem('sgs.room');
		if (code) s.connect(code);
	}, []);

	// 尽早开始解码音效：从首页点"创建/加入房间"到真正进桌出牌之间隔着选将等好几步，
	// 足够这几百 KB 的文件在后台加载完，真正开始出牌时就不会有第一次触发的延迟
	useEffect(() => {
		preloadSounds();
	}, []);

	return (
		<>
			{screen === 'home' && <Home />}
			{screen === 'lobby' && <Lobby />}
			{screen === 'table' && <Table />}
			{error && <div className="toast">{error}</div>}
			<div className="rotate-hint">请横屏使用</div>
		</>
	);
}

function Home() {
	const { name, setName, connect } = useGame();
	const [code, setCode] = useState(new URLSearchParams(location.search).get('r') ?? '');
	const [busy, setBusy] = useState(false);
	const [hint, setHint] = useState('');
	// 房间码是从邀请链接带进来的，不是自己手敲的 —— 据此决定主按钮是谁
	const invited = !!new URLSearchParams(location.search).get('r');
	const nameRef = useRef<HTMLInputElement>(null);
	const codeRef = useRef<HTMLInputElement>(null);

	/**
	 * 两个按钮都**不置灰**。置灰的按钮和这里的"次要按钮"样式都是暗的，
	 * 玩家分不清"坏了"还是"我还缺点什么" —— 与其让他猜，不如让他点得动，
	 * 然后直接把光标送到缺的那一栏。
	 */
	function need(ref: React.RefObject<HTMLInputElement | null>, msg: string): boolean {
		setHint(msg);
		ref.current?.focus();
		setTimeout(() => setHint(''), 2600);
		return false;
	}

	async function create() {
		if (busy) return;
		if (!name.trim()) return void need(nameRef, '先起个昵称吧');
		setBusy(true);
		try {
			const r = await fetch('/api/room', { method: 'POST' });
			const { code } = (await r.json()) as { code: string };
			connect(code);
		} finally {
			setBusy(false);
		}
	}

	function join() {
		if (!name.trim()) return void need(nameRef, '先起个昵称吧');
		if (code.trim().length < 4) return void need(codeRef, '要填朋友给你的 4 位房间码');
		connect(code.trim());
	}

	return (
		<div className="lobby">
			<div className="lobby__panel">
				<div className="lobby__title">三国杀</div>
				{invited && (
					<div className="lobby__invited">
						有人邀请你加入房间 <b>{code}</b>
						<br />
						填个昵称就能进
					</div>
				)}
				<input
					ref={nameRef}
					placeholder="你的昵称"
					value={name}
					maxLength={12}
					onChange={(e) => setName(e.target.value)}
				/>
				<input
					ref={codeRef}
					placeholder="房间码（加入他人房间）"
					value={code}
					maxLength={8}
					onChange={(e) => setCode(e.target.value.toUpperCase())}
					onKeyDown={(e) => e.key === 'Enter' && join()}
				/>
				<div className="hint">{hint || ' '}</div>
				{/*
				  主次按钮要跟着"你是怎么来的"走。
				  朋友是点邀请链接来的（?r=XXXX），房间码已经填好，他要按的是「加入」——
				  但金色主按钮一直是「开房」。按错就开出一个空房间，一个人干等，
				  纳闷大家在哪。这是每个被邀请的人都会走的路，指错了代价很大。
				*/}
				<div className="btn-row" style={{ justifyContent: 'center' }}>
					{invited ? (
						<>
							<button className="btn" onClick={join}>
								加 入 房 间
							</button>
							<button className="btn ghost" onClick={create}>
								自己开房
							</button>
						</>
					) : (
						<>
							<button className="btn" onClick={create}>
								开 房
							</button>
							<button className="btn ghost" onClick={join}>
								加 入
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function Lobby() {
	const { room, lobby, canStart, pid, send, disconnect } = useGame();
	const me = lobby.find((p) => p.pid === pid);
	const humans = lobby.filter((p) => !p.bot).length;
	const link = `${location.origin}/?r=${room}`;

	return (
		<div className="lobby">
			<div className="lobby__panel">
				<div className="lobby__title" style={{ fontSize: '3.4vmin', letterSpacing: '0.8vmin' }}>
					房 间
				</div>
				<div className="lobby__code">{room}</div>

				<button
					className="btn ghost"
					style={{ fontSize: '1.7vmin', minWidth: 'auto', padding: '0.7vmin 1.4vmin' }}
					onClick={() => navigator.clipboard?.writeText(link)}
				>
					复制邀请链接
				</button>

				<div className="seat-list">
					{lobby.map((p) => (
						<div key={p.pid} className={`seat${p.bot ? ' bot' : ''}`}>
							<span>
								{p.name}
								{p.pid === pid && ' （你）'}
							</span>
							<span className="seat__tag">
								{p.host ? '房主' : p.bot ? '机器人' : p.online ? '已就位' : '离线'}
							</span>
						</div>
					))}
				</div>

				<div style={{ fontSize: '1.7vmin', color: 'var(--paper-300)' }}>
					{lobby.length} / 8 人 · 身份局需 5 人开局
					{humans < 5 && lobby.length < 5 && '（人不够可以加机器人）'}
				</div>

				{me?.host && (
					<div className="btn-row" style={{ justifyContent: 'center', marginTop: '2vmin' }}>
						<button className="btn ghost" onClick={() => send({ t: 'addBot' })}>
							+机器人
						</button>
						<button className="btn ghost" onClick={() => send({ t: 'removeBot' })}>
							-机器人
						</button>
						<button className="btn" disabled={!canStart} onClick={() => send({ t: 'start' })}>
							开 始
						</button>
					</div>
				)}
				{!me?.host && (
					<div style={{ marginTop: '2vmin', color: 'var(--gold-300)', fontSize: '2vmin' }}>
						等待房主开始…
					</div>
				)}

				<button
					className="btn ghost"
					style={{ marginTop: '2vmin', fontSize: '1.6vmin', minWidth: 'auto', padding: '0.6vmin 1.2vmin' }}
					onClick={disconnect}
				>
					离开房间
				</button>
			</div>
		</div>
	);
}
