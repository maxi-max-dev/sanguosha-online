/**
 * 跨势力技能共用的小工具。目前只有"拼点"：荀彧的驱虎（wei.ts）、太史慈的天义（wu.ts）
 * 都要用，两个技能分属不同势力文件，抽到这里避免两个文件互相 import。
 */
import type { Game } from '../game.js';

export interface PindianResult {
	initiatorCard: number;
	opponentCard: number;
	/** 点数相同视为发起者没赢——原版规则里拼点平局本就没有"双赢"，这里选择对发起者不利的一侧，不算取舍 */
	initiatorWins: boolean;
}

/**
 * 拼点：双方各背面选一张手牌，同时亮开比点数。用两次独立的 askCards 顺序实现
 * "同时"：第二个人选的时候还看不到第一个人选了什么（还没进弃牌堆，不广播），
 * 效果上等价于同时选。
 */
export async function pindian(
	g: Game,
	initiator: string,
	opponent: string,
	reason: string,
): Promise<PindianResult | undefined> {
	const ip = g.player(initiator);
	const op = g.player(opponent);
	if (ip.hand.length === 0 || op.hand.length === 0) return undefined;

	const iPicked = await g.askCards(initiator, '拼点：选择一张手牌（背面比点数）', ip.hand.map((id) => ({ id })), 1, 1);
	const oPicked = await g.askCards(opponent, '拼点：选择一张手牌（背面比点数）', op.hand.map((id) => ({ id })), 1, 1);
	const iCard = iPicked[0];
	const oCard = oPicked[0];
	if (iCard === undefined || oCard === undefined) return undefined;

	const iNum = g.card(iCard).number;
	const oNum = g.card(oCard).number;
	await g.discardCards([iCard], reason, initiator);
	await g.discardCards([oCard], reason, opponent);
	g.pushLog({ kind: 'pindian', initiator, opponent, initiatorCard: iCard, opponentCard: oCard, reason });

	return { initiatorCard: iCard, opponentCard: oCard, initiatorWins: iNum > oNum };
}
