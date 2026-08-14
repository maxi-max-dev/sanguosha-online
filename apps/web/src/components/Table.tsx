import { useEffect, useRef, useState } from 'react';
import { ALL_SKILLS, CARDS, GENERALS, type Card, type GameView, type PlayerView, type PlayOption } from '@sgs/engine';
import { cardArt, generalArt, rankText, SUIT_CN, SUIT_SYMBOL } from '../art.js';
import { play, useSound } from '../sound.js';
import { cardSelectable, optionsForCard, useGame } from '../store.js';

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

const ZONE_CN: Record<string, string> = {
	hand: '手牌',
	equip: '装备区',
	judge: '判定区',
};

/**
 * 状态角标的中文名表。PlayerView.marks 是 view.ts 的 publicMarks 已经按白名单
 * 下发好的原始 flag，这里只管展示，不做任何规则判断。flag key 是拼音，
 * 加新状态要显示时在这补一行就行。
 */
const MARK_LABEL: Record<string, (v: number) => string> = {
	'turn:jiuActive': () => '酒',
	'turn:shaUsed': (v) => `杀×${v}`,
};

export default function Table() {
	const view = useGame((s) => s.view);
	const [inspect, setInspect] = useState<string | undefined>();
	// 新请求一来就把武将详情关掉：选牌浮层这类全屏面板会盖住整张桌子，
	// 之前开着的 Inspect 会卡在下面收不到点击，看起来像点不动
	useEffect(() => {
		if (view?.ask) setInspect(undefined);
	}, [view?.ask?.seq]);
	if (!view) return null;

	const me = view.players.find((p) => p.id === view.you);
	// 从自己的下家开始顺时针排，这样每个人看到的相对位置都符合"我在下、下家在左"的直觉
	const others = orderOthers(view);

	return (
		<div className="table">
			<div className="opponents">
				{others.map((p) => (
					<Seat key={p.id} p={p} view={view} onInspect={setInspect} />
				))}
			</div>
			{inspect && (
				<Inspect
					p={view.players.find((x) => x.id === inspect)!}
					onClose={() => setInspect(undefined)}
				/>
			)}

			<Pile view={view} />
			<Center view={view} />
			<LogPanel />

			{me && (
				<>
					<div style={{ position: 'absolute', left: '2vmin', bottom: '1vmin', zIndex: 3 }}>
						<Seat p={me} view={view} self onInspect={setInspect} />
					</div>
					<Skills me={me} />
					<Hand view={view} me={me} />
					<Actions view={view} />
				</>
			)}

			<Timer />
			<FlyingCards view={view} />
			<Floats view={view} />
			<SoundEffects view={view} />
			<SoundToggle />
			{view.finished && <Result view={view} />}
		</div>
	);
}

/**
 * 出牌动画：牌从出牌人的座位飞向牌桌中央，指定了目标就再从中央扑向目标。
 *
 * 之前牌是凭空出现在中央的 —— 5~8 人同桌时，光看中间那张牌根本分不清是谁打谁。
 * 这里飞的是一张"残影"，和真实的中央区渲染无关，所以不会和状态同步打架。
 */
