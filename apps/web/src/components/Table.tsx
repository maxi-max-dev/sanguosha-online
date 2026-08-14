import { useEffect, useState } from 'react';
import { ALL_SKILLS, CARDS, GENERALS, type Card, type GameView, type PlayerView } from '@sgs/engine';
import { cardArt, generalArt, rankText, SUIT_SYMBOL } from '../art.js';
import { cardSelectable, optionForCard, useGame } from '../store.js';

const IDENTITY_CN: Record<string, string> = {
	lord: '主',
	loyalist: '忠',
	rebel: '反',
	spy: '内',
};

const FACTION_CN: Record<string, string> = { wei: '魏', shu: '蜀', wu: '吴', qun: '群' };

const PHASE_CN: Record<string, string> = {
	start: '回合开始',
	judge: '判定',
	draw: '摸牌',
	play: '出牌',
	discard: '弃牌',
	end: '回合结束',
};

export default function Table() {
	const view = useGame((s) => s.view);
	if (!view) return null;

	const me = view.players.find((p) => p.id === view.you);
	// 从自己的下家开始顺时针排，这样每个人看到的相对位置都符合"我在下、下家在左"的直觉
	const others = orderOthers(view);

	return (
		<div className="table">
			<div className="opponents">
				{others.map((p) => (
					<Seat key={p.id} p={p} view={view} />
				))}
			</div>

			<Pile view={view} />
			<Center view={view} />
			<LogPanel />

			{me && (
				<>
					<div style={{ position: 'absolute', left: '2vmin', bottom: '1vmin', zIndex: 3 }}>
						<Seat p={me} view={view} self />
					</div>
					<Skills me={me} />
					<Hand view={view} me={me} />
					<Actions view={view} />
				</>
			)}

			<Timer />
			{view.finished && <Result view={view} />}
		</div>
	);
}

function orderOthers(view: GameView): PlayerView[] {
	const seats = [...view.players].sort((a, b) => a.seat - b.seat);
	const i = seats.findIndex((p) => p.id === view.you);
	if (i < 0) return seats;
	return [...seats.slice(i + 1), ...seats.slice(0, i)];
}

// ─────────────────────── 席位 ───────────────────────

function Seat({ p, view, self }: { p: PlayerView; view: GameView; self?: boolean }) {
	const { pickedTargets, toggleTarget } = useGame();
	const ask = view.ask;

	const selectable = isTargetable(view, p.id);
	const selected = pickedTargets.includes(p.id);
	const art = generalArt(p.general);
	const g = GENERALS[p.general];

	const cls = [
		'general',
		self && 'self',
		!p.alive && 'dead',
		view.currentPlayer === p.id && 'current',
		p.chained && 'chained',
		selectable && 'selectable',
		selected && 'selected',
	]
		.filter(Boolean)
		.join(' ');

	return (
		<div className={cls} onClick={() => selectable && toggleTarget(p.id)}>
			{art ? (
				<img className="general__art" src={art} alt={g?.cn ?? p.general} draggable={false} />
			) : (
				<div className="general__art" style={{ background: 'var(--ink-600)' }} />
			)}
			<div className="general__scrim" />

			{/* 还没选将时 general 为空，此时不能渲染名条，否则只剩一条渐变底色的金色斜边 */}
			{g?.cn && <div className="general__name">{g.cn}</div>}
			{g && (
				<div className="general__faction" data-f={p.faction}>
					{FACTION_CN[p.faction]}
				</div>
			)}
			{p.identity && (
				<div className="identity" data-i={p.identity}>
					{IDENTITY_CN[p.identity]}
				</div>
			)}

			{p.judge.length > 0 && (
				<div className="judges">
					{p.judge.map((id) => (
						<div className="judge-mark" key={id} title={cardCn(view, id)}>
							{cardCn(view, id).slice(0, 1)}
						</div>
					))}
				</div>
			)}

			<Equips p={p} view={view} />

			<div className="general__nick">{p.nickname}</div>
			<Hp hp={p.hp} maxHp={p.maxHp} />
			<div className="general__hand">{p.handCount}</div>

			{p.offline && <div className="general__offline">离线托管</div>}
			{ask?.who === p.id && !p.offline && <div className="general__thinking" />}
		</div>
	);
}

