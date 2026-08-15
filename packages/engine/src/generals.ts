/**
 * 标准包 25 将 + 风包 / 火包。数值与技能列表已与 noname 逐条核对
 * （标准包对 `character/standard/character.js`，风火两包对 `character/shenhua/`，
 * 分包归属以同目录 `sort.js` 的 `shenhua_feng` / `shenhua_huo` 为准）。
 * id 同时也是立绘文件名（art/character/<id>.webp），所以风火两包沿用 noname 的原 id
 * （`re_` / `old_` / `sp_` 前缀是 noname 区分同名武将不同版本的方式，跟着它才对得上图）。
 */

import type { GeneralDef } from './defs.js';

const g = (
	id: string,
	cn: string,
	faction: GeneralDef['faction'],
	gender: GeneralDef['gender'],
	maxHp: number,
	skills: string[],
	pack = 'standard',
): GeneralDef => ({ id, cn, faction, gender, maxHp, skills, pack });

export const GENERALS: Record<string, GeneralDef> = Object.fromEntries(
	[
		// ── 魏 ──
		g('caocao', '曹操', 'wei', 'male', 4, ['jianxiong', 'hujia']),
		g('simayi', '司马懿', 'wei', 'male', 3, ['fankui', 'guicai']),
		g('xiahoudun', '夏侯惇', 'wei', 'male', 4, ['ganglie']),
		g('zhangliao', '张辽', 'wei', 'male', 4, ['tuxi']),
		g('xuzhu', '许褚', 'wei', 'male', 4, ['luoyi']),
		g('guojia', '郭嘉', 'wei', 'male', 3, ['tiandu', 'yiji']),
		g('zhenji', '甄姬', 'wei', 'female', 3, ['luoshen', 'qingguo']),

		// ── 蜀 ──
		g('liubei', '刘备', 'shu', 'male', 4, ['rende', 'jijiang']),
		g('guanyu', '关羽', 'shu', 'male', 4, ['wusheng']),
		g('zhangfei', '张飞', 'shu', 'male', 4, ['paoxiao']),
		g('zhugeliang', '诸葛亮', 'shu', 'male', 3, ['guanxing', 'kongcheng']),
		g('zhaoyun', '赵云', 'shu', 'male', 4, ['longdan']),
		g('machao', '马超', 'shu', 'male', 4, ['mashu', 'tieji']),
		g('huangyueying', '黄月英', 'shu', 'female', 3, ['jizhi', 'qicai']),

		// ── 吴 ──
		g('sunquan', '孙权', 'wu', 'male', 4, ['zhiheng', 'jiuyuan']),
		g('ganning', '甘宁', 'wu', 'male', 4, ['qixi']),
		g('lvmeng', '吕蒙', 'wu', 'male', 4, ['keji']),
		g('huanggai', '黄盖', 'wu', 'male', 4, ['kurou']),
		g('zhouyu', '周瑜', 'wu', 'male', 3, ['yingzi', 'fanjian']),
		g('daqiao', '大乔', 'wu', 'female', 3, ['guose', 'liuli']),
		g('luxun', '陆逊', 'wu', 'male', 3, ['qianxun', 'lianying']),
		g('sunshangxiang', '孙尚香', 'wu', 'female', 3, ['xiaoji', 'jieyin']),

		// ── 群 ──
		g('huatuo', '华佗', 'qun', 'male', 3, ['qingnang', 'jijiu']),
		g('lvbu', '吕布', 'qun', 'male', 4, ['wushuang']),
		g('diaochan', '貂蝉', 'qun', 'female', 3, ['lijian', 'biyue']),

		// ── 风包（神话再临·风） ──
		// 周泰、于吉不在此列：不屈要求「武将牌上的牌」这个区域，蛊惑要求整套质疑流程，
		// 引擎两样都没有，加它们就得动 game.ts。少两个将好过破坏重放约束。
		g('old_caoren', '曹仁', 'wei', 'male', 4, ['jushou'], 'wind'),
		g('re_xiahouyuan', '夏侯渊', 'wei', 'male', 4, ['xinshensu'], 'wind'),
		g('re_huangzhong', '黄忠', 'shu', 'male', 4, ['xinliegong'], 'wind'),
		g('re_weiyan', '魏延', 'shu', 'male', 4, ['xinkuanggu', 'qimou'], 'wind'),
		g('xiaoqiao', '小乔', 'wu', 'female', 3, ['retianxiang'], 'wind'),
		g('sp_zhangjiao', '张角', 'qun', 'male', 3, ['releiji', 'guidao'], 'wind'),

		// ── 火包（神话再临·火） ──
		g('dianwei', '典韦', 'wei', 'male', 4, ['qiangxix'], 'fire'),
		g('xunyu', '荀彧', 'wei', 'male', 3, ['quhu', 'jieming'], 'fire'),
		g('pangtong', '庞统', 'shu', 'male', 3, ['lianhuan', 'oldniepan'], 'fire'),
		// 与标准包的 zhugeliang（诸葛亮）是两个武将，共存
		g('sp_zhugeliang', '卧龙诸葛亮', 'shu', 'male', 3, ['bazhen', 'huoji', 'kanpo'], 'fire'),
		g('taishici', '太史慈', 'wu', 'male', 4, ['tianyi'], 'fire'),
		g('yanwen', '颜良文丑', 'qun', 'male', 4, ['shuangxiong'], 'fire'),
		g('re_yuanshao', '袁绍', 'qun', 'male', 4, ['luanji', 'xueyi'], 'fire'),
		g('re_pangde', '庞德', 'qun', 'male', 4, ['mashu', 'jianchu'], 'fire'),
	].map((x) => [x.id, x]),
);

export const GENERAL_IDS = Object.keys(GENERALS);

/**
 * 开新局默认启用的卡牌包。房间和压测都从这里取，避免两边各写一份literal后悄悄漂移
 * （`buildDeck()` 也吃这个列表，但风火两包只加武将不加牌，牌堆张数不受影响）。
 */
export const DEFAULT_PACKS = ['standard', 'wind', 'fire'];
