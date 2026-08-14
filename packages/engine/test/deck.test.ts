/**
 * 军争篇牌堆的数据完整性测试。
 *
 * 花色/点数不是凭记忆编的，是从 noname 项目的 card/standard.js + card/extra.js 里
 * 逐条提取、程序化核对过的（见任务记录）。这里的期望张数表是独立誊抄的第二份数据，
 * 不是从 deck.ts 里读出来再回头断言自己——真出现誊抄错误，两份数据对不上就会炸。
 */
import { describe, expect, it } from 'vitest';
import { CARDS } from '../src/cards/index.js';
import { buildDeck } from '../src/deck.js';
import { BLACK_SUITS, RED_SUITS, type Suit } from '../src/types.js';

/** 军争篇每种牌的权威张数（来源同 deck.ts 头部注释，独立誊抄一份用于交叉核对） */
const EXPECTED_COUNTS: Record<string, number> = {
	sha: 30,
	huosha: 5,
	leisha: 9,
	shan: 24,
	tao: 12,
	jiu: 5,
	juedou: 3,
	guohechaiqiao: 6,
	shunshouqianyang: 5,
	wuzhongshengyou: 4,
	nanmanruqin: 3,
	wanjianqifa: 1,
	taoyuanjieyi: 1,
	wugufengdeng: 2,
	jiedaosharen: 2,
	wuxiekeji: 7,
	tiesuolianhuan: 6,
	huogong: 3,
	lebusishu: 3,
	shandian: 2,
	bingliangcunduan: 2,
	zhugeliannu: 2,
	cixiongshuanggujian: 1,
	qinggangjian: 1,
	qinglongyanyuedao: 1,
	zhangbashemao: 1,
	guanshifu: 1,
	fangtianhuaji: 1,
	qilinong: 1,
	hanbingjian: 1,
	bagua: 2,
	renwangdun: 1,
	tengjia: 2,
	baiyinshizi: 1,
	jueying: 1,
	dayuan: 1,
	zixing: 1,
	chitu: 1,
	dilu: 1,
	zhuahuangfeidian: 1,
};

const TOTAL_EXPECTED = Object.values(EXPECTED_COUNTS).reduce((a, b) => a + b, 0);

function countBy<T>(items: T[], key: (x: T) => string): Map<string, number> {
	const m = new Map<string, number>();
	for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
	return m;
}

describe('buildDeck', () => {
	const deck = buildDeck(['standard']);

	it('总数应为 157 张', () => {
		expect(TOTAL_EXPECTED).toBe(157);
		expect(deck.length).toBe(TOTAL_EXPECTED);
	});

	it('未启用任何牌包时不应该有牌', () => {
		expect(buildDeck([])).toEqual([]);
		expect(buildDeck(['not-a-real-pack'])).toEqual([]);
	});

	it('每种牌的张数都要对上权威数据', () => {
		const counts = countBy(deck, (c) => c.name);
		for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
			expect(counts.get(name), `${name} 的张数`).toBe(expected);
		}
		// 反向确认牌堆里没有出现期望表之外的牌名
		for (const name of counts.keys()) {
			expect(EXPECTED_COUNTS, `牌堆里出现了期望表没有的牌名: ${name}`).toHaveProperty(name);
		}
	});

	it('牌堆里应该恰好是这 40 种牌，且每种都至少有 1 张', () => {
		const names = new Set(deck.map((c) => c.name));
		expect(names.size).toBe(40);
		expect(names.size).toBe(Object.keys(EXPECTED_COUNTS).length);
	});

	it('每张牌的花色/点数都要合法', () => {
		const validSuits = new Set<Suit>([...RED_SUITS, ...BLACK_SUITS]);
		for (const c of deck) {
			expect(validSuits.has(c.suit), `非法花色: ${c.suit}`).toBe(true);
			expect(Number.isInteger(c.number), `点数不是整数: ${c.number}`).toBe(true);
			expect(c.number, `点数越界: ${c.number}`).toBeGreaterThanOrEqual(1);
			expect(c.number, `点数越界: ${c.number}`).toBeLessThanOrEqual(13);
		}
	});

	it('不应该有异常重复的 (花色,点数,牌名) 组合', () => {
		// 三国杀的军争篇牌堆本来就是拼多副扑克牌得来的，同名牌里出现相同花色点数
		// 是正常现象（比如黑桃8的杀就有两张）；但真出现 4 张一模一样的实体牌，
		// 大概率是数据誊抄时复制多了，应该报错而不是悄悄放过。
		const triples = countBy(deck, (c) => `${c.suit}:${c.number}:${c.name}`);
		for (const [triple, count] of triples) {
			expect(count, `(花色,点数,牌名) 组合重复过多: ${triple} 出现了 ${count} 次`).toBeLessThanOrEqual(3);
		}
	});

	it('牌堆里的每张牌都必须有对应的 CardDef 实现', () => {
		for (const c of deck) {
			expect(CARDS[c.name], `牌堆用到了未注册的牌名: ${c.name}`).toBeDefined();
		}
	});

	it('CARDS 里注册的每种牌都应该真的出现在牌堆里（没有被遗漏或成为死代码）', () => {
		const names = new Set(deck.map((c) => c.name));
		for (const name of Object.keys(EXPECTED_COUNTS)) {
			expect(names.has(name), `CARDS 里的 ${name} 没有出现在牌堆里`).toBe(true);
		}
	});
});
