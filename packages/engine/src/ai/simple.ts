/**
 * 机器人。目标不是打得好，是**打得像个人**——会出杀、会吃桃、会闪、会穿装备，
 * 而不是像 `defaultDecision` 那样一整局一张牌不出，白送人头。
 *
 * ## 两条自我约束
 *
 * 1. **不作弊。** 这段代码跑在服务端，理论上能看到所有人的手牌和身份。但它只允许读
 *    「一个真人玩家在同样位置能看到的东西」：自己的手牌、所有人的体力/装备/判定区/手牌数、
 *    以及已公开的身份（主公）。判断依据全部走 `visible()` 里那几个取值函数，
 *    不要在别处直接摸 `state.players[].hand`。
 *
 * 2. **不做规则判断。** 能出什么牌、能打谁，全部读引擎给的 `AskRequest.options`——
 *    和真人客户端拿到的是同一份。所以机器人不可能做出违规动作，最坏情况只是打得蠢。
 *
 * 托管（掉线的真人）**不走这里**，仍然用 `submitAuto()` 的安全默认值：
 * 替别人乱出牌比什么都不做更糟。
 *
 * ## 🔴 `rng` 必须是外部传入的独立随机源
 *
 * **绝对不能用 `g.rng`。** 重放一局时 AI 根本不会被调用（决策直接从日志里读），
 * 如果 AI 消耗了游戏的随机流，重放后 RNG 状态就和实时对局对不上，后面所有摸牌、
 * 判定全都会错位 —— 而且是静默错位。AI 的输出会作为决策落进日志，重放时照读，
 * 所以它用什么随机源都无所谓，只要**不是游戏自己那个**。
 */

import type { Game } from '../game.js';
import type { AskRequest, DecisionPayload, PlayOption } from '../protocol.js';
import type { Rng } from '../rng.js';
import type { PlayerState } from '../types.js';

/** 牌的留手优先级：数字越大越舍不得弃 */
const KEEP_VALUE: Record<string, number> = {
	tao: 10,
	jiu: 6,
	wuxiekeji: 7,
	shan: 6,
	sha: 5,
	huosha: 5,
	leisha: 5,
	juedou: 4,
	wuzhongshengyou: 4,
	shunshouqianyang: 3,
	guohechaiqiao: 3,
	nanmanruqin: 3,
	wanjianqifa: 3,
	taoyuanjieyi: 4,
	wugufengdeng: 2,
	jiedaosharen: 2,
	huogong: 2,
	tiesuolianhuan: 1,
	lebusishu: 2,
	bingliangcunduan: 2,
	shandian: 1,
};

function keepValue(name: string): number {
	return KEEP_VALUE[name] ?? 2;
}

/** 攻击性牌：用在别人身上的 */
const OFFENSIVE = new Set([
	'sha',
	'huosha',
	'leisha',
	'juedou',
	'shunshouqianyang',
	'guohechaiqiao',
	'huogong',
	'lebusishu',
	'bingliangcunduan',
]);

/** 自己受益、无脑用的牌 */
const SELFISH = new Set(['wuzhongshengyou', 'wugufengdeng', 'taoyuanjieyi']);

export function decide(g: Game, ask: AskRequest, rng: Rng): DecisionPayload {
	switch (ask.kind) {
		case 'playPhase':
			return playPhase(g, ask, rng);
		case 'respond':
			return respond(g, ask, rng);
		case 'discard':
			return { type: 'cards', cards: worstCards(g, ask.candidates, ask.min) };
		case 'chooseCards':
			return { type: 'cards', cards: ask.candidates.slice(0, ask.min).map((c) => c.id) };
		case 'choosePlayers':
			return { type: 'players', ...pickPlayers(g, ask) };
		case 'chooseOption':
			return { type: 'option', optionId: (ask.options.find((o) => !o.disabled) ?? ask.options[0]).id };
		case 'confirmSkill':
			// 技能基本都是白拿的好处，默认发动
			return { type: 'confirm', yes: true };
		case 'chooseSuit':
			return { type: 'suit', suit: rng.pick(ask.options) };
		case 'arrange':
			return { type: 'arrange', top: ask.cards.slice(0, ask.maxTop), bottom: ask.cards.slice(ask.maxTop) };
		case 'distribute':
			// 摸到的牌自己留着
			return { type: 'distribute', assign: ask.cards.map((c) => ({ card: c, to: ask.who })) };
	}
}

