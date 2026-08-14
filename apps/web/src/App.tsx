import { useEffect, useState } from 'react';
import { useGame } from './store.js';
import Table from './components/Table.js';

export default function App() {
	const screen = useGame((s) => s.screen);
	const error = useGame((s) => s.error);

	// 支持 /?r=XXXX 直接进房 —— 房主把链接丢群里，点开就进
	useEffect(() => {
		const r = new URLSearchParams(location.search).get('r');
		if (r && useGame.getState().name) useGame.getState().connect(r);
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

	const canGo = name.trim().length > 0;

	async function create() {
		if (!canGo) return;
		setBusy(true);
		try {
			const r = await fetch('/api/room', { method: 'POST' });
			const { code } = (await r.json()) as { code: string };
			connect(code);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="lobby">
			<div className="lobby__panel">
				<div className="lobby__title">三国杀</div>
				<input
					placeholder="你的昵称"
					value={name}
					maxLength={12}
					onChange={(e) => setName(e.target.value)}
				/>
				<input
					placeholder="房间码（加入他人房间）"
					value={code}
					maxLength={8}
					onChange={(e) => setCode(e.target.value.toUpperCase())}
				/>
				<div className="btn-row" style={{ justifyContent: 'center', marginTop: '2vmin' }}>
					<button className="btn" disabled={!canGo || busy} onClick={create}>
						开 房
					</button>
					<button
						className="btn ghost"
						disabled={!canGo || code.length < 4}
						onClick={() => connect(code)}
					>
						加 入
					</button>
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
