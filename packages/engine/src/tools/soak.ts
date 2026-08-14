/**
 * 无头随机对局压测。
 *
 * 这是验收的主力工具：用随机决策把整个规则引擎反复跑穿，只要有一局崩了，
 * 它就把那局的**种子和完整决策日志**打出来 —— 拿着这两样就能精确重现现场，
 * 不需要"我也遇到过一次但复现不了"这种对话。
 *
 * 用法：
 *   pnpm --filter @sgs/engine soak            # 默认 200 局身份局
 *   pnpm --filter @sgs/engine soak 1000 6     # 1000 局，每局 6 人
 *   pnpm --filter @sgs/engine soak 500 2 random duel   # 500 局单挑（第二个参数被忽略，固定 2 人）
 */

import { decide } from '../ai/simple.js';
import { GameOver, type Game } from '../game.js';
import { DuelGame } from '../modes/duel.js';
import { IdentityGame } from '../modes/identity.js';
import { optionProvider } from '../options.js';
import type { AskRequest, Decision, DecisionPayload, GameRecord, GameSetup } from '../protocol.js';
import { registry } from '../registry.js';
import { Rng } from '../rng.js';

/**
 * 随机代理。刻意**不**追求打得好 —— 它的价值是把规则空间铺开走一遍，
 * 所以它会尽量多做事（优先出牌而不是跳过），好把结算路径都踩到。
 */
function randomDecision(ask: AskRequest, rng: Rng): DecisionPayload {
	switch (ask.kind) {
		case 'playPhase': {
			// 七成概率出牌，三成结束回合，避免出牌阶段无限循环
			if (ask.options.length === 0 || rng.next() < 0.3) return { type: 'pass' };
			const opt = rng.pick(ask.options);
			const t = opt.targets;
			if (t.auto) return { type: 'play', optionId: opt.id, targets: t.candidates };
			if (t.candidates.length < t.min) return { type: 'pass' };
			const n = t.min + rng.int(Math.min(t.max, t.candidates.length) - t.min + 1);
			return {
				type: 'play',
				optionId: opt.id,
				targets: rng.shuffle(t.candidates.slice()).slice(0, Math.max(t.min, n)),
			};
		}
		case 'respond': {
			if (ask.options.length === 0) return { type: 'pass' };
			// 响应类高概率接（否则几乎测不到闪避/无懈的分支）
			if (rng.next() < 0.15) return { type: 'pass' };
			const opt = rng.pick(ask.options);
			return { type: 'play', optionId: opt.id, targets: opt.targets.candidates };
		}
		case 'discard':
			return { type: 'cards', cards: rng.shuffle(ask.candidates.slice()).slice(0, ask.min) };
		case 'chooseCards': {
			const n = ask.min + rng.int(Math.max(1, ask.max - ask.min + 1));
			return {
				type: 'cards',
				cards: rng
					.shuffle(ask.candidates.map((c) => c.id))
					.slice(0, Math.min(n, ask.candidates.length)),
			};
		}
		case 'choosePlayers': {
			const n = ask.min + rng.int(Math.max(1, ask.max - ask.min + 1));
			return {
				type: 'players',
				players: rng.shuffle(ask.candidates.slice()).slice(0, Math.min(n, ask.candidates.length)),
			};
		}
		case 'chooseOption': {
			const usable = ask.options.filter((o) => !o.disabled);
			return { type: 'option', optionId: rng.pick(usable.length ? usable : ask.options).id };
		}
		case 'confirmSkill':
			return { type: 'confirm', yes: rng.next() < 0.7 };
		case 'chooseSuit':
			return { type: 'suit', suit: rng.pick(ask.options) };
		case 'arrange': {
			const shuffled = rng.shuffle(ask.cards.slice());
			const k = rng.int(Math.min(ask.maxTop, shuffled.length) + 1);
			return { type: 'arrange', top: shuffled.slice(0, k), bottom: shuffled.slice(k) };
		}
		case 'distribute':
			return {
				type: 'distribute',
				assign: ask.cards.map((c) => ({ card: c, to: rng.pick(ask.candidates) })),
			};
	}
}

export interface SoakResult {
	games: number;
	crashed: number;
	drawn: number;
	winners: Record<string, number>;
	avgDecisions: number;
	avgRounds: number;
	failures: Array<{ seed: number; error: string; decisions: Decision[] }>;
}

