import { useEffect, useState } from 'react';
import { IDENTITY_GOAL, type GameView } from '@sgs/engine';

/**
 * 开局引导。
 *
 * 前面把身份目标做进了"点武将牌看详情"里 —— 但**新手根本想不到去点**，
 * 藏在点击后面的信息等于没有。而且他缺的第一样东西不是某张牌的说明，
 * 是"我到底该干什么"。所以开局直接怼到脸上，看完再开始。
 *
 * 只在**每局开始时**弹一次（按房间+局次记在 localStorage），不打扰老手；
 * 右上角常驻一个「?」随时能重新调出来。
 */

const FLOW = [
	['摸牌', '每回合先摸 2 张牌'],
	['出牌', '想出几张出几张，但【杀】每回合只能用一次'],
	['弃牌', '回合结束时，手牌超过体力值的部分要弃掉'],
];

/**
 * 术语表。
 *
 * 这批词是审计出来的 —— 统计界面和文案里出现的三国杀术语，再看它们有没有
 * 在任何面向玩家的地方被定义过。结果「判定」出现 23 次、「锁定技」23 次，
 * 定义次数都是 0 —— 我自己写的牌说明里就在用「判定」，却从没说过那是什么。
 * 对老手是空气，对新手是墙。
 */
const GLOSSARY = [
	['判定', '从牌堆翻开一张牌，看它的花色决定成败。乐不思蜀、闪电、八卦阵都靠它'],
	['锁定技', '必须发动的技能，没得选。技能名前标了「锁定技」的就是'],
	['势力', '武将头像角上的魏/蜀/吴/群。跟你的身份无关，只有少数技能会看它'],
	['装备区', '武将牌上放武器、防具、坐骑的地方。装备是公开的，谁都看得见'],
	['判定区', '武将牌上放乐不思蜀、闪电这类牌的地方，回合开始时结算'],
	['重铸', '出牌阶段把牌弃掉换摸一张。目前只有【铁索连环】能这么做'],
];

const BASICS = [
	['【杀】', '打人。对方出【闪】就躲开了'],
	['【闪】', '躲开一张【杀】。只能被指定时打出，不能主动用'],
	['【桃】', '回 1 点血。也能救濒死的人'],
	['距离', '只能打到「攻击范围」内的人。骑马能改变距离'],
];

export function Onboarding({ view }: { view: GameView }) {
	const me = view.players.find((p) => p.id === view.you);
	const identity = me?.identity;
	// 每局只自动弹一次：key 里带上牌堆数，换局必然不同
	const seenKey = `sgs.guide.${view.seating.join('')}.${identity ?? ''}`;
	const [open, setOpen] = useState(false);

	useEffect(() => {
		if (!identity) return;
		if (localStorage.getItem(seenKey)) return;
		localStorage.setItem(seenKey, '1');
		setOpen(true);
	}, [identity, seenKey]);

	if (!identity) return null;

	return (
		<>
			<button className="guide-btn" title="怎么玩" onClick={() => setOpen(true)}>
				?
			</button>

			{open && (
				<div className="picker" onClick={() => setOpen(false)}>
					<div className="guide" onClick={(e) => e.stopPropagation()}>
						<div className="guide__goal" data-i={identity}>
							{IDENTITY_GOAL[identity]}
						</div>

						<div className="guide__cols">
							<div>
								<div className="guide__h">一个回合做三件事</div>
								{FLOW.map(([k, v]) => (
									<div className="guide__row" key={k}>
										<b>{k}</b>
										<span>{v}</span>
									</div>
								))}
							</div>
							<div>
								<div className="guide__h">最常用的几张牌</div>
								{BASICS.map(([k, v]) => (
									<div className="guide__row" key={k}>
										<b>{k}</b>
										<span>{v}</span>
									</div>
								))}
							</div>
						</div>

						<div className="guide__glossary">
							<div className="guide__h">看不懂的词</div>
							{GLOSSARY.map(([k, v]) => (
								<div className="guide__row" key={k}>
									<b>{k}</b>
									<span>{v}</span>
								</div>
							))}
						</div>

						<div className="guide__tip">
							不知道一张牌是干什么的？<b>点它一下</b>，下面会写清楚。
							<br />
							想看某个武将的技能？<b>点他的武将牌</b>。
						</div>

						<button className="btn" onClick={() => setOpen(false)}>
							开 始
						</button>
					</div>
				</div>
			)}
		</>
	);
}
