/**
 * 单挑（1v1）：各带 3 名武将轮换上场，直到一方三将尽出。
 *
 * 与身份局最大的架构差异：这里的"阵亡"不是终局事件，而是"换下一名武将"。
 * 拦截点选在 `Game.die()`——它是"角色真正死透"前的最后一站（濒死救援已经在
 * `dying()` 里问过一圈桃，问完还 <=0 才会走到这里）。这个座位还有替补武将时，
 * 就地换将（**不置 `alive = false`**），让整局继续把这个座位当"活人"对待，
 * 换完直接 return，不落到 `super.die()` 那套终局清算（死亡奖惩/胜负判定）；
 * 替补耗尽时才调用 `super.die()`，那时这个座位才真正出局。
 *
 * 选替这一层没有引入新的 AskRequest 种类——选将复用 `chooseOption`（前端已有
 * `GeneralPicker` 入口），依次问 3 次候选，选中的顺序就是出场顺序，"选"和"排"
 * 一步到位，不需要再单独发一次排序请求。
 */

import { Game, type Registry } from '../game.js';
import type { GameRecord } from '../protocol.js';
import type { PlayerState } from '../types.js';

/** 每方带的武将数，也是候选池大小——候选就是最终名单，不用再从更大的池子里挑 */
const ROSTER_SIZE = 3;

export class DuelGame extends Game {
	/** 每个座位尚未登场的武将，先后有序。当前正在用的那个不在这里面 */
	private roster: Record<string, string[]> = {};

	constructor(record: GameRecord, registry: Registry) {
		super(record, registry);
	}

	protected override async setupGame(): Promise<void> {
		const n = this.setup.players.length;
		if (n !== 2) throw new Error(`单挑只支持 2 人，当前 ${n} 人`);

		this.state.players = this.setup.players.map(
			(p, seat): PlayerState => ({
				id: p.id,
				seat,
				nickname: p.nickname,
				general: '',
				faction: 'qun',
				gender: 'male',
				// 单挑没有身份概念，这里只是类型要求的占位值，不参与任何判断——
				// 前端一律按 view.mode === 'duel' 门控，不展示身份相关 UI
				// （Table.tsx 的 identity 徽标/结算列表、Onboarding.tsx 的身份目标）
				identity: 'rebel',
				identityRevealed: true,
				maxHp: 4,
				hp: 4,
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
			}),
		);
		this.state.seating = this.state.players.map((p) => p.id);
		this.state.currentPlayer = this.state.players[0].id;

		await this.pickRosters();

		for (const p of this.state.players) {
			const first = this.roster[p.id].shift()!;
			this.applyGeneral(p, first);
			this.setFlag(p.id, 'game:rosterTotal', ROSTER_SIZE);
			this.setFlag(p.id, 'game:rosterLeft', ROSTER_SIZE);
		}

		// 先手摸 4、后手摸 6——补偿先手优势，这是单挑区别于身份局开局发牌的地方
		await this.drawCards(this.state.players[0].id, 4, 'initial');
		await this.drawCards(this.state.players[1].id, 6, 'initial');

		this.pushLog({ kind: 'gameSetup', players: this.state.players.map((p) => p.id) });
	}

	/** 每人发 3 个不重复候选，依次挑出场顺序——候选就是最终名单，不用再挑一次 */
	private async pickRosters(): Promise<void> {
		const packs = new Set(this.setup.packs);
		const pool = this.rng.shuffle(
			Object.values(this.registry.generals)
				.filter((g) => packs.has(g.pack))
				.map((g) => g.id),
		);

		for (const p of this.state.players) {
			const fixed = this.setup.rosters?.[p.id];
			if (fixed) {
				this.roster[p.id] = fixed.slice();
				continue;
			}
			const cands = pool.splice(0, ROSTER_SIZE);
			if (cands.length < ROSTER_SIZE) throw new Error('武将池不足');
			this.roster[p.id] = await this.orderRoster(p, cands);
		}
	}