export async function soak(
	games: number,
	playerCount: number,
	baseSeed = 1,
	/** 'random' 铺开规则空间找崩溃；'ai' 检验机器人打得像不像样 */
	driver: 'random' | 'ai' = 'random',
	/** 'identity' 身份局（playerCount 生效）；'duel' 单挑（固定 2 人，playerCount 被忽略） */
	mode: GameSetup['mode'] = 'identity',
): Promise<SoakResult> {
	const res: SoakResult = {
		games: 0,
		crashed: 0,
		drawn: 0,
		winners: {},
		avgDecisions: 0,
		avgRounds: 0,
		failures: [],
	};
	let totalDecisions = 0;
	let totalRounds = 0;
	const n = mode === 'duel' ? 2 : playerCount;

	for (let i = 0; i < games; i++) {
		const seed = baseSeed + i;
		const rng = new Rng(seed ^ 0x5f3759df);
		const record: GameRecord = {
			seed,
			setup: {
				mode,
				players: Array.from({ length: n }, (_, k) => ({
					id: `p${k}`,
					nickname: `玩家${k}`,
				})),
				packs: ['standard'],
			},
			decisions: [],
		};

		const g: Game = mode === 'duel' ? new DuelGame(record, registry) : new IdentityGame(record, registry);
		g.optionProvider = optionProvider;

		try {
			void g.runGame().catch((e) => {
				if (!(e instanceof GameOver)) throw e;
			});
			await g.waitIdle();

			let steps = 0;
			while (!g.state.finished && steps++ < 8000) {
				const ask = g.getPendingAsk();
				if (!ask) break;
				// AI 用的是这里的 rng，和 g.rng 是两条独立的流 —— 不能混
				const payload = driver === 'ai' ? decide(g, ask, rng) : randomDecision(ask, rng);
				await g.submit(ask.who, payload);
			}

			if (steps >= 8000) throw new Error('对局未在 8000 步内结束，疑似死循环');

			res.games++;
			totalDecisions += g.decisions.length;
			totalRounds += g.state.round;
			const reason = g.state.finished?.reason ?? '未结束';
			if (reason.includes('平局')) res.drawn++;
			res.winners[reason] = (res.winners[reason] ?? 0) + 1;
		} catch (e) {
			res.crashed++;
			res.failures.push({
				seed,
				error: e instanceof Error ? `${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}` : String(e),
				decisions: g.decisions.slice(),
			});
			if (res.failures.length >= 5) break;
		}
	}

	res.avgDecisions = res.games ? Math.round(totalDecisions / res.games) : 0;
	res.avgRounds = res.games ? Math.round((totalRounds / res.games) * 10) / 10 : 0;
	return res;
}

// 直接运行时的 CLI
const isMain = process.argv[1]?.endsWith('soak.ts');
if (isMain) {
	const games = Number(process.argv[2] ?? 200);
	const players = Number(process.argv[3] ?? 5);
	const driver = (process.argv[4] === 'ai' ? 'ai' : 'random') as 'random' | 'ai';
	const mode = (process.argv[5] === 'duel' ? 'duel' : 'identity') as 'identity' | 'duel';
	const n = mode === 'duel' ? 2 : players;
	const t0 = Date.now();
	const r = await soak(games, players, 1, driver, mode);
	const secs = ((Date.now() - t0) / 1000).toFixed(1);

	console.log(`\n跑了 ${r.games}/${games} 局（${mode === 'duel' ? '单挑' : `身份局 ${n} 人`}，${driver === 'ai' ? '机器人对局' : '随机决策'}），耗时 ${secs}s`);
	console.log(`平均每局 ${r.avgDecisions} 个决策 / ${r.avgRounds} 轮`);
	console.log(`崩溃 ${r.crashed} 局，平局 ${r.drawn} 局`);
	console.log('\n胜负分布：');
	for (const [k, v] of Object.entries(r.winners).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${k.padEnd(12)} ${v} (${((v / r.games) * 100).toFixed(1)}%)`);
	}
	if (r.failures.length) {
		console.log('\n❌ 失败样本（拿 seed + 决策日志即可精确复现）：');
		for (const f of r.failures) {
			console.log(`\n  seed=${f.seed}  决策数=${f.decisions.length}`);
			console.log(`  ${f.error.split('\n').join('\n  ')}`);
		}
		process.exit(1);
	}
	console.log('\n✅ 无崩溃');
}
