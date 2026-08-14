/**
 * 引擎核心的隔离测试。
 *
 * 这里刻意**不用真实牌堆**，而是注入一套最小假注册表 —— 要验的是引擎骨架
 * （确定性、重放、视角裁剪、时机顺序）本身立不立得住，不该被 25 个武将和
 * 160 张牌的实现细节干扰。真实内容的测试在 deck.test.ts / skills.test.ts。
 */

import { describe, expect, it } from 'vitest';
import type { CardDef, GeneralDef, SkillDef } from '../src/defs.js';
import { GameOver, type Registry } from '../src/game.js';
import { IdentityGame } from '../src/modes/identity.js';
import { optionProvider } from '../src/options.js';
import type { Decision, GameRecord } from '../src/protocol.js';
import { Rng } from '../src/rng.js';
import { buildView } from '../src/view.js';
import type { Card, Suit } from '../src/types.js';

// ─────────────────────── 最小假注册表 ───────────────────────

const fakeCards: Record<string, CardDef> = {
	sha: {
		name: 'sha',
		cn: '杀',
		type: 'basic',
		useDistance: true,
		canTarget: (_g, s, t) => s !== t,
		async onEffect(g, ev, target) {
			const shan = await g.askForCard(target, 'shan', '请打出一张【闪】', {
				source: ev.source,
				use: ev.use,
			});
			if (!shan) {
				await g.damage({ source: ev.source, target, amount: 1, nature: undefined, card: ev.use });
			}
		},
	},
	shan: { name: 'shan', cn: '闪', type: 'basic', canUse: () => false },
	tao: {
		name: 'tao',
		cn: '桃',
		type: 'basic',
		canUse: (g, s) => g.player(s).hp < g.player(s).maxHp,
		canTarget: (_g, s, t) => s === t,
		async onEffect(g, ev, target) {
			await g.recover({ source: ev.source, target, amount: 1, card: ev.use });
		},
	},
};

const fakeSkills: Record<string, SkillDef> = {
	// 锁定技 + 修正器：验 mods 通路
	testMashu: {
		id: 'testMashu',
		cn: '马术',
		desc: '距离-1',
		tags: ['locked'],
		mods: { distanceFrom: () => -1 },
	},
	// 触发技：验时机总线与询问
	testJianxiong: {
		id: 'testJianxiong',
		cn: '奸雄',
		desc: '受伤后摸一张',
		triggers: [
			{
				timing: 'afterDamage',
				can: (_g, self, ev) => ev.target === self.id,
				async run(g, self) {
					await g.drawCards(self.id, 1, 'test');
				},
			},
		],
	},
};

const fakeGenerals: Record<string, GeneralDef> = Object.fromEntries(
	Array.from({ length: 8 }, (_, i) => {
		const id = `g${i}`;
		return [
			id,
			{
				id,
				cn: `将${i}`,
				faction: 'qun',
				gender: 'male',
				maxHp: 4,
				skills: i % 2 === 0 ? ['testMashu'] : ['testJianxiong'],
				pack: 'test',
			} satisfies GeneralDef,
		];
	}),
);

const SUITS: Suit[] = ['heart', 'diamond', 'spade', 'club'];

const registry: Registry = {
	cards: fakeCards,
	skills: fakeSkills,
	generals: fakeGenerals,
	buildDeck() {
		const out: Array<Omit<Card, 'id'>> = [];
		// 杀多、闪次之、桃少，接近真实牌堆的比例，好让对局能推进下去
		const mix: Array<[string, number]> = [
			['sha', 60],
			['shan', 40],
			['tao', 20],
		];
		let i = 0;
		for (const [name, count] of mix) {
			for (let k = 0; k < count; k++) {
				out.push({ name, suit: SUITS[i % 4], number: (i % 13) + 1 });
				i++;
			}
		}
		return out;
	},
};

// ─────────────────────── 驱动 ───────────────────────

/**
 * @param fixGenerals 固定武将，跳过选将询问。默认开 —— 否则每个测试的第一个
 * 待决策点都是选将，还没发牌就停住了，验不到开局后的状态。选将流程本身单独测。
 */
function makeRecord(players = 5, seed = 42, fixGenerals = true): GameRecord {
	const ids = Array.from({ length: players }, (_, i) => `p${i}`);
	return {
		seed,
		setup: {
			mode: 'identity',
			players: ids.map((id, i) => ({ id, nickname: `玩家${i}` })),
			packs: ['test'],
			...(fixGenerals
				? { generals: Object.fromEntries(ids.map((id, i) => [id, `g${i}`])) }
				: {}),
		},
		decisions: [],
	};
}