function Hp({ hp, maxHp }: { hp: number; maxHp: number }) {
	// 血上限大于 5 就不画珠子了，一串小桃会溢出牌宽
	if (maxHp > 5) {
		return (
			<div className={`hp${hp <= 1 ? ' critical' : ''}`}>
				<span className="hp__num">
					{hp}/{maxHp}
				</span>
			</div>
		);
	}
	return (
		<div className={`hp${hp <= 1 ? ' critical' : ''}`}>
			{Array.from({ length: maxHp }, (_, i) => (
				<div key={i} className={`hp__bead${i < hp ? ' full' : ''}`} />
			))}
		</div>
	);
}

function Equips({ p, view }: { p: PlayerView; view: GameView }) {
	const slots = ['weapon', 'armor', 'horsePlus', 'horseMinus'] as const;
	const items = slots
		.map((s) => ({ slot: s, id: p.equip[s] }))
		.filter((x): x is { slot: (typeof slots)[number]; id: number } => typeof x.id === 'number');
	if (items.length === 0) return null;
	return (
		<div className="equips">
			{items.map(({ slot, id }) => (
				<div className="equip" key={slot}>
					{cardCn(view, id)}
				</div>
			))}
		</div>
	);
}

// ─────────────────────── 中央 ───────────────────────

function Pile({ view }: { view: GameView }) {
	return (
		<div className="pile">
			<div className="pile__stack">{view.drawCount}</div>
			<div className="pile__label">牌堆</div>
			<div className="pile__label">
				第 {view.round + 1} 轮 · {PHASE_CN[view.phase] ?? view.phase}
			</div>
		</div>
	);
}

function Center({ view }: { view: GameView }) {
	const cards = view.processing.length ? view.processing : view.discardTop.slice(-3);
	return (
		<div className="center">
			<div className="center__cards">
				{cards.map((id) => (
					<CardFace key={id} card={view.cards[id]} />
				))}
			</div>
		</div>
	);
}

// ─────────────────────── 卡牌 ───────────────────────

export function CardFace({
	card,
	nature,
	onClick,
	className = '',
}: {
	card?: Card;
	nature?: string;
	onClick?: () => void;
	className?: string;
}) {
	if (!card) return <div className={`card back ${className}`} onClick={onClick} />;

	const def = CARDS[card.name];
	const art = cardArt(card.name);
	const color = card.suit === 'heart' || card.suit === 'diamond' ? 'red' : 'black';

	return (
		<div className={`card ${art ? '' : 'no-art'} ${className}`} onClick={onClick}>
			{art && <img className="card__art" src={art} alt={def?.cn ?? card.name} draggable={false} />}
			{/* 牌名常驻：素材是灰调线稿，光看图分不出杀和闪 */}
			<div className="card__name">{def?.cn ?? card.name}</div>
			<div className="card__pip" data-c={color}>
				{SUIT_SYMBOL[card.suit]}
				<br />
				{rankText(card.number)}
			</div>
			{(nature ?? def?.nature) && (
				<div className="card__nature" data-n={nature ?? def?.nature}>
					{(nature ?? def?.nature) === 'fire' ? '火' : '雷'}
				</div>
			)}
		</div>
	);
}

// ─────────────────────── 手牌 ───────────────────────

function Hand({ view, me }: { view: GameView; me: PlayerView }) {
	const { pickedCards, toggleCard, pickOption, pickedOption } = useGame();
	const hand = me.hand ?? [];
	// 牌多了就叠得更紧，保证始终在一行里放得下
	const overlap = hand.length > 6 ? `${-2.4 - (hand.length - 6) * 0.9}vmin` : '-2.4vmin';

	return (
		<div className="hand">
			{hand.map((id) => {
				const selectable = cardSelectable(view, id);
				const selected = pickedCards.includes(id) || optionForCard(view, id)?.id === pickedOption;
				return (
					<div className="hand__slot" key={id} style={{ '--overlap': overlap } as React.CSSProperties}>
						<CardFace
							card={view.cards[id]}
							className={`${selectable ? '' : 'disabled'} ${selected ? 'selected' : ''}`}
							onClick={() => {
								if (!selectable) return;
								const ask = view.ask;
								if (ask?.kind === 'playPhase' || ask?.kind === 'respond') {
									const opt = optionForCard(view, id);
									pickOption(pickedOption === opt?.id ? undefined : opt?.id);
								} else {
									toggleCard(id);
								}
							}}
						/>
					</div>
				);
			})}
		</div>
	);
}

