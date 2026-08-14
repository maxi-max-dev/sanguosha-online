/**
 * 标准包 25 将。数值与技能列表已与 noname 的 `character/standard/character.js` 逐条核对。
 * id 同时也是立绘文件名（art/character/<id>.webp）。
 */

import type { GeneralDef } from './defs.js';

const g = (
	id: string,
	cn: string,
	faction: GeneralDef['faction'],
	gender: GeneralDef['gender'],
	maxHp: number,
	skills: string[],
): GeneralDef => ({ id, cn, faction, gender, maxHp, skills, pack: 'standard' });

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
	].map((x) => [x.id, x]),
);

export const GENERAL_IDS = Object.keys(GENERALS);
