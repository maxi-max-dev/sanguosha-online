/**
 * 卡牌实现之间共享的小工具。
 *
 * 无双相关的次数聚合（几张闪/几张杀）现在由 Game.shanNeeded / Game.shaNeededInDuel /
 * Game.ignoresDistance 这几个公开方法提供，卡牌这边不用再自己遍历技能表算 mods 了。
 * 这里只留"选目标区域里的牌"这类和 mods 无关的公共小工具。
 */
import type { Game } from '../game.js';

/** 某角色手牌/装备区/判定区里的全部牌，供过河拆桥/顺手牵羊这类"选一张牌"的卡牌使用 */
export function allCardsOf(
	g: Game,
	playerId: string,
): Array<{ id: number; unknown?: boolean; from: string; zone: string }> {
	const p = g.player(playerId);
	const out: Array<{ id: number; unknown?: boolean; from: string; zone: string }> = [];
	// from/zone 是前端选牌浮层分组展示用的（"XX 的手牌/装备区/判定区"），
	// 不带就没法告诉玩家这张背面朝上的牌到底是谁的
	for (const id of p.hand) out.push({ id, unknown: true, from: playerId, zone: 'hand' });
	for (const id of Object.values(p.equip)) if (typeof id === 'number') out.push({ id, from: playerId, zone: 'equip' });
	for (const id of p.judge) out.push({ id, from: playerId, zone: 'judge' });
	return out;
}

/** 某角色的手牌/装备/判定三个区域里是否还有牌 */
export function hasAnyCards(g: Game, playerId: string): boolean {
	const p = g.player(playerId);
	return p.hand.length > 0 || Object.keys(p.equip).length > 0 || p.judge.length > 0;
}