// ─────────────────────── 出牌阶段 ───────────────────────

function playPhase(g: Game, ask: Extract<AskRequest, { kind: 'playPhase' }>, rng: Rng): DecisionPayload {
	const me = g.player(ask.who);
	const opts = ask.options;
	if (opts.length === 0) return { type: 'pass' };

	const pick = (o: PlayOption, targets: string[]): DecisionPayload => ({
		type: 'play',
		optionId: o.id,
		targets: o.targets.auto ? o.targets.candidates : targets,
	});

	// 1. 装备先穿上：武器/防具/坐骑几乎总是白赚
	const equip = opts.find((o) => g.registry.cards[o.name]?.type === 'equip');
	if (equip) return pick(equip, []);

	// 2. 受伤了先吃桃
	if (me.hp < me.maxHp) {
		const tao = opts.find((o) => o.name === 'tao');
		if (tao) return pick(tao, [me.id]);
	}

	// 3. 白拿好处的牌
	const free = opts.find((o) => SELFISH.has(o.name));
	if (free) return pick(free, free.targets.candidates.slice(0, free.targets.max as number));

	// 4. 攻击。优先打"该打的人"，其次打最虚的
	const aggressive = opts.filter((o) => OFFENSIVE.has(o.name) && o.targets.candidates.length > 0);
	if (aggressive.length > 0) {
		// 手牌多的时候更愿意动手；手牌紧就留着自保
		const eager = me.hand.length >= 3 || rng.next() < 0.75;
		if (eager) {
			const o = aggressive[0];
			const victim = chooseVictim(g, me, o.targets.candidates, rng);
			if (victim) return pick(o, [victim]);
		}
	}

	// 5. 主动技（制衡、苦肉这类），偶尔用一下，别每回合都刷
	const active = opts.filter((o) => o.viaSkill && o.cards.length === 0);
	if (active.length > 0 && rng.next() < 0.35) return pick(rng.pick(active), []);

	return { type: 'pass' };
}

/**
 * 挑打谁。只用公开信息：主公身份明置，其余人只能看体力、手牌数，
 * 以及**谁打过主公**——那是全桌都看见的事，等同于真人的"跳反"判断。
 *
 * 早期版本让反贼无脑直扑主公，结果 8 人局反贼胜率 93.8%：四个反贼完美协同集火，
 * 而忠臣除了"不打主公"之外毫无方向，双方能力不对称。所以这里做两件事 ——
 * 忠臣按威胁度还击，反贼的集火加入随机性。
 */
function chooseVictim(g: Game, me: PlayerState, candidates: string[], rng: Rng): string | undefined {
	const pool = candidates.filter((id) => id !== me.id);
	if (pool.length === 0) return undefined;

	const lord = g.state.players.find((p) => p.identityRevealed && p.identity === 'lord' && p.alive);
	const weakest = (ids: string[]) =>
		ids
			.map((id) => g.player(id))
			.sort((a, b) => a.hp - b.hp || a.hand.length - b.hand.length)[0]?.id;

	if (!lord) return weakest(pool);

	// 反贼：多数时候压主公，但留三成去清理身边的威胁，避免全员无脑集火
	if (me.identity === 'rebel') {
		if (pool.includes(lord.id) && rng.next() < 0.7) return lord.id;
		return weakest(pool.filter((id) => id !== lord.id)) ?? lord.id;
	}

	// 内奸：主公和反贼都不能让谁太舒服，挑最虚的敲，偶尔碰主公
	if (me.identity === 'spy') {
		if (pool.includes(lord.id) && rng.next() < 0.3) return lord.id;
		return weakest(pool.filter((id) => id !== lord.id)) ?? lord.id;
	}

	// 忠臣和主公：优先还击"打过主公的人"。威胁度来自公开日志，真人也看得到
	const threat = threatScores(g, lord.id);
	const enemies = pool.filter((id) => id !== lord.id);
	const marked = enemies.filter((id) => (threat.get(id) ?? 0) > 0);
	if (marked.length > 0) {
		return marked.sort((a, b) => (threat.get(b) ?? 0) - (threat.get(a) ?? 0))[0];
	}
	return weakest(enemies.length > 0 ? enemies : pool);
}