function FlyingCards({ view }: { view: GameView }) {
	const log = useGame((s) => s.log);
	const [flights, setFlights] = useState<
		Array<{ key: number; from: DOMRect; to: DOMRect; card?: Card; name: string }>
	>([]);
	const seen = useRef(-1);

	useEffect(() => {
		if (log.length === 0) return;
		const fresh = log.filter((e) => e.t > seen.current && (e.kind === 'use' || e.kind === 'respond'));
		seen.current = log.length ? log[log.length - 1].t : seen.current;
		if (fresh.length === 0) return;

		const rectOf = (pid: string) =>
			document.querySelector<HTMLElement>(`[data-pid="${CSS.escape(pid)}"]`)?.getBoundingClientRect();
		const center = document.querySelector<HTMLElement>('.center')?.getBoundingClientRect();
		if (!center) return;

		const next: typeof flights = [];
		for (const e of fresh) {
			const src = (e.source ?? e.who) as string | undefined;
			if (!src) continue;
			const from = rectOf(src);
			if (!from) continue;
			// 有目标就飞向目标，没有就停在中央
			const targets = (e.targets as string[] | undefined) ?? [];
			const to = targets.length === 1 ? rectOf(targets[0]) ?? center : center;
			const ids = (e.cards as number[] | undefined) ?? [];
			next.push({
				key: e.t,
				from,
				to,
				card: ids.length ? view.cards[ids[0]] : undefined,
				name: e.name as string,
			});
		}
		if (next.length === 0) return;

		setFlights((prev) => [...prev, ...next]);
		const keys = new Set(next.map((n) => n.key));
		setTimeout(() => setFlights((prev) => prev.filter((f) => !keys.has(f.key))), 620);
	}, [log, view]);

	return (
		<div className="floats">
			{flights.map((f) => (
				<div
					key={f.key}
					className="fly"
					style={
						{
							'--x0': `${f.from.left + f.from.width / 2}px`,
							'--y0': `${f.from.top + f.from.height / 2}px`,
							'--x1': `${f.to.left + f.to.width / 2}px`,
							'--y1': `${f.to.top + f.to.height / 2}px`,
						} as React.CSSProperties
					}
				>
					<CardFace card={f.card} />
					{!f.card && <div className="fly__name">{CARDS[f.name]?.cn ?? f.name}</div>}
				</div>
			))}
		</div>
	);
}

/**
 * 伤害/回血/技能的飘字，锚在当事人的座位上。
 *
 * 没有这个的话，别人对你出杀只是中间冒出一张牌，掉没掉血、掉了几点全靠自己盯血条 ——
 * 牌桌上同时有 5~8 个人时根本跟不上。飘字是最低成本的"刚刚发生了什么"。
 */
function Floats({ view }: { view: GameView }) {
	const log = useGame((s) => s.log);
	const [items, setItems] = useState<Array<{ key: number; x: number; y: number; kind: string; text: string }>>([]);
	// 只处理没见过的日志条目；服务端每次推的是最近 40 条，会大量重复
	const seen = useRef(-1);

	useEffect(() => {
		if (log.length === 0) return;
		const fresh = log.filter((e) => e.t > seen.current);
		if (fresh.length === 0) return;
		seen.current = log[log.length - 1].t;

		const spawned: typeof items = [];
		for (const e of fresh) {
			const f = floatFor(e, view);
			if (!f) continue;
			const el = document.querySelector<HTMLElement>(`[data-pid="${CSS.escape(f.who)}"]`);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			spawned.push({
				key: e.t * 1000 + spawned.length,
				x: r.left + r.width / 2,
				y: r.top + r.height * 0.42,
				kind: f.kind,
				text: f.text,
			});
		}
		if (spawned.length === 0) return;

		setItems((prev) => [...prev, ...spawned]);
		const keys = new Set(spawned.map((s) => s.key));
		setTimeout(() => setItems((prev) => prev.filter((i) => !keys.has(i.key))), 1200);
	}, [log, view]);

	return (
		<div className="floats">
			{items.map((i) => (
				<div key={i.key} className={`float ${i.kind}`} style={{ left: i.x, top: i.y }}>
					{i.text}
				</div>
			))}
		</div>
	);
}

function floatFor(
	e: { kind: string; [k: string]: unknown },
	view: GameView,
): { who: string; kind: string; text: string } | null {
	switch (e.kind) {
		case 'damage': {
			const n = e.amount as number;
			const nat = e.nature === 'fire' ? '🔥' : e.nature === 'thunder' ? '⚡' : '';
			return { who: e.target as string, kind: 'damage', text: `${nat}-${n}` };
		}
		case 'loseHp':
			return { who: e.target as string, kind: 'damage', text: `-${e.amount as number}` };
		case 'recover':
			return { who: e.target as string, kind: 'recover', text: `+${e.amount as number}` };
		case 'skill': {
			const s = ALL_SKILLS[e.skill as string];
			return s ? { who: e.who as string, kind: 'skill', text: s.cn } : null;
		}
		case 'dying':
			return { who: e.who as string, kind: 'damage', text: '濒死' };
		case 'wuxie':
			return { who: e.who as string, kind: 'skill', text: '无懈可击' };
		default:
			void view;
			return null;
	}
}