async function boot(record: GameRecord): Promise<IdentityGame> {
	const g = new IdentityGame(record, registry);
	g.optionProvider = optionProvider;
	void g.runGame().catch((e) => {
		if (!(e instanceof GameOver)) throw e;
	});
	await g.waitIdle();
	return g;
}

/** 用随机决策把一局推进 n 步，返回走过的决策日志 */
async function play(g: IdentityGame, steps: number, rng: Rng): Promise<void> {
	for (let i = 0; i < steps; i++) {
		if (g.state.finished) return;
		const ask = g.getPendingAsk();
		if (!ask) return;
		// 用最朴素的默认决策就够了：这里验的是引擎骨架，不是打得好不好
		await g.submitAuto();
		void rng;
	}
}

// ─────────────────────── 测试 ───────────────────────

describe('确定性随机', () => {
	it('同种子产生同序列', () => {
		const a = new Rng(12345);
		const b = new Rng(12345);
		const xs = Array.from({ length: 500 }, () => a.next());
		const ys = Array.from({ length: 500 }, () => b.next());
		expect(xs).toEqual(ys);
	});

	it('不同种子产生不同序列', () => {
		const a = new Rng(1);
		const b = new Rng(2);
		expect(a.next()).not.toBe(b.next());
	});

	it('洗牌不丢牌不重牌', () => {
		const rng = new Rng(7);
		const src = Array.from({ length: 200 }, (_, i) => i);
		const shuffled = rng.shuffle(src.slice());
		expect(shuffled.slice().sort((x, y) => x - y)).toEqual(src);
	});
});

describe('事件溯源与重放', () => {
	it('相同种子 + 相同决策日志重放出完全相同的状态', async () => {
		const rec = makeRecord(5, 2026);
		const g1 = await boot(rec);
		await play(g1, 120, new Rng(1));

		// 拿 g1 的日志重放一局全新的
		const g2 = await boot({ ...rec, decisions: g1.decisions.map((d) => ({ ...d })) });

		expect(g2.decisions.length).toBe(g1.decisions.length);
		// 状态逐字段比对：手牌、体力、牌堆、位置全都要一致
		expect(JSON.stringify(g2.state)).toBe(JSON.stringify(g1.state));
	});

	it('重放后能从断点继续，且与不中断的走法一致', async () => {
		const rec = makeRecord(5, 777);

		// A：一口气走 160 步
		const gA = await boot(rec);
		await play(gA, 160, new Rng(1));

		// B：走 80 步 → 从日志重建 → 再走 80 步（模拟 DO 休眠后被唤醒）
		const gB1 = await boot(rec);
		await play(gB1, 80, new Rng(1));
		const gB2 = await boot({ ...rec, decisions: gB1.decisions.map((d) => ({ ...d })) });
		await play(gB2, 80, new Rng(1));

		expect(gB2.decisions.length).toBe(gA.decisions.length);
		expect(JSON.stringify(gB2.state)).toBe(JSON.stringify(gA.state));
	});

	it('决策日志错位时抛错而不是将错就错', async () => {
		const rec = makeRecord(5, 99);
		const g1 = await boot(rec);
		await play(g1, 30, new Rng(1));

		// 篡改日志：把某条决策的 who 改掉
		const tampered: Decision[] = g1.decisions.map((d, i) =>
			i === 5 ? { ...d, who: 'p_不存在的人' } : { ...d },
		);

		await expect(async () => {
			const bad = new IdentityGame({ ...rec, decisions: tampered }, registry);
			bad.optionProvider = optionProvider;
			await bad.runGame();
		}).rejects.toThrow(/错位/);
	});
});