/** 谁对主公造成过伤害、造成了多少 —— 纯公开信息，从战报日志里数 */
function threatScores(g: Game, lordId: string): Map<string, number> {
	const m = new Map<string, number>();
	for (const e of g.log) {
		if (e.kind !== 'damage' || e.target !== lordId) continue;
		const src = e.source as string | undefined;
		if (!src || src === lordId) continue;
		m.set(src, (m.get(src) ?? 0) + (e.amount as number));
	}
	return m;
}

// ─────────────────────── 响应 ───────────────────────

function respond(g: Game, ask: Extract<AskRequest, { kind: 'respond' }>, rng: Rng): DecisionPayload {
	if (ask.options.length === 0) return { type: 'pass' };
	const me = g.player(ask.who);

	switch (ask.need) {
		case 'shan':
			// 闪基本都要出，除非血很厚且手里闪很少
			if (me.hp >= 3 && countInHand(g, me, 'shan') === 1 && rng.next() < 0.2) {
				return { type: 'pass' };
			}
			return play(ask.options[0]);

		case 'tao': {
			// 濒死的是谁，从提示里拿不到，但引擎只在濒死流程里问【桃】，
			// 且此刻必有一个体力 <= 0 的人 —— 那就是待救的目标
			const dying = g.alivePlayers().find((p) => p.hp <= 0);
			if (!dying) return { type: 'pass' };
			if (dying.id === me.id) return play(ask.options[0]); // 自救必救

			const lord = g.state.players.find((p) => p.identityRevealed && p.identity === 'lord');
			const dyingIsLord = !!lord && dying.id === lord.id;

			// 忠臣必救主公，主公不救反贼的同伙（他也分不清，所以只按"是不是主公"来）
			if (dyingIsLord) return me.identity === 'loyalist' ? play(ask.options[0]) : { type: 'pass' };
			// 救不救普通人：手里桃多才顺手救一下，否则留着自保
			return countInHand(g, me, 'tao') >= 2 && rng.next() < 0.5
				? play(ask.options[0])
				: { type: 'pass' };
		}

		case 'wuxie':
			// 无懈是稀缺牌，别见锦囊就无懈
			return rng.next() < 0.3 ? play(ask.options[0]) : { type: 'pass' };

		case 'sha':
			// 决斗里的杀必须跟，不跟就吃伤害
			return play(ask.options[0]);

		default:
			return play(ask.options[0]);
	}
}

function play(o: PlayOption): DecisionPayload {
	return { type: 'play', optionId: o.id, targets: o.targets.auto ? o.targets.candidates : [] };
}

function countInHand(g: Game, p: PlayerState, name: string): number {
	return p.hand.filter((id) => g.card(id).name === name).length;
}

// ─────────────────────── 弃牌 / 选人 ───────────────────────

function worstCards(g: Game, candidates: number[], n: number): number[] {
	return candidates
		.slice()
		.sort((a, b) => keepValue(g.card(a).name) - keepValue(g.card(b).name))
		.slice(0, n);
}

function pickPlayers(
	g: Game,
	ask: Extract<AskRequest, { kind: 'choosePlayers' }>,
): { players: string[] } {
	const me = g.player(ask.who);
	// 选人的场合有好有坏，分不清就先挑最虚的，至少不会选到自己头上
	const sorted = ask.candidates
		.filter((id) => id !== me.id)
		.map((id) => g.player(id))
		.sort((a, b) => a.hp - b.hp);
	const chosen = (sorted.length ? sorted.map((p) => p.id) : ask.candidates).slice(0, ask.min || 1);
	return { players: chosen };
}
