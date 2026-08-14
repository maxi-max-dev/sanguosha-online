/**
 * 把卡牌、技能、武将拼成引擎需要的 Registry。
 * 这是所有内容模块的唯一汇合点 —— 加扩展包只需要在这里多合并一张表。
 */

import { CARDS } from './cards/index.js';
import { buildDeck } from './deck.js';
import type { Registry } from './game.js';
import { GENERALS } from './generals.js';
import { ALL_SKILLS } from './skills/index.js';

export const registry: Registry = {
	cards: CARDS,
	skills: ALL_SKILLS,
	generals: GENERALS,
	buildDeck,
};

export { CARDS, ALL_SKILLS, GENERALS, buildDeck };