	/**
	 * 依次问 ROSTER_SIZE 次"这次选谁上场"：候选池只减不增，每次选中的追加进队尾。
	 * 选择的先后顺序即出场顺序（先选的先上场）——"选 3 个"和"排一个顺序"在这里
	 * 是同一个动作，不需要选完再问一次排序。只剩最后一个候选时不必再问（唯一
	 * 选项没有选择的余地），直接收编，省一次无意义的读秒。
	 */
	private async orderRoster(p: PlayerState, cands: string[]): Promise<string[]> {
		const remaining = cands.slice();
		const order: string[] = [];
		while (remaining.length > 1) {
			const optionId = await this.askOption(
				p.id,
				order.length === 0 ? '请选择首发武将' : `请选择第 ${order.length + 1} 位出场武将`,
				remaining.map((id) => ({ id, label: this.registry.generals[id].cn })),
				false,
				// 选将要读技能再决定，和身份局一样给足时间（见 modes/identity.ts 的同款注释）
				60,
			);
			const picked = optionId && remaining.includes(optionId) ? optionId : remaining[0];
			order.push(picked);
			remaining.splice(remaining.indexOf(picked), 1);
		}
		order.push(remaining[0]);
		return order;
	}

	private applyGeneral(p: PlayerState, generalId: string): void {
		const g = this.registry.generals[generalId];
		if (!g) throw new Error(`未注册的武将: ${generalId}`);
		p.general = g.id;
		p.faction = g.faction;
		p.gender = g.gender;
		p.maxHp = g.maxHp;
		p.hp = g.maxHp;
		// 主公技只对"主公"这个身份生效，单挑没有主公，永远过滤掉——
		// 和身份局里非主公玩家选到带主公技的武将时是同一条判断（见 modes/identity.ts）
		p.skills = g.skills.filter((sid) => !this.registry.skills[sid]?.tags?.includes('lord'));
		this.pushLog({ kind: 'general', who: p.id, general: g.id });
	}

	/**
	 * 覆写死亡：这个座位还有替补武将就原地换将，不算真正死亡——不设 `alive = false`，
	 * 也不进 `super.die()` 那套终局清算（死亡奖惩、胜负判定）。换完直接 return。
	 * 替补耗尽才调用 `super.die()`，胜负判定交给下面覆写的 `checkWin()`。
	 */
	override async die(who: string, killer?: string): Promise<void> {
		const p = this.player(who);
		if (!p.alive) return;

		const next = this.roster[who]?.shift();
		// 无论是换将还是真正阵亡，这个座位都少了一名可用武将，先记账——
		// 前端靠这个字段（走公开 flags/marks 通路）显示"对方还剩几名武将"
		this.addFlag(who, 'game:rosterLeft', -1);

		if (!next) {
			await super.die(who, killer);
			return;
		}

		this.pushLog({ kind: 'die', who, killer, identity: p.identity, switching: true });
		await this.trigger('onDie', { who, killer });

		// 旧武将的手牌/装备/判定区全部作废，进弃牌堆
		const all = [...p.hand, ...Object.values(p.equip), ...p.judge].filter(
			(x): x is number => typeof x === 'number',
		);
		if (all.length) await this.discardCards(all, 'die', who);
		p.skills = [];

		// 本回合已经用掉的技能/出牌次数是上一位武将的账，新武将不该背着走——
		// round:/game: 前缀的计数（如 rosterLeft）是跨武将的，只清 turn: 的
		for (const k of Object.keys(p.flags)) {
			if (k.startsWith('turn:')) delete p.flags[k];
		}

		this.applyGeneral(p, next);
		await this.drawCards(who, 4, 'switchGeneral');

		this.pushLog({ kind: 'switchGeneral', who, general: next, remaining: this.roster[who]!.length });
	}

	/** 一方三将尽出（`alive = false`）即另一方获胜 */
	protected override checkWin(): void {
		if (this.state.finished) return;
		const dead = this.state.players.find((p) => !p.alive);
		if (!dead) return;
		const winner = this.state.players.find((p) => p.alive);
		if (winner) this.finish([winner.id], `${dead.nickname} 三将尽出，${winner.nickname} 获胜`);
		else this.finish([], '平局');
	}
}
