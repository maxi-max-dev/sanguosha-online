/**
 * 【无懈可击】能不能真的被打出来。
 *
 * 单独立一个文件，是因为这里挂过一个活了很久的缺陷：`game.ts` 用 `need: 'wuxie'`
 * 发询问，而牌名是 `'wuxiekeji'`，`options.ts` 的 respond() 拿 `card.name !== need`
 * 筛手牌，于是永远筛不出东西 —— opts 恒为空、询问从来没发出去过，牌堆里 7 张
 * 【无懈可击】全程是死牌，连带 AI 里那段"忠臣该不该替主公挡锦囊"的逻辑也是死代码。
 *
 * 它能活这么久，是因为没有任何测试走过"锦囊被无懈响应"这条路：压测的随机代理
 * 只会从引擎给的 options 里挑，引擎不给它就永远不选，缺席看起来和"没人想挡"一样。
 * 所以这里的断言必须是**询问真的发出来了**，而不是"某个函数返回了非空数组"。
 */

import { describe, expect, it } from 'vitest';
import { Game } from '../src/game.js';
import { optionProvider } from '../src/options.js';
import type { AskRequest, GameRecord } from '../src/protocol.js';
import { registry } from '../src/registry.js';
import type { Card, PlayerState } from '../src/types.js';

function makeGame(ids: string[]): Game {
	const record: GameRecord = {
		seed: 1,
		setup: {
			mode: 'identity',
			players: ids.map((id) => ({ id, nickname: id })),
			packs: ['standard'],
		},
		decisions: [],
	};
	const g = new Game(record, registry);
	g.state.players = ids.map((id, seat): PlayerState => {
		const gd = registry.generals.caocao;
		return {
			id,
			seat,
			nickname: id,
			general: gd.id,
			faction: gd.faction,
			gender: gd.gender,
			identity: seat === 0 ? 'lord' : 'rebel',
			identityRevealed: true,
			maxHp: gd.maxHp,
			hp: gd.maxHp,
			hand: [],
			equip: {},
			judge: [],
			alive: true,
			chained: false,
			turnedOver: false,
			skills: [],
			disabledSkills: [],
			flags: {},
			offline: false,
		};
	});
	g.state.seating = ids.slice();
	g.state.currentPlayer = ids[0];
	g.optionProvider = optionProvider;
	return g;
}

function takeFromPile(g: Game, name: string): number {
	const c = Object.values(g.state.cards).find(
		(x: Card) => x.name === name && g.locate(x.id).zone === 'draw',
	);
	if (!c) throw new Error(`牌堆里没有 ${name}`);
	return c.id;
}

function giveToHand(g: Game, who: string, cardId: number): void {
	g.state.drawPile = g.state.drawPile.filter((c) => c !== cardId);
	g.player(who).hand.push(cardId);
	g.state.locations[cardId] = { zone: 'hand', owner: who };
}

/** 驱动一个会经过 g.ask() 的调用，把过程中弹出的请求逐个记录并喂掉 */
async function drive(
	g: Game,
	run: Promise<unknown>,
	respond: (ask: AskRequest) => { type: 'pass' },
	seen: AskRequest[],
): Promise<void> {
	let settled = false;
	run.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let guard = 0; guard < 500 && !settled; guard++) {
		const ask = g.getPendingAsk();
		if (ask) {
			seen.push(ask);
			await g.submit(ask.who, respond(ask), false);
		} else {
			await Promise.resolve();
		}
	}
}

describe('无懈可击', () => {
	it('手里有【无懈可击】的人，会被问到要不要响应锦囊', async () => {
		const g = makeGame(['a', 'b']);
		const wuxie = takeFromPile(g, 'wuxiekeji');
		giveToHand(g, 'b', wuxie);
		const trick = takeFromPile(g, 'wuzhongshengyou');
		giveToHand(g, 'a', trick);

		const seen: AskRequest[] = [];
		await drive(g, g.useCard('a', { name: 'wuzhongshengyou', cards: [trick] }, ['a']), () => ({ type: 'pass' }), seen);

		const wuxieAsk = seen.find((x) => x.kind === 'respond' && x.need === 'wuxiekeji');
		expect(wuxieAsk, '持有【无懈可击】的 b 应当收到响应询问').toBeTruthy();
		expect(wuxieAsk?.who).toBe('b');
	});

	it('手里没有【无懈可击】的人，不会被无谓地打扰', async () => {
		const g = makeGame(['a', 'b']);
		const trick = takeFromPile(g, 'wuzhongshengyou');
		giveToHand(g, 'a', trick);

		const seen: AskRequest[] = [];
		await drive(g, g.useCard('a', { name: 'wuzhongshengyou', cards: [trick] }, ['a']), () => ({ type: 'pass' }), seen);

		expect(seen.some((x) => x.kind === 'respond' && x.need === 'wuxiekeji')).toBe(false);
	});
});
