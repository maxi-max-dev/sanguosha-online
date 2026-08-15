/**
 * 客户端 ↔ 服务端的 WebSocket 报文。
 *
 * 放在 engine 包里是因为它只是类型（不含任何网络实现），而 web 和 server 都要引用它 ——
 * 与其为几十行类型单开一个 shared 包，不如让唯一的真源跟着领域模型走。
 */

import type { LogEntry } from './game.js';
import type { DecisionPayload, GameSetup } from './protocol.js';
import type { AskHint, GameView } from './view.js';

/** 大厅里的一个座位 */
export interface LobbyPlayer {
	pid: string;
	name: string;
	host: boolean;
	online: boolean;
	bot: boolean;
}

export type ClientMsg =
	/** 进房/重连。pid 由客户端生成并存在 localStorage，是断线重连的身份凭据 */
	| { t: 'hello'; pid: string; name: string }
	/** 房主切换模式（身份局/单挑），只在开局前有效 */
	| { t: 'setMode'; mode: GameSetup['mode'] }
	/** 房主开始游戏 */
	| { t: 'start' }
	/** 房主加/减机器人补位（人不齐时凑够开局所需人数） */
	| { t: 'addBot' }
	| { t: 'removeBot' }
	/** 房主开下一局：清掉牌局回到大厅，座位和人不散 */
	| { t: 'restart' }
	/** 提交决策。seq 必须与当前请求一致，否则服务端拒绝（防重复提交和乱序） */
	| { t: 'decide'; seq: number; payload: DecisionPayload }
	/**
	 * 聊天：快捷语/自由输入/表情共用一种报文。
	 * `to` 有值表示对准某个人喊（服务端不校验它是不是合法 pid——聊天不影响规则，
	 * 传错了顶多显示一个查不到昵称的空字符串，没有作弊或状态损坏的风险）；
	 * 不填就是广播全场。`kind` 缺省当作 'text'，'emoji' 只影响前端的气泡样式。
	 */
	| { t: 'chat'; text: string; to?: string; kind?: 'text' | 'emoji' }
	| { t: 'ping' };

export type ServerMsg =
	| { t: 'lobby'; room: string; players: LobbyPlayer[]; you: string; canStart: boolean; mode: GameSetup['mode'] }
	/** 完整状态视图。已按收件人视角裁剪 */
	| { t: 'view'; view: GameView; hint?: AskHint; deadline?: number }
	/** 增量动画事件 */
	| { t: 'log'; entries: LogEntry[] }
	/**
	 * `fromId` 是发言人的 pid（前端要靠它把气泡锚到对应的武将牌上，`from` 只是显示名，
	 * 改名之后旧气泡不该跟着变）。`at` 由服务端盖章，不用各客户端自己的墙钟时间，
	 * 免得几台设备时钟不同步时聊天记录排序看着乱。
	 */
	| { t: 'chat'; fromId: string; from: string; text: string; to?: string; kind: 'text' | 'emoji'; at: number }
	| { t: 'error'; msg: string }
	| { t: 'pong' };
