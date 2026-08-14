/**
 * 技能总表。加武将/加装备只需要在这里多合并一张表。
 */

import type { SkillDef } from '../defs.js';
import { EQUIP_SKILLS } from './equip.js';
import { QUN_SKILLS } from './qun.js';
import { SHU_SKILLS } from './shu.js';
import { WEI_SKILLS } from './wei.js';
import { WU_SKILLS } from './wu.js';

export const ALL_SKILLS: Record<string, SkillDef> = {
	...WEI_SKILLS,
	...SHU_SKILLS,
	...WU_SKILLS,
	...QUN_SKILLS,
	...EQUIP_SKILLS,
};

export { WEI_SKILLS, SHU_SKILLS, WU_SKILLS, QUN_SKILLS, EQUIP_SKILLS };