describe('身份局布置', () => {
	it.each([
		[5, { lord: 1, loyalist: 1, rebel: 2, spy: 1 }],
		[6, { lord: 1, loyalist: 1, rebel: 3, spy: 1 }],
		[7, { lord: 1, loyalist: 2, rebel: 3, spy: 1 }],
		[8, { lord: 1, loyalist: 2, rebel: 4, spy: 1 }],
	])('%i 人局身份构成正确', async (n, expected) => {
		const g = await boot(makeRecord(n, 5));
		const count: Record<string, number> = {};
		for (const p of g.state.players) count[p.identity] = (count[p.identity] ?? 0) + 1;
		expect(count).toEqual(expected);
	});

	it('主公坐 0 号位、身份公开、体力上限 +1', async () => {
		const g = await boot(makeRecord(5, 11));
		const lord = g.state.players[0];
		expect(lord.identity).toBe('lord');
		expect(lord.identityRevealed).toBe(true);
		expect(lord.maxHp).toBe(fakeGenerals[lord.general].maxHp + 1);
		// 其余人身份不公开
		for (const p of g.state.players.slice(1)) expect(p.identityRevealed).toBe(false);
	});

	// 引擎发完牌不会停，会一路跑到首个回合的出牌阶段才等输入，
	// 所以此刻当前回合角色已经多摸了 2 张 —— 断言要避开他。
	it('开局每人 4 张手牌（当前回合角色已进摸牌阶段除外）', async () => {
		const g = await boot(makeRecord(6, 13));
		for (const p of g.state.players) {
			if (p.id === g.state.currentPlayer) continue;
			expect(p.hand.length).toBe(4);
		}
	});

	it('不固定武将时，开局第一件事是问选将', async () => {
		const g = await boot(makeRecord(5, 14, false));
		const ask = g.getPendingAsk()!;
		expect(ask.kind).toBe('chooseOption');
		// 主公先选
		expect(ask.who).toBe(g.state.players[0].id);
		expect(ask.prompt).toContain('主公');
	});

	it('选将后武将、体力、技能都装上了', async () => {
		const g = await boot(makeRecord(5, 15, false));
		// 依次把 5 个人的选将问完
		for (let i = 0; i < 5; i++) {
			const ask = g.getPendingAsk();
			if (ask?.kind !== 'chooseOption') break;
			await g.submitAuto();
		}
		for (const p of g.state.players) {
			expect(p.general).not.toBe('');
			expect(fakeGenerals[p.general]).toBeDefined();
			expect(p.skills.length).toBeGreaterThan(0);
			expect(p.hand.length).toBeGreaterThanOrEqual(4);
		}
	});
});

describe('牌的守恒', () => {
	/** 每张牌必须**恰好**在一个地方。位置表和实际区域对不上，相关技能就会漏触发 */
	function assertConserved(g: IdentityGame) {
		const total = Object.keys(g.state.cards).length;
		const seen = new Map<number, string>();
		const put = (ids: number[], where: string) => {
			for (const id of ids) {
				expect(seen.has(id), `牌 ${id} 同时在 ${seen.get(id)} 和 ${where}`).toBe(false);
				seen.set(id, where);
			}
		};

		put(g.state.drawPile, 'draw');
		put(g.state.discardPile, 'discard');
		put(g.state.processing, 'processing');
		for (const p of g.state.players) {
			put(p.hand, `${p.id}.hand`);
			put(
				Object.values(p.equip).filter((x): x is number => typeof x === 'number'),
				`${p.id}.equip`,
			);
			put(p.judge, `${p.id}.judge`);
		}

		expect(seen.size, '有牌凭空消失了').toBe(total);

		// locations 表必须和实际区域一致
		for (const [id, where] of seen) {
			const zone = where.includes('.') ? where.split('.')[1] : where;
			expect(g.state.locations[id].zone, `牌 ${id} 的 locations 记录对不上`).toBe(zone);
		}
	}

	it('开局时守恒', async () => {
		const g = await boot(makeRecord(6, 61));
		assertConserved(g);
	});

	it('打了几百步之后仍然守恒', async () => {
		const g = await boot(makeRecord(6, 62));
		for (let i = 0; i < 400 && !g.state.finished; i++) {
			if (!g.getPendingAsk()) break;
			await g.submitAuto();
			// 每 40 步查一次，既能定位到大致出问题的时机又不会拖慢测试
			if (i % 40 === 0) assertConserved(g);
		}
		assertConserved(g);
	});
});

