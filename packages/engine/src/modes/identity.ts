/**
 * 身份局：主公 / 忠臣 / 内奸 / 反贼，5–8 人。
 *
 * 这是 v1 唯一的模式。1v1、国战等以后加新的 Game 子类即可 —— 引擎核心
 * （结算、时机、事件溯源）与模式无关，模式层只管开局布置、死亡奖惩和胜负判定。
 */

import { Game, GameOver, type Registry } from '../game.js';
import { markLimit } from '../options.js';
import type { GameRecord } from '../protocol.js';
import type { Identity, PlayerState } from '../types.js';

/** 人数 → 身份构成。顺序无意义，会被打乱 */
const IDENTITY_TABLE: Record<number, Identity[]> = {
	5: ['lord', 'loyalist', 'spy', 'rebel', 'rebel'],
	6: ['lord', 'loyalist', 'spy', 'rebel', 'rebel', 'rebel'],
	7: ['lord', 'loyalist', 'loyalist', 'spy', 'rebel', 'rebel', 'rebel'],
	8: ['lord', 'loyalist', 'loyalist', 'spy', 'rebel', 'rebel', 'rebel', 'rebel'],
};

export const IDENTITY_CN: Record<Identity, string> = {
	lord: '主公',
	loyalist: '忠臣',
	rebel: '反贼',
	spy: '内奸',
};

/** 每人的选将候选数 */
const GENERAL_CHOICES = 3;

export class IdentityGame extends Game {
	constructor(record: GameRecord, registry: Registry) {
		super(record, registry);
	}

	protected override async setupGame(): Promise<void> {
		const n = this.setup.players.length;
		const table = IDENTITY_TABLE[n];
		if (!table) throw new Error(`身份局只支持 5–8 人，当前 ${n} 人`);

		// 座次随机，主公坐 0 号位（其余身份在 1..n-1 上打乱）
		const order = this.rng.shuffle(this.setup.players.slice());
		const rest = this.rng.shuffle(table.filter((x) => x !== 'lord'));

		this.state.players = order.map((p, seat) => {
			const identity: Identity =
				this.setup.identities?.[p.id] as Identity | undefined ??
				(seat === 0 ? 'lord' : rest[seat - 1]);
			return {
				id: p.id,
				seat,
				nickname: p.nickname,
				general: '',
				faction: 'qun',
				gender: 'male',
				identity,
				identityRevealed: identity === 'lord',
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
			} satisfies PlayerState;
		});
		this.state.seating = this.state.players.map((p) => p.id);
		this.state.currentPlayer = this.state.players[0].id;

		await this.chooseGenerals();

		// 主公多 1 点体力上限
		const lord = this.state.players[0];
		lord.maxHp += 1;
		lord.hp = lord.maxHp;

		for (const p of this.state.players) {
			await this.drawCards(p.id, 4, 'initial');
		}

		this.pushLog({ kind: 'gameSetup', players: this.state.players.map((p) => p.id) });
	}

	/** 选将：主公先选，其余按座次依次选。候选不重复 */
	private async chooseGenerals(): Promise<void> {
		const packs = new Set(this.setup.packs);
		const pool = this.rng.shuffle(
			Object.values(this.registry.generals).filter((g) => packs.has(g.pack)).map((g) => g.id),
		);

		for (const p of this.state.players) {
			const fixed = this.setup.generals?.[p.id];
			let picked: string;

			if (fixed) {
				picked = fixed;
			} else {
				const cands = pool.splice(0, GENERAL_CHOICES);
				if (cands.length === 0) throw new Error('武将池不足');
				const optionId = await this.askOption(
					p.id,
					p.identity === 'lord' ? '你是主公，请选择武将' : '请选择武将',
					cands.map((id) => ({ id, label: this.registry.generals[id].cn })),
					false,
					// 选将是全局唯一一个需要"读技能再决定"的选择，给足时间；
					// 其余请求维持 20–40 秒，否则掉线的人会把整局拖死
					60,
				);
				picked = optionId && cands.includes(optionId) ? optionId : cands[0];
				// 没选中的候选放回池底，供后面的人选
				pool.push(...cands.filter((c) => c !== picked));
			}

			this.applyGeneral(p, picked);
		}
	}

	private applyGeneral(p: PlayerState, generalId: string): void {
		const g = this.registry.generals[generalId];
		if (!g) throw new Error(`未注册的武将: ${generalId}`);
		p.general = g.id;
		p.faction = g.faction;
		p.gender = g.gender;
		p.maxHp = g.maxHp;
		p.hp = g.maxHp;
		// 主公技只有主公能用
		p.skills = g.skills.filter((sid) => {
			const s = this.registry.skills[sid];
			if (s?.tags?.includes('lord') && p.identity !== 'lord') return false;
			return true;
		});
		this.pushLog({ kind: 'general', who: p.id, general: g.id });
	}

	/**
	 * 死亡奖惩：杀反贼摸三张；主公杀死忠臣则弃光自己的牌。
	 * 内奸和主公之死无奖惩。
	 */
	protected override async onDeathReward(who: string, killer?: string): Promise<void> {
		if (!killer || killer === who) return;
		const dead = this.player(who);
		const k = this.state.players.find((p) => p.id === killer);
		if (!k?.alive) return;

		if (dead.identity === 'rebel') {
			await this.drawCards(killer, 3, 'reward:rebel');
			this.pushLog({ kind: 'reward', who: killer, reason: 'killRebel' });
		} else if (dead.identity === 'loyalist' && k.identity === 'lord') {
			const all = [...k.hand, ...Object.values(k.equip)].filter(
				(x): x is number => typeof x === 'number',
			);
			if (all.length) await this.discardCards(all, 'punish:loyalist', killer);
			this.pushLog({ kind: 'punish', who: killer, reason: 'lordKillLoyalist' });
		}
	}

	protected override checkWin(): void {
		if (this.state.finished) return;
		const alive = this.alivePlayers();
		const lord = this.state.players.find((p) => p.identity === 'lord')!;
		const rebelsAlive = alive.filter((p) => p.identity === 'rebel').length;
		const spyAlive = alive.filter((p) => p.identity === 'spy').length;

		if (!lord.alive) {
			// 主公倒下：内奸若是唯一存活者则内奸胜，否则反贼胜
			if (spyAlive === 1 && alive.length === 1) {
				this.finish(
					this.state.players.filter((p) => p.identity === 'spy').map((p) => p.id),
					'内奸胜',
				);
			} else {
				this.finish(
					this.state.players.filter((p) => p.identity === 'rebel').map((p) => p.id),
					'反贼胜',
				);
			}
			return;
		}

		if (rebelsAlive === 0 && spyAlive === 0) {
			this.finish(
				this.state.players
					.filter((p) => p.identity === 'lord' || p.identity === 'loyalist')
					.map((p) => p.id),
				'主公方胜',
			);
		}
	}
}

/** 跑一局到"需要玩家输入"或"已结束"为止 */
export async function startIdentityGame(
	record: GameRecord,
	registry: Registry,
	optionProvider: NonNullable<Game['optionProvider']>,
): Promise<IdentityGame> {
	const g = new IdentityGame(record, registry);
	g.optionProvider = optionProvider;
	// 不 await：引擎会跑到第一个待决策点然后挂起
	void g.runGame().catch((e) => {
		if (!(e instanceof GameOver)) throw e;
	});
	await g.waitIdle();
	return g;
}

export { markLimit };
