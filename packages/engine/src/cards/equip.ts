/**
 * 装备牌（19 张）：9 件武器 + 4 件防具 + 6 匹坐骑。
 *
 * 装备牌本身没有 onUse/onEffect —— useCard() 对 type:'equip' 直接调用 equipCard()，
 * 不走目标结算那一套。武器/防具的实际效果都在 equipSkill 指向的 skills/equip.ts 里；
 * 坐骑没有 equipSkill，距离修正是 game.ts 的 distance() 直接读 equip.horsePlus/horseMinus。
 */
import type { CardDef } from '../defs.js';

// ─────────────────────────── 武器 ───────────────────────────

export const zhugeliannu: CardDef = {
	name: 'zhugeliannu',
	cn: '诸葛连弩',
	type: 'equip',
	subtype: 'weapon',
	range: 1,
	equipSkill: 'zhuge',
};

export const cixiongshuanggujian: CardDef = {
	name: 'cixiongshuanggujian',
	cn: '雌雄双股剑',
	type: 'equip',
	subtype: 'weapon',
	range: 2,
	equipSkill: 'cixiong',
};

export const qinggangjian: CardDef = {
	name: 'qinggangjian',
	cn: '青釭剑',
	type: 'equip',
	subtype: 'weapon',
	range: 2,
	equipSkill: 'qinggang',
};

export const qinglongyanyuedao: CardDef = {
	name: 'qinglongyanyuedao',
	cn: '青龙偃月刀',
	type: 'equip',
	subtype: 'weapon',
	range: 3,
	equipSkill: 'qinglong',
};

export const zhangbashemao: CardDef = {
	name: 'zhangbashemao',
	cn: '丈八蛇矛',
	type: 'equip',
	subtype: 'weapon',
	range: 3,
	equipSkill: 'zhangba',
};

export const guanshifu: CardDef = {
	name: 'guanshifu',
	cn: '贯石斧',
	type: 'equip',
	subtype: 'weapon',
	range: 3,
	equipSkill: 'guanshi',
};

export const fangtianhuaji: CardDef = {
	name: 'fangtianhuaji',
	cn: '方天画戟',
	type: 'equip',
	subtype: 'weapon',
	range: 4,
	equipSkill: 'fangtian',
};

export const qilinong: CardDef = {
	name: 'qilinong',
	cn: '麒麟弓',
	type: 'equip',
	subtype: 'weapon',
	range: 5,
	equipSkill: 'qilin',
};

export const hanbingjian: CardDef = {
	name: 'hanbingjian',
	cn: '寒冰剑',
	type: 'equip',
	subtype: 'weapon',
	range: 2,
	equipSkill: 'hanbing',
};

// ─────────────────────────── 防具 ───────────────────────────

export const bagua: CardDef = {
	name: 'bagua',
	cn: '八卦阵',
	type: 'equip',
	subtype: 'armor',
	equipSkill: 'bagua',
};

export const renwangdun: CardDef = {
	name: 'renwangdun',
	cn: '仁王盾',
	type: 'equip',
	subtype: 'armor',
	equipSkill: 'renwang',
};

export const tengjia: CardDef = {
	name: 'tengjia',
	cn: '藤甲',
	type: 'equip',
	subtype: 'armor',
	equipSkill: 'tengjia',
};

export const baiyinshizi: CardDef = {
	name: 'baiyinshizi',
	cn: '白银狮子',
	type: 'equip',
	subtype: 'armor',
	equipSkill: 'baiyin',
};

// ─────────────────────────── 坐骑 ───────────────────────────

export const jueying: CardDef = { name: 'jueying', cn: '绝影', type: 'equip', subtype: 'horsePlus' };
export const dayuan: CardDef = { name: 'dayuan', cn: '大宛', type: 'equip', subtype: 'horsePlus' };
export const zixing: CardDef = { name: 'zixing', cn: '紫骍', type: 'equip', subtype: 'horsePlus' };
export const chitu: CardDef = { name: 'chitu', cn: '赤兔', type: 'equip', subtype: 'horseMinus' };
export const dilu: CardDef = { name: 'dilu', cn: '的卢', type: 'equip', subtype: 'horseMinus' };
export const zhuahuangfeidian: CardDef = {
	name: 'zhuahuangfeidian',
	cn: '爪黄飞电',
	type: 'equip',
	subtype: 'horseMinus',
};

export const EQUIP_CARDS: Record<string, CardDef> = {
	zhugeliannu,
	cixiongshuanggujian,
	qinggangjian,
	qinglongyanyuedao,
	zhangbashemao,
	guanshifu,
	fangtianhuaji,
	qilinong,
	hanbingjian,
	bagua,
	renwangdun,
	tengjia,
	baiyinshizi,
	jueying,
	dayuan,
	zixing,
	chitu,
	dilu,
	zhuahuangfeidian,
};
