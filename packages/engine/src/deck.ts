/**
 * 军争篇整副牌堆。
 *
 * 花色/点数数据来自开源项目 noname 的两份卡牌定义，逐张核对导出，不是凭印象编的：
 *   - card/standard.js 的 list：基础牌（杀/闪/桃）、8 件基础装备、10 张即时/延时锦囊
 *   - card/extra.js 的 list：军争篇追加的火杀/雷杀、酒、藤甲、白银狮子、火攻、
 *     铁索连环、兵粮寸断，以及闪/桃/无懈可击的加量牌
 * 这两份数据在 noname 里是分成两个文件维护的实现细节，对我们来说就是同一副"军争篇"牌，
 * 所以只登记一个牌包 'standard'，不按 noname 的文件边界拆包。
 *
 * 总计 157 张，40 种牌名，见 test/deck.test.ts 的断言。
 */
import type { Card, Suit } from './types.js';

type Pip = readonly [Suit, number];

/** 同一张牌的若干张拷贝（花色+点数各不相同），展开成 {name, suit, number} 列表 */
function many(name: string, pips: readonly Pip[]): Array<Omit<Card, 'id'>> {
	return pips.map(([suit, number]) => ({ name, suit, number }));
}

const PACKS: Record<string, Array<Omit<Card, 'id'>>> = {
	standard: [
		...many('sha', [
			['spade', 7], ['spade', 8], ['spade', 8], ['spade', 9], ['spade', 9], ['spade', 10], ['spade', 10],
			['club', 2], ['club', 3], ['club', 4], ['club', 5], ['club', 6], ['club', 7], ['club', 8], ['club', 8],
			['club', 9], ['club', 9], ['club', 10], ['club', 10], ['club', 11], ['club', 11],
			['heart', 10], ['heart', 10], ['heart', 11],
			['diamond', 6], ['diamond', 7], ['diamond', 8], ['diamond', 9], ['diamond', 10], ['diamond', 13],
		]),
		...many('huosha', [['heart', 4], ['heart', 7], ['heart', 10], ['diamond', 4], ['diamond', 5]]),
		...many('leisha', [
			['spade', 4], ['spade', 5], ['spade', 6], ['spade', 7], ['spade', 8],
			['club', 5], ['club', 6], ['club', 7], ['club', 8],
		]),
		...many('shan', [
			['heart', 2], ['heart', 2], ['heart', 13],
			['diamond', 2], ['diamond', 2], ['diamond', 3], ['diamond', 4], ['diamond', 5], ['diamond', 6],
			['diamond', 7], ['diamond', 8], ['diamond', 9], ['diamond', 10], ['diamond', 11], ['diamond', 11],
			['heart', 8], ['heart', 9], ['heart', 11], ['heart', 12],
			['diamond', 6], ['diamond', 7], ['diamond', 8], ['diamond', 10], ['diamond', 11],
		]),
		...many('tao', [
			['heart', 3], ['heart', 4], ['heart', 6], ['heart', 7], ['heart', 8], ['heart', 9], ['heart', 12],
			['diamond', 12], ['heart', 5], ['heart', 6], ['diamond', 2], ['diamond', 3],
		]),
		...many('jiu', [['diamond', 9], ['spade', 3], ['spade', 9], ['club', 3], ['club', 9]]),

		...many('juedou', [['spade', 1], ['club', 1], ['diamond', 1]]),
		...many('guohechaiqiao', [['spade', 3], ['spade', 4], ['spade', 12], ['club', 3], ['club', 4], ['heart', 12]]),
		...many('shunshouqianyang', [['spade', 3], ['spade', 4], ['spade', 11], ['diamond', 3], ['diamond', 4]]),
		...many('wuzhongshengyou', [['heart', 7], ['heart', 8], ['heart', 9], ['heart', 11]]),
		...many('nanmanruqin', [['spade', 7], ['spade', 13], ['club', 7]]),
		...many('wanjianqifa', [['heart', 1]]),
		...many('taoyuanjieyi', [['heart', 1]]),
		...many('wugufengdeng', [['heart', 3], ['heart', 4]]),
		...many('jiedaosharen', [['club', 12], ['club', 13]]),
		...many('wuxiekeji', [
			['spade', 11], ['club', 12], ['club', 13], ['diamond', 12], ['heart', 1], ['heart', 13], ['spade', 13],
		]),
		...many('tiesuolianhuan', [
			['spade', 11], ['spade', 12], ['club', 10], ['club', 11], ['club', 12], ['club', 13],
		]),
		...many('huogong', [['heart', 2], ['heart', 3], ['diamond', 12]]),

		...many('lebusishu', [['spade', 6], ['club', 6], ['heart', 6]]),
		...many('shandian', [['spade', 1], ['heart', 12]]),
		...many('bingliangcunduan', [['spade', 10], ['club', 4]]),

		...many('zhugeliannu', [['club', 1], ['diamond', 1]]),
		...many('cixiongshuanggujian', [['spade', 2]]),
		...many('qinggangjian', [['spade', 6]]),
		...many('qinglongyanyuedao', [['spade', 5]]),
		...many('zhangbashemao', [['spade', 12]]),
		...many('guanshifu', [['diamond', 5]]),
		...many('fangtianhuaji', [['diamond', 12]]),
		...many('qilinong', [['heart', 5]]),
		...many('hanbingjian', [['spade', 2]]),

		...many('bagua', [['spade', 2], ['club', 2]]),
		...many('renwangdun', [['club', 2]]),
		...many('tengjia', [['spade', 2], ['club', 2]]),
		...many('baiyinshizi', [['club', 1]]),

		...many('jueying', [['spade', 5]]),
		...many('dayuan', [['spade', 13]]),
		...many('zixing', [['diamond', 13]]),
		...many('chitu', [['heart', 5]]),
		...many('dilu', [['club', 5]]),
		...many('zhuahuangfeidian', [['heart', 13]]),
	],
};

export function buildDeck(packs: string[]): Array<Omit<Card, 'id'>> {
	const enabled = new Set(packs);
	const out: Array<Omit<Card, 'id'>> = [];
	for (const [pack, cards] of Object.entries(PACKS)) {
		if (enabled.has(pack)) out.push(...cards);
	}
	return out;
}