// ─────────────────────── 技能 ───────────────────────

function Skills({ me }: { me: PlayerView }) {
	const view = useGame((s) => s.view);
	const { pickOption, pickedOption } = useGame();
	const ask = view?.ask;

	return (
		<div className="skills">
			{me.skills.map((sid) => {
				const s = ALL_SKILLS[sid];
				if (!s) return null;
				const opt =
					ask?.kind === 'playPhase'
						? ask.options.find((o) => o.viaSkill === sid && o.cards.length === 0)
						: undefined;
				return (
					<button
						key={sid}
						className={`skill-btn${opt ? ' ready' : ''}${pickedOption === opt?.id ? ' ready' : ''}`}
						disabled={!opt}
						title={s.desc}
						onClick={() => opt && pickOption(pickedOption === opt.id ? undefined : opt.id)}
					>
						{s.cn}
					</button>
				);
			})}
		</div>
	);
}

// ─────────────────────── 操作区 ───────────────────────

function Actions({ view }: { view: GameView }) {
	const { commit, pass, pickedCards, pickedTargets, pickedOption, hint } = useGame();
	const ask = view.ask;

	if (!ask) {
		return hint ? (
			<div className="actions">
				<div className="prompt">
					等待 {view.players.find((p) => p.id === hint.who)?.nickname ?? ''} …
				</div>
			</div>
		) : null;
	}

	const ready = isReady(view, pickedCards, pickedTargets, pickedOption);

	/**
	 * 多选一（选将、刚烈二选一…）是**原子**选择：没有可以逐步累积的东西，
	 * 所以点一下就该定下来，不该再要一次"确定"。之前分两步，而且"确定"还画在
	 * 选项上面，读起来是反的 —— 玩家选完武将就卡住不动了。
	 */
	if (ask.kind === 'chooseOption') {
		return (
			<div className="actions">
				<div className="prompt">{ask.prompt}</div>
				<OptionRow ask={ask} />
				{ask.cancelable && (
					<div className="btn-row">
						<button className="btn ghost" onClick={pass}>
							取 消
						</button>
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="actions">
			<div className="prompt">{ask.prompt}</div>
			<div className="btn-row">
				<button className="btn" disabled={!ready} onClick={commit}>
					确 定
				</button>
				{ask.cancelable && (
					<button className="btn ghost" onClick={pass}>
						{ask.kind === 'playPhase' ? '结束回合' : '取 消'}
					</button>
				)}
			</div>
		</div>
	);
}

function OptionRow({ ask }: { ask: Extract<GameView['ask'], { kind: 'chooseOption' }> }) {
	const { pickAndCommitOption } = useGame();
	return (
		<div className="btn-row option-row">
			{ask.options.map((o) => (
				<button
					key={o.id}
					className="btn ghost"
					disabled={o.disabled}
					onClick={() => pickAndCommitOption(o.id)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

// ─────────────────────── 读秒 / 战报 / 结算 ───────────────────────

function Timer() {
	const deadline = useGame((s) => s.deadline);
	const ask = useGame((s) => s.view?.ask);
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		if (!deadline) return;
		const t = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(t);
	}, [deadline]);

	if (!deadline || !ask) return null;
	const total = ask.timeout * 1000;
	const left = Math.max(0, deadline - now);
	const ratio = Math.min(1, left / total);

	return (
		<div className="timer">
			<div
				className={`timer__fill${ratio < 0.3 ? ' urgent' : ''}`}
				style={{ transform: `scaleX(${ratio})` }}
			/>
		</div>
	);
}

function LogPanel() {
	const log = useGame((s) => s.log);
	const view = useGame((s) => s.view);
	if (!view) return null;
	const lines = log.map((e) => describe(e, view)).filter(Boolean).slice(-12);
	return (
		<div className="log">
			{lines.map((l, i) => (
				<div className="log__line" key={i}>
					{l}
				</div>
			))}
		</div>
	);
}

function Result({ view }: { view: GameView }) {
	const won = view.finished!.winners.includes(view.you);
	return (
		<div className="lobby" style={{ position: 'absolute', inset: 0, background: 'rgba(15,13,11,0.9)' }}>
			<div className="lobby__panel">
				<div className="lobby__title" style={{ fontSize: '5vmin' }}>
					{won ? '胜 利' : '失 败'}
				</div>
				<div style={{ fontSize: '2.4vmin', color: 'var(--gold-200)', margin: '2vmin 0' }}>
					{view.finished!.reason}
				</div>
				<div className="seat-list">
					{view.players.map((p) => (
						<div key={p.id} className="seat">
							<span>
								{p.nickname} · {GENERALS[p.general]?.cn ?? ''}
							</span>
							<span className="seat__tag">
								{IDENTITY_CN[p.identity ?? ''] ?? '?'}
								{p.alive ? '' : ' · 阵亡'}
							</span>
						</div>
					))}
				</div>
				<button className="btn" onClick={() => location.reload()}>
					再 来 一 局
				</button>
			</div>
		</div>
	);
}

// ─────────────────────── 工具 ───────────────────────

function cardCn(view: GameView, id: number): string {
	const c = view.cards[id];
	return c ? (CARDS[c.name]?.cn ?? c.name) : '？';
}

function nick(view: GameView, id?: string): string {
	return view.players.find((p) => p.id === id)?.nickname ?? '';
}

/** 该角色现在能否被选为目标 —— 完全读服务端下发的候选列表，前端不做规则判断 */
function isTargetable(view: GameView, pid: string): boolean {
	const ask = view.ask;
	if (!ask) return false;
	if (ask.kind === 'choosePlayers') return ask.candidates.includes(pid);
	if (ask.kind === 'playPhase' || ask.kind === 'respond') {
		const picked = useGame.getState().pickedOption;
		const opt = ask.options.find((o) => o.id === picked);
		if (!opt || opt.targets.auto) return false;
		return opt.targets.candidates.includes(pid);
	}
	return false;
}

function isReady(
	view: GameView,
	cards: number[],
	targets: string[],
	option?: string,
): boolean {
	const ask = view.ask;
	if (!ask) return false;
	switch (ask.kind) {
		case 'playPhase':
		case 'respond': {
			const opt = ask.options.find((o) => o.id === option);
			if (!opt) return false;
			if (opt.targets.auto) return true;
			return targets.length >= opt.targets.min && targets.length <= opt.targets.max;
		}
		case 'discard':
		case 'chooseCards':
			return cards.length >= ask.min && cards.length <= ask.max;
		case 'choosePlayers':
			return targets.length >= ask.min && targets.length <= ask.max;
		case 'confirmSkill':
			return true;
		case 'chooseOption':
			return !!option;
		default:
			return true;
	}
}

/** 把引擎日志翻成人话。只覆盖玩家真正需要看到的事件 */
function describe(e: { kind: string; [k: string]: unknown }, view: GameView): string {
	const who = (k: string) => nick(view, e[k] as string);
	switch (e.kind) {
		case 'use':
			return `${who('source')} 使用【${CARDS[e.name as string]?.cn ?? e.name}】${
				(e.targets as string[])?.length ? ` → ${(e.targets as string[]).map((t) => nick(view, t)).join('、')}` : ''
			}`;
		case 'respond':
			return `${who('who')} 打出【${CARDS[e.name as string]?.cn ?? e.name}】`;
		case 'damage':
			return `${who('target')} 受到 ${e.amount} 点${
				e.nature === 'fire' ? '火焰' : e.nature === 'thunder' ? '雷电' : ''
			}伤害`;
		case 'recover':
			return `${who('target')} 回复 ${e.amount} 点体力`;
		case 'skill':
			return `${who('who')} 发动【${ALL_SKILLS[e.skill as string]?.cn ?? e.skill}】`;
		case 'judge':
			return `${who('who')} 判定`;
		case 'dying':
			return `${who('who')} 濒死`;
		case 'die':
			return `${who('who')} 阵亡`;
		case 'turnStart':
			return `── ${who('who')} 的回合 ──`;
		default:
			return '';
	}
}