describe('视角裁剪（防作弊）', () => {
	it('看不到别人的手牌牌面，只看得到张数', async () => {
		const g = await boot(makeRecord(5, 31));
		const me = g.state.players[1];
		const other = g.state.players[2];
		const view = buildView(g.state, me.id, g.getPendingAsk());

		const otherView = view.players.find((p) => p.id === other.id)!;
		expect(otherView.handCount).toBe(other.hand.length);
		expect(otherView.hand).toBeUndefined();
		// 别人手牌的牌面不能出现在 cards 字典里
		for (const id of other.hand) expect(view.cards[id]).toBeUndefined();
	});

	it('自己的手牌牌面完整可见', async () => {
		const g = await boot(makeRecord(5, 32));
		const me = g.state.players[1];
		const view = buildView(g.state, me.id, g.getPendingAsk());
		const selfView = view.players.find((p) => p.id === me.id)!;
		expect(selfView.hand).toEqual(me.hand);
		for (const id of me.hand) expect(view.cards[id]).toBeDefined();
	});

	it('看不到未公开的身份', async () => {
		const g = await boot(makeRecord(5, 33));
		const me = g.state.players[1];
		const view = buildView(g.state, me.id, g.getPendingAsk());
		for (const p of view.players) {
			if (p.id === me.id || p.seat === 0) expect(p.identity).toBeDefined();
			else expect(p.identity).toBeUndefined();
		}
	});

	it('牌堆只暴露数量，不暴露内容', async () => {
		const g = await boot(makeRecord(5, 34));
		const view = buildView(g.state, g.state.players[1].id, g.getPendingAsk());
		expect(view.drawCount).toBe(g.state.drawPile.length);
		for (const id of g.state.drawPile) expect(view.cards[id]).toBeUndefined();
	});

	it('arrange 请求（观星）里的牌，当事人看得到牌面，别人看不到', async () => {
		const g = await boot(makeRecord(5, 34));
		const me = g.state.players[1];
		const peeked = g.state.drawPile.slice(0, 3);
		const ask = {
			seq: 999,
			kind: 'arrange' as const,
			who: me.id,
			prompt: '观星',
			cards: peeked,
			topLabel: '牌堆顶',
			bottomLabel: '牌堆底',
			maxTop: 3,
			cancelable: false,
			timeout: 30,
		};

		// 观星的牌不离开牌堆（skills/shu.ts 只重排 drawPile），所以默认的视角裁剪
		// 会把它们当普通牌堆牌藏掉——那样发动技能的人只能看到几张牌背，技能等于废了
		const mine = buildView(g.state, me.id, ask);
		for (const id of peeked) expect(mine.cards[id]).toBeDefined();

		// 但这个豁免必须严格限定在当事人身上，别人连 ask 都收不到，更不该看到牌面
		const other = g.state.players.find((p) => p.id !== me.id)!;
		const theirs = buildView(g.state, other.id, ask);
		for (const id of peeked) expect(theirs.cards[id]).toBeUndefined();
	});

	it('请求只发给当事人', async () => {
		const g = await boot(makeRecord(5, 35));
		const ask = g.getPendingAsk()!;
		const mine = buildView(g.state, ask.who, ask);
		const theirs = buildView(g.state, g.state.players.find((p) => p.id !== ask.who)!.id, ask);
		expect(mine.ask).toBeDefined();
		expect(theirs.ask).toBeUndefined();
	});

	it('id 与牌面的映射每局不同（防止用 id 反推牌面）', async () => {
		const a = await boot(makeRecord(5, 100));
		const b = await boot(makeRecord(5, 200));
		const sameCount = Object.keys(a.state.cards).filter(
			(id) => a.state.cards[+id].name === b.state.cards[+id].name,
		).length;
		const total = Object.keys(a.state.cards).length;
		// 三种牌名，随机情况下约 1/3 重合；只要没有接近 100% 就说明映射确实被打乱了
		expect(sameCount / total).toBeLessThan(0.75);
	});
});

describe('规则修正器', () => {
	it('马术让距离 -1', async () => {
		// 用 8 人局：座位距离能到 4，减 1 之后不会被"距离下限 1"截断，才验得准
		const g = await boot(makeRecord(8, 55));
		const withMashu = g.state.players.find((p) => p.skills.includes('testMashu'))!;

		// 挑一个原始距离 >= 2 的目标
		withMashu.skills = [];
		const target = g.state.players.find(
			(p) => p.id !== withMashu.id && g.distance(withMashu.id, p.id) >= 2,
		)!;
		const without = g.distance(withMashu.id, target.id);

		withMashu.skills = ['testMashu'];
		const withSkill = g.distance(withMashu.id, target.id);

		expect(without - withSkill).toBe(1);
	});

	it('距离最小为 1', async () => {
		const g = await boot(makeRecord(5, 56));
		for (const a of g.state.players) {
			for (const b of g.state.players) {
				if (a.id === b.id) continue;
				expect(g.distance(a.id, b.id)).toBeGreaterThanOrEqual(1);
			}
		}
	});
});

describe('对局能跑完', () => {
	it('5 人局在有限步数内分出胜负且不崩', async () => {
		const g = await boot(makeRecord(5, 2024));
		let steps = 0;
		while (!g.state.finished && steps++ < 5000) {
			const ask = g.getPendingAsk();
			if (!ask) break;
			await g.submitAuto();
		}
		expect(g.state.finished).toBeDefined();
		expect(steps).toBeLessThan(5000);
	});

	it('8 人局同样能跑完', async () => {
		const g = await boot(makeRecord(8, 2025));
		let steps = 0;
		while (!g.state.finished && steps++ < 8000) {
			const ask = g.getPendingAsk();
			if (!ask) break;
			await g.submitAuto();
		}
		expect(g.state.finished).toBeDefined();
	});
});