/**
 * 音效：跟 Floats 是一模一样的"游标记录已处理到哪条"写法 —— 服务端每次推的
 * 是最近 40 条战报，不去重的话每次 log 更新都会把这 40 条全部重播一遍。
 * 这个组件不渲染任何东西，纯粹是拿 useEffect 当日志订阅的钩子。
 */
function SoundEffects({ view }: { view: GameView }) {
	const log = useGame((s) => s.log);
	const seen = useRef(-1);

	useEffect(() => {
		if (log.length === 0) return;
		const fresh = log.filter((e) => e.t > seen.current);
		if (fresh.length === 0) return;
		seen.current = log[log.length - 1].t;

		for (const e of fresh) soundFor(e, view);
	}, [log, view]);

	return null;
}

function soundFor(e: { kind: string; [k: string]: unknown }, view: GameView): void {
	switch (e.kind) {
		case 'use':
			play('use');
			break;
		case 'respond':
			play('respond');
			break;
		case 'damage': {
			const nature = e.nature as string | undefined;
			play(nature === 'fire' ? 'damageFire' : nature === 'thunder' ? 'damageThunder' : 'damage');
			break;
		}
		case 'recover':
			play('recover');
			break;
		case 'judge':
			play('judge');
			break;
		case 'die': {
			// noname 按性别分了两条通用阵亡音效，view 里玩家自带 gender 字段，直接对上
			const gender = view.players.find((p) => p.id === (e.who as string))?.gender;
			play(gender === 'female' ? 'dieFemale' : 'dieMale');
			break;
		}
		case 'move': {
			const reason = e.reason as string | undefined;
			if (reason === 'draw' || reason === 'drawPhase') play('draw');
			break;
		}
		// turnStart：noname 里没有贴切的通用音效可用，见 tools/audio/fetch-audio.mjs 的说明，故意不播
		default:
			break;
	}
}

/** 静音按钮：默认开启，状态存本地，跟牌局本身无关所以摆在不挡视线的左上角 */
function SoundToggle() {
	const muted = useSound((s) => s.muted);
	const toggle = useSound((s) => s.toggle);
	return (
		<button
			className="skill-btn sound-toggle"
			onClick={toggle}
			title={muted ? '开启音效' : '关闭音效'}
		>
			{muted ? '🔇' : '🔊'}
		</button>
	);
}

function orderOthers(view: GameView): PlayerView[] {
	const seats = [...view.players].sort((a, b) => a.seat - b.seat);
	const i = seats.findIndex((p) => p.id === view.you);
	if (i < 0) return seats;
	return [...seats.slice(i + 1), ...seats.slice(0, i)];
}

// ─────────────────────── 席位 ───────────────────────

function Seat({
	p,
	view,
	self,
	onInspect,
}: {
	p: PlayerView;
	view: GameView;
	self?: boolean;
	onInspect?: (id: string) => void;
}) {
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
		<div
			className={cls}
			data-pid={p.id}
			// 可选中时点击=指定目标；否则点击=查看这个武将的技能（公开信息）
			onClick={() => (selectable ? toggleTarget(p.id) : p.general && onInspect?.(p.id))}
		>
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
			<Marks p={p} />

			<div className="general__nick">{p.nickname}</div>
			<Hp hp={p.hp} maxHp={p.maxHp} />
			<div className="general__hand">{p.handCount}</div>

			{p.offline && <div className="general__offline">离线托管</div>}
			{ask?.who === p.id && !p.offline && <div className="general__thinking" />}
		</div>
	);
}

/**
 * 状态角标：酒、已出杀数……都是服务端已经下发的公开 flag（PlayerView.marks），
 * 之前没人读，玩家用了酒也不知道生效没有。见文件头 MARK_LABEL。
 */
