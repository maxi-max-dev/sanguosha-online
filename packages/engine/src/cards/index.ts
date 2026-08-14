/**
 * 军争篇全部卡牌的汇总表。加新的卡牌包只需要在这里多合并一张表。
 */
import type { CardDef } from '../defs.js';
import { BASIC_CARDS } from './basic.js';
import { DELAYED_CARDS } from './delayed.js';
import { EQUIP_CARDS } from './equip.js';
import { TRICK_CARDS } from './trick.js';

export const CARDS: Record<string, CardDef> = {
	...BASIC_CARDS,
	...TRICK_CARDS,
	...DELAYED_CARDS,
	...EQUIP_CARDS,
};

export { BASIC_CARDS, TRICK_CARDS, DELAYED_CARDS, EQUIP_CARDS };