function Marks({ p }: { p: PlayerView }) {
	const items = Object.entries(p.marks)
		.map(([k, v]) => (v > 0 ? MARK_LABEL[k]?.(v) : undefined))
		.filter((x): x is string => !!x);
	if (items.length === 0) return null;
	return (
		<div className="marks">
			{items.map((t) => (
				<div className="mark" key={t}>
					{t}
				</div>
			))}
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

/**
 * 中央区。有牌正在结算时展示"谁 → 对谁 → 用了什么"，否则退回展示弃牌堆顶。
 * 之前不加区分地把弃牌堆画在正中间，看着像"这些牌正在生效"，其实早结算完了。
 */
function Center({ view }: { view: GameView }) {
	const log = useGame((s) => s.log);
	const playing = view.processing.length > 0;
	const cards = playing ? view.processing : view.discardTop.slice(-3);

	// 最近一条 use 事件就是当前正在结算的那张
	const lastUse = playing
		? [...log].reverse().find((e) => e.kind === 'use') as
				| { source: string; name: string; targets?: string[] }
				| undefined
		: undefined;

	const caption = lastUse
		? `${nick(view, lastUse.source)}　【${CARDS[lastUse.name]?.cn ?? lastUse.name}】${
				lastUse.targets?.length
					? `　→　${lastUse.targets.map((t) => nick(view, t)).join('、')}`
					: ''
			}`
		: '';

	return (
		<div className="center">
			{caption && <div className="center__caption">{caption}</div>}
			<div className={`center__cards${playing ? '' : ' idle'}`}>
				{cards.map((id) => (
					<CardFace key={id} card={view.cards[id]} />
				))}
			</div>
			{!playing && cards.length > 0 && <div className="center__label">弃牌堆</div>}
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
	const { pickedCards, toggleCard, pickOption, pickedOption, cardMenu, setCardMenu } = useGame();
	const hand = me.hand ?? [];
	// 牌多了就叠得更紧，保证始终在一行里放得下
	const overlap = hand.length > 6 ? `${-2.4 - (hand.length - 6) * 0.9}vmin` : '-2.4vmin';

	return (
		<div className="hand">
			{hand.map((id) => {
				const selectable = cardSelectable(view, id);
				const opts = optionsForCard(view, id);
				const selected = pickedCards.includes(id) || opts.some((o) => o.id === pickedOption);
				return (
					<div className="hand__slot" key={id} style={{ '--overlap': overlap } as React.CSSProperties}>
						{/* 一张牌有多种打法（转化技/重铸）时先弹菜单选，别自作主张挑第一个 */}
						{cardMenu === id && (
							<CardOptionMenu
								options={opts}
								onPick={(o) => {
									pickOption(pickedOption === o.id ? undefined : o.id);
									setCardMenu(undefined);
								}}
							/>
						)}
						<CardFace
							card={view.cards[id]}
							className={`${selectable ? '' : 'disabled'} ${selected ? 'selected' : ''}`}
							onClick={() => {
								if (!selectable) return;
								const ask = view.ask;
								if (ask?.kind === 'playPhase' || ask?.kind === 'respond') {
									if (opts.length <= 1) {
										pickOption(pickedOption === opts[0]?.id ? undefined : opts[0]?.id);
										setCardMenu(undefined);
									} else {
										setCardMenu(cardMenu === id ? undefined : id);
									}
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

/**
 * 一张牌的"用法"浮层：转化技/重铸这些额外打法，服务端早算好随 options 下发，
 * 之前前端永远只取第一个，武圣/龙胆/倾国这类转化技等于点不出来（见 DIAGNOSIS A5）。
 */
function CardOptionMenu({ options, onPick }: { options: PlayOption[]; onPick: (o: PlayOption) => void }) {
	return (
		<div className="card-menu">
			{options.map((o) => (
				<button key={o.id} className="card-menu__btn" onClick={() => onPick(o)}>
					{cardOptionLabel(o)}
				</button>
			))}
		</div>
	);
}

function cardOptionLabel(o: PlayOption): string {
	if (o.recast) return '重铸';
	const name = CARDS[o.name]?.cn ?? o.name;
	return o.viaSkill ? `当【${name}】· ${ALL_SKILLS[o.viaSkill]?.cn ?? o.viaSkill}` : `当【${name}】`;
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
		// 选将要看得见立绘、体力和技能说明 —— 只给三个名字按钮，
		// 不熟三国杀的朋友第一步就懵了
		const isGeneralPick = ask.options.every((o) => GENERALS[o.id]);
		if (isGeneralPick) return <GeneralPicker ask={ask} />;

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

	/**
	 * 选牌 / 分配是全屏浮层（照抄 Inspect 的写法）：候选牌可能是别人手牌/装备区/
	 * 判定区里的，Hand 组件根本画不出来，必须单独起一块地方展示。
	 */
	// 花色四选一（反间）和多选一一样是原子选择，点一下就定，不再要一次"确定"
	if (ask.kind === 'chooseSuit') return <ChooseSuitPicker ask={ask} />;

	if (ask.kind === 'chooseCards') return <ChooseCardsPicker ask={ask} view={view} />;
	if (ask.kind === 'distribute') return <DistributePicker ask={ask} view={view} />;
	if (ask.kind === 'arrange') return <ArrangePicker ask={ask} view={view} />;

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

/**
 * chooseCards 的选牌浮层：过河拆桥/顺手牵羊/火攻/五谷丰登/司马懿反馈……所有
 * "从若干候选牌里选几张"的技能共用这一套 UI。候选牌按 from+zone 分组展示成
 * "谁的手牌/装备区/判定区"；unknown 的牌只画牌背，绝不去 view.cards 里取牌面——
 * 服务端本来就没把这些条目下发给我们，这是防作弊边界，不是能不能拿到的问题。
 */
function ChooseCardsPicker({
	ask,
	view,
}: {
	ask: Extract<GameView['ask'], { kind: 'chooseCards' }>;
	view: GameView;
}) {
	const { pickedCards, toggleCard, commit, pass } = useGame();
	const ready = pickedCards.length >= ask.min && pickedCards.length <= ask.max;

	const groups: Array<{ label: string; cards: typeof ask.candidates }> = [];
	const index = new Map<string, number>();
	for (const c of ask.candidates) {
		const key = `${c.from ?? ''}:${c.zone ?? ''}`;
		let i = index.get(key);
		if (i === undefined) {
			i = groups.length;
			index.set(key, i);
			// 没有 from 的是自己的牌或五谷丰登那种亮出来的公共牌，不特意加标题
			const label = c.from ? `${nick(view, c.from)} 的${ZONE_CN[c.zone ?? ''] ?? ''}` : '';
			groups.push({ label, cards: [] });
		}
		groups[i].cards.push(c);
	}

	return (
		<div className="picker">
			<div className="picker__title">{ask.prompt}</div>
			<div className="choose-cards">
				{groups.map((grp, i) => (
					<div className="choose-cards__group" key={i}>
						{grp.label && <div className="choose-cards__label">{grp.label}</div>}
						<div className="choose-cards__row">
							{grp.cards.map((c) => (
								<CardFace
									key={c.id}
									card={c.unknown ? undefined : view.cards[c.id]}
									className={pickedCards.includes(c.id) ? 'selected' : ''}
									onClick={() => toggleCard(c.id)}
								/>
							))}
						</div>
					</div>
				))}
			</div>
			<div className="btn-row">
				<button className="btn" disabled={!ready} onClick={commit}>
					确 定
				</button>
				{ask.cancelable && (
					<button className="btn ghost" onClick={pass}>
						取 消
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * distribute 的分配浮层（郭嘉遗计）：列出待分配的牌，每张牌下面一排角色按钮，
 * 点一下分给谁；没点的牌服务端会按语义留给自己（见 skills/wei.ts 的 distributeCards）。
 */
function DistributePicker({
	ask,
	view,
}: {
	ask: Extract<GameView['ask'], { kind: 'distribute' }>;
	view: GameView;
}) {
	const { pickedAssign, setAssign, commit, pass } = useGame();

	return (
		<div className="picker">
			<div className="picker__title">{ask.prompt}</div>
			<div className="distribute">
				{ask.cards.map((id) => {
					const assigned = pickedAssign.find((a) => a.card === id)?.to;
					return (
						<div className="distribute__row" key={id}>
							<CardFace card={view.cards[id]} />
							<div className="distribute__targets">
								{ask.candidates.map((pid) => (
									<button
										key={pid}
										className={`btn ghost distribute__btn${assigned === pid ? ' active' : ''}`}
										onClick={() => setAssign(id, assigned === pid ? undefined : pid)}
									>
										{nick(view, pid)}
									</button>
								))}
							</div>
						</div>
					);
				})}
			</div>
			<div className="btn-row">
				<button className="btn" onClick={commit}>
					确 定
				</button>
				{ask.cancelable && (
					<button className="btn ghost" onClick={pass}>
						取 消
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * arrange 的排序浮层（观星）：这几张牌只有发动者能看，服务端下发的就是真实牌面，
 * 正常用 CardFace 画即可。牌堆顶那组的顺序有意义（数组第一个最先摸到），用上下移
 * 按钮调；两个区之间可以来回丢，顶区满了（到 maxTop）就不让再放，交互不做拖拽。
 */
function ArrangePicker({
	ask,
	view,
}: {
	ask: Extract<GameView['ask'], { kind: 'arrange' }>;
	view: GameView;
}) {
	const { arrangeTop, arrangeBottom, moveArrangeCard, moveArrangeOrder, commit, pass } = useGame();

	return (
		<div className="picker">
			<div className="picker__title">{ask.prompt}</div>
			<div className="arrange">
				<div className="arrange__zone">
					<div className="arrange__label">
						{ask.topLabel}（最多 {ask.maxTop} 张 · 先后有序，最前的最先摸到）
					</div>
					<div className="arrange__row">
						{arrangeTop.map((id, i) => (
							<div className="arrange__card" key={id}>
								<CardFace card={view.cards[id]} />
								<div className="arrange__ctrl">
									<button disabled={i === 0} onClick={() => moveArrangeOrder(id, -1)}>
										↑
									</button>
									<button disabled={i === arrangeTop.length - 1} onClick={() => moveArrangeOrder(id, 1)}>
										↓
									</button>
									<button onClick={() => moveArrangeCard(id, 'bottom')}>放到{ask.bottomLabel}</button>
								</div>
							</div>
						))}
					</div>
				</div>
				<div className="arrange__zone">
					<div className="arrange__label">{ask.bottomLabel}</div>
					<div className="arrange__row">
						{arrangeBottom.map((id) => (
							<div className="arrange__card" key={id}>
								<CardFace card={view.cards[id]} />
								<div className="arrange__ctrl">
									<button
										disabled={arrangeTop.length >= ask.maxTop}
										onClick={() => moveArrangeCard(id, 'top')}
									>
										放到{ask.topLabel}
									</button>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
			<div className="btn-row">
				<button className="btn" onClick={commit}>
					确 定
				</button>
				{ask.cancelable && (
					<button className="btn ghost" onClick={pass}>
						取 消
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * 武将详情。点自己的牌看自己的技能，点别人的看别人的 —— 武将技能是公开信息，
 * 桌上谁有什么本事本来就该人人可见。之前只有 title 提示，手机上根本没有 hover。
 */
function Inspect({ p, onClose }: { p: PlayerView; onClose: () => void }) {
	const g = GENERALS[p.general];
	if (!g) return null;
	const art = generalArt(g.id);
	return (
		<div className="picker" onClick={onClose}>
			<div className="picker__title">{p.nickname}</div>
			<div className="picker__grid" onClick={(e) => e.stopPropagation()}>
				<div className="pick" style={{ width: '42vmin', cursor: 'default' }}>
					<div className="pick__art" style={{ height: '20vmin' }}>
						{art && <img src={art} alt={g.cn} draggable={false} />}
						<span className="pick__faction" data-f={g.faction}>
							{FACTION_CN[g.faction]}
						</span>
					</div>
					<div className="pick__body">
						<div className="pick__head">
							<span className="pick__name">{g.cn}</span>
							<span className="pick__hp">
								{Array.from({ length: p.maxHp }, (_, i) => (
									<i key={i} style={i >= p.hp ? { filter: 'grayscale(1) brightness(0.4)' } : undefined} />
								))}
							</span>
						</div>
						{p.skills.map((sid) => {
							const s = ALL_SKILLS[sid];
							if (!s) return null;
							return (
								<div className="pick__skill" key={sid}>
									<b>{s.cn}</b>
									<span>{s.desc}</span>
								</div>
							);
						})}
					</div>
				</div>
			</div>
			<button className="btn ghost" onClick={onClose}>
				关 闭
			</button>
		</div>
	);
}

/** 选将面板：立绘 + 势力 + 体力 + 技能全文，点一下即选定 */
function GeneralPicker({ ask }: { ask: Extract<GameView['ask'], { kind: 'chooseOption' }> }) {
	const { pickAndCommitOption } = useGame();
	return (
		<div className="picker">
			<div className="picker__title">{ask.prompt}</div>
			<div className="picker__grid">
				{ask.options.map((o) => {
					const g = GENERALS[o.id];
					const art = generalArt(g.id);
					return (
						<button key={o.id} className="pick" onClick={() => pickAndCommitOption(o.id)}>
							<div className="pick__art">
								{art && <img src={art} alt={g.cn} draggable={false} />}
								<span className="pick__faction" data-f={g.faction}>
									{FACTION_CN[g.faction]}
								</span>
							</div>
							<div className="pick__body">
								<div className="pick__head">
									<span className="pick__name">{g.cn}</span>
									<span className="pick__hp">
										{Array.from({ length: g.maxHp }, (_, i) => (
											<i key={i} />
										))}
									</span>
								</div>
								{g.skills.map((sid) => {
									const s = ALL_SKILLS[sid];
									if (!s) return null;
									return (
										<div className="pick__skill" key={sid}>
											<b>{s.cn}</b>
											<span>{s.desc}</span>
										</div>
									);
								})}
							</div>
						</button>
					);
				})}
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

/**
 * chooseSuit 的花色选择（反间）：四种花色服务端都在 ask.options 里下发了，
 * 照着渲染就行 —— 前端不判断"这个花色能不能选"。按钮做成小牌面的样子（纸底 +
 * 红黑花色），判色沿用 CardFace 里那条约定，别让玩家去猜这几个按钮是什么。
 */
function ChooseSuitPicker({ ask }: { ask: Extract<GameView['ask'], { kind: 'chooseSuit' }> }) {
	const { pickAndCommitSuit, pass } = useGame();
	return (
		<div className="actions">
			<div className="prompt">{ask.prompt}</div>
			<div className="btn-row suit-row">
				{ask.options.map((suit) => (
					<button
						key={suit}
						className="suit-btn"
						data-c={suit === 'heart' || suit === 'diamond' ? 'red' : 'black'}
						onClick={() => pickAndCommitSuit(suit)}
					>
						<span className="suit-btn__pip">{SUIT_SYMBOL[suit]}</span>
						<span className="suit-btn__name">{SUIT_CN[suit]}</span>
					</button>
				))}
			</div>
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
	const { send, lobby, pid, room } = useGame();
	const isHost = lobby.find((p) => p.pid === pid)?.host ?? false;
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
				<div className="btn-row" style={{ justifyContent: 'center', marginTop: '2vmin' }}>
					{isHost ? (
						<button className="btn" onClick={() => send({ t: 'restart' })}>
							再 来 一 局
						</button>
					) : (
						<div style={{ fontSize: '2vmin', color: 'var(--gold-300)' }}>等待房主开下一局…</div>
					)}
					<button className="btn ghost" onClick={() => exportRecord(room)}>
						导出这局记录
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * 结算后拉取只读的对局记录接口，触发一次 JSON 文件下载。
 * 服务端只在 state.finished 之后才放行（见 room.ts 的 handleReplay），
 * 这里不做任何权限判断——按钮本来就只在结算界面（B1 防作弊边界的另一侧）出现。
 */
function exportRecord(room: string): void {
	fetch(`/api/room/${room}/replay`)
		.then((r) => {
			if (!r.ok) throw new Error(`导出失败（${r.status}）`);
			return r.json();
		})
		.then((record) => {
			const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `sgs-${room}-${Date.now()}.json`;
			a.click();
			URL.revokeObjectURL(url);
		})
		.catch((e) => {
			console.error(e);
			alert('导出失败，请稍后重试');
		});
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
