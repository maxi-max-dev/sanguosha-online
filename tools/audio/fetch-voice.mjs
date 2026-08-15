#!/usr/bin/env node
/**
 * 武将技能台词抓取管线：从开源项目 noname（GPL-3.0）按需拉取标准包 40 个技能的
 * 发动语音，原样拷贝到 apps/web/public/audio/voice/，并写入 audio-manifest.json
 * 的 voice 字段。结构照抄 tools/audio/fetch-audio.mjs，多了一层：一个技能可能有
 * 多条台词，都要抓下来，交给前端随机挑一条播（而不是只固定一条）。
 *
 * 用法：
 *   node tools/audio/fetch-voice.mjs            # 正常运行，已处理过的文件会跳过
 *   node tools/audio/fetch-voice.mjs --force    # 忽略缓存，强制重新拷贝全部台词
 *
 * 环境变量：
 *   NN_REPO_DIR / NN_REPO_URL   同 fetch-audio.mjs，默认复用同一个本地 clone
 *   （按需拉取各自的路径，共用一份 partial clone 不会互相冲突）。
 *
 * 范围（刻意收窄，呼应 fetch-audio.mjs 头部注释里"音效"和"台词"是两个数量级的判断，
 * 但现在台词这块单独评估过了——标准包只有 25 将 40 个技能，不是几千文件，值得补上）：
 *   只抓 packages/engine/src/generals.ts 里标准包 25 将、40 个技能"发动时"的台词
 *   （audio/skill/ 下的文件）。不抓阵亡台词（audio/die/）、胜利/选将台词——
 *   量大且收益递减，产品需求里明确排除。
 *
 * 台词文件名不是照命名规律猜的，是读 noname 源码 character/standard/skill.js
 * 里每个技能定义的 `audio` 字段核实的：
 *   - 绝大多数技能声明 `audio: 2`，源文件就是 `<技能id>1.mp3` / `<技能id>2.mp3`。
 *   - jijiang（激将）、kongcheng（空城）本身是"外壳"技能，真正触发台词的是各自的
 *     子技能 jijiang1 / kongcheng1（skill.js 里 `audio: 'jijiang1'` /
 *     `audio: 'kongcheng1'`），所以源文件名其实是 jijiang11/jijiang12、
 *     kongcheng11/kongcheng12（子技能 id + 台词序号拼接）。
 *   - longdan（龙胆）显式声明 `audio: 'longdan_sha'`，源文件名是
 *     longdan_sha1.mp3 / longdan_sha2.mp3。
 *   - mashu（马术）、qicai（奇才）在源码里是纯 `mod` 技能（只改距离/使用范围的
 *     计算结果），没有 trigger 也没有 audio 字段——它们从不会有"发动"这个可播报
 *     的时刻，官方本来就没配台词，这是核实过的事实而不是抓取失败。
 *
 * 幂等性：同 fetch-audio.mjs —— blob 缓存在 .git/objects 里，输出文件存在就跳过。
 */

import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const NN_REPO_URL = process.env.NN_REPO_URL || 'https://github.com/libccy/noname.git';
const NN_REPO_DIR = process.env.NN_REPO_DIR
	? path.resolve(process.env.NN_REPO_DIR)
	: path.join(PROJECT_ROOT, 'tools/.cache/noname');

const OUT_ROOT = path.join(PROJECT_ROOT, 'apps/web/public/audio');
const OUT_VOICE_DIR = path.join(OUT_ROOT, 'voice');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'apps/web/src/audio-manifest.json');

const FORCE = process.argv.includes('--force');
// 硬性约束：40 个技能台词加起来不能超过 5MB，超了就每个技能只留第一条台词
const SIZE_BUDGET_BYTES = 5 * 1024 * 1024;

// ─────────────────────────── 清单 ───────────────────────────

/**
 * 技能 id -> noname audio/skill/ 下的台词文件 key 数组（不含扩展名），数组顺序
 * 就是"台词1"/"台词2"。value 为 null 表示核实过源码里这个技能本来就没有台词
 * （原因见文件头说明）。
 *
 * 必须和 packages/engine/src/generals.ts 里 25 将的 skills 数组保持一致——这里
 * 是纯 id 列表，不 import 引擎包，照抄 tools/art/fetch-art.mjs 手动维护 id 表的
 * 做法（tools/ 下的脚本一贯不依赖 TS 包，省得再引入构建步骤）。
 */
const SKILL_VOICE_MAP = {
	// ── 魏 ──
	jianxiong: ['jianxiong1', 'jianxiong2'],
	hujia: ['hujia1', 'hujia2'],
	fankui: ['fankui1', 'fankui2'],
	guicai: ['guicai1', 'guicai2'],
	ganglie: ['ganglie1', 'ganglie2'],
	tuxi: ['tuxi1', 'tuxi2'],
	luoyi: ['luoyi1', 'luoyi2'],
	tiandu: ['tiandu1', 'tiandu2'],
	yiji: ['yiji1', 'yiji2'],
	luoshen: ['luoshen1', 'luoshen2'],
	qingguo: ['qingguo1', 'qingguo2'],

	// ── 蜀 ──
	rende: ['rende1', 'rende2'],
	jijiang: ['jijiang11', 'jijiang12'],
	wusheng: ['wusheng1', 'wusheng2'],
	paoxiao: ['paoxiao1', 'paoxiao2'],
	guanxing: ['guanxing1', 'guanxing2'],
	kongcheng: ['kongcheng11', 'kongcheng12'],
	longdan: ['longdan_sha1', 'longdan_sha2'],
	mashu: null,
	tieji: ['tieji1', 'tieji2'],
	jizhi: ['jizhi1', 'jizhi2'],
	qicai: null,

	// ── 吴 ──
	zhiheng: ['zhiheng1', 'zhiheng2'],
	jiuyuan: ['jiuyuan1', 'jiuyuan2'],
	qixi: ['qixi1', 'qixi2'],
	keji: ['keji1', 'keji2'],
	kurou: ['kurou1', 'kurou2'],
	yingzi: ['yingzi1', 'yingzi2'],
	fanjian: ['fanjian1', 'fanjian2'],
	guose: ['guose1', 'guose2'],
	liuli: ['liuli1', 'liuli2'],
	qianxun: ['qianxun1', 'qianxun2'],
	lianying: ['lianying1', 'lianying2'],
	xiaoji: ['xiaoji1', 'xiaoji2'],
	jieyin: ['jieyin1', 'jieyin2'],

	// ── 群 ──
	qingnang: ['qingnang1', 'qingnang2'],
	jijiu: ['jijiu1', 'jijiu2'],
	wushuang: ['wushuang1', 'wushuang2'],
	lijian: ['lijian1', 'lijian2'],
	biyue: ['biyue1', 'biyue2'],

	// ── 风包 / 火包 ──
	// 源文件名同样是读 character/shenhua/skill.js 的 audio 字段推出来、再逐个
	// `git ls-tree audio/skill` 核实存在的，不是按 id 猜的。三种情况：
	//   audio: 2        → <技能id>1 / <技能id>2
	//   audio: 'xxx'    → xxx1 / xxx2（技能 id 改过名，台词还挂在老名字下：
	//                     xinliegong→liegong、xinkuanggu→kuanggu、oldniepan→niepan、
	//                     retianxiang→tianxiang、qiangxix→qiangxi）
	//   audio: 'xxx1'   → xxx11 / xxx12（子技能 id + 序号拼接，神速就是这种）
	jushou: ['jushou1', 'jushou2'],
	xinshensu: ['shensu11', 'shensu12'],
	qiangxix: ['qiangxi1', 'qiangxi2'],
	quhu: ['quhu1', 'quhu2'],
	jieming: ['jieming1', 'jieming2'],
	xinliegong: ['liegong1', 'liegong2'],
	xinkuanggu: ['kuanggu1', 'kuanggu2'],
	qimou: ['qimou1', 'qimou2'],
	lianhuan: ['lianhuan1', 'lianhuan2'],
	oldniepan: ['niepan1', 'niepan2'],
	bazhen: ['bazhen1', 'bazhen2'],
	huoji: ['huoji1', 'huoji2'],
	kanpo: ['kanpo1', 'kanpo2'],
	retianxiang: ['tianxiang1', 'tianxiang2'],
	tianyi: ['tianyi1', 'tianyi2'],
	releiji: ['releiji1', 'releiji2'],
	guidao: ['guidao1', 'guidao2'],
	shuangxiong: ['shuangxiong1', 'shuangxiong2'],
	luanji: ['luanji1', 'luanji2'],
	xueyi: ['xueyi1', 'xueyi2'],
	jianchu: ['jianchu1', 'jianchu2'],
};

// ─────────────────────────── 小工具 ───────────────────────────

function log(msg) {
	console.log(msg);
}

function ensureDir(dir) {
	mkdirSync(dir, { recursive: true });
}

function commandExists(cmd) {
	try {
		execFileSync('which', [cmd], { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

function dirSizeBytes(dir) {
	if (!existsSync(dir)) return 0;
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		total += entry.isDirectory() ? dirSizeBytes(p) : statSync(p).size;
	}
	return total;
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ─────────────────────────── noname 仓库 ───────────────────────────

/** 确保本地有 noname 的 partial clone；没有就自动 clone 一个（只拉 tree，不拉 blob）。 */
function ensureRepoCloned() {
	if (existsSync(path.join(NN_REPO_DIR, '.git'))) {
		log(`[repo] 复用已有 clone：${NN_REPO_DIR}`);
		return;
	}
	log(`[repo] 本地没有 noname clone，执行 partial clone 到 ${NN_REPO_DIR} ...`);
	ensureDir(path.dirname(NN_REPO_DIR));
	execFileSync(
		'git',
		['clone', '--filter=blob:none', '--no-checkout', NN_REPO_URL, NN_REPO_DIR],
		{ stdio: 'inherit' },
	);
}

/**
 * 确保给定的相对路径（相对 repo 根）在本地工作区里存在，缺的就用
 * `git checkout HEAD -- <path>` 按需把那一个 blob 拉下来。
 * 返回 { ok: string[], failed: string[] }。
 */
function ensureFetched(relPaths) {
	const needed = relPaths.filter((p) => !existsSync(path.join(NN_REPO_DIR, p)));
	if (needed.length === 0) {
		return { ok: relPaths, failed: [] };
	}
	log(`[fetch] 需要从 noname 拉取 ${needed.length} 个文件（其余已在本地缓存）...`);
	try {
		execFileSync('git', ['checkout', 'HEAD', '--', ...needed], {
			cwd: NN_REPO_DIR,
			stdio: 'pipe',
		});
		return { ok: relPaths, failed: [] };
	} catch (batchErr) {
		log(`[fetch] 批量拉取失败，逐个重试以定位问题：${batchErr.message.split('\n')[0]}`);
		const failed = [];
		for (const p of needed) {
			try {
				execFileSync('git', ['checkout', 'HEAD', '--', p], { cwd: NN_REPO_DIR, stdio: 'pipe' });
			} catch {
				failed.push(p);
			}
		}
		return { ok: relPaths.filter((p) => !failed.includes(p)), failed };
	}
}

// ─────────────────────────── 转码 ───────────────────────────

const hasFfmpeg = commandExists('ffmpeg');

/**
 * 把 srcPath 落到 destDir/destName.<ext>。noname 的台词源本来就是 mp3，绝大多数
 * 情况这里是纯拷贝。只有遇到非 mp3/ogg 格式才尝试用 ffmpeg 转码，没装 ffmpeg
 * 就原样拷贝（体积可能偏大，但至少能播）。返回实际写出的文件名（含扩展名）。
 */
function placeAudio(srcPath, destDir, destName) {
	ensureDir(destDir);
	const ext = path.extname(srcPath).toLowerCase();

	if (ext === '.mp3' || ext === '.ogg') {
		const destPath = path.join(destDir, `${destName}${ext}`);
		copyFileSync(srcPath, destPath);
		return `${destName}${ext}`;
	}

	if (hasFfmpeg) {
		const destPath = path.join(destDir, `${destName}.mp3`);
		execFileSync('ffmpeg', ['-y', '-i', srcPath, '-codec:a', 'libmp3lame', '-q:a', '4', destPath], {
			stdio: 'pipe',
		});
		return `${destName}.mp3`;
	}

	log(`[warn] ${srcPath} 不是 mp3/ogg，且没装 ffmpeg，原样拷贝（体积可能偏大）`);
	const destPath = path.join(destDir, `${destName}${ext}`);
	copyFileSync(srcPath, destPath);
	return `${destName}${ext}`;
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
	log(`[init] 项目根目录：${PROJECT_ROOT}`);
	log(`[init] noname 仓库：${NN_REPO_DIR}`);
	log(`[init] ffmpeg：${hasFfmpeg ? '可用' : '不可用（非 mp3/ogg 源会原样拷贝）'}`);
	ensureRepoCloned();
	ensureDir(OUT_VOICE_DIR);
	ensureDir(path.dirname(MANIFEST_PATH));

	const report = {
		ok: [],
		skipped: [],
		noVoiceInSource: [],
		fetchFailed: [],
		convertFailed: [],
		trimmedForSize: false,
	};
	const voiceManifest = {};

	// 摊平成逐条台词的列表，统一走 ensureFetched 一次性批量拉取
	const lines = [];
	for (const [skillId, keys] of Object.entries(SKILL_VOICE_MAP)) {
		if (keys === null) {
			voiceManifest[skillId] = null;
			report.noVoiceInSource.push(skillId);
			continue;
		}
		keys.forEach((key, idx) => lines.push({ skillId, idx, rel: `audio/skill/${key}.mp3` }));
	}

	const { ok: fetchedRel, failed: failedRel } = ensureFetched(lines.map((l) => l.rel));
	const fetchedSet = new Set(fetchedRel);
	for (const rel of failedRel) {
		const l = lines.find((x) => x.rel === rel);
		if (l) report.fetchFailed.push(`${l.skillId}[${l.idx + 1}]`);
	}

	// 按技能分组落盘：一个技能里某一条台词拉取/转码失败，不影响同技能的其他条
	const bySkill = new Map();
	for (const l of lines) {
		if (!bySkill.has(l.skillId)) bySkill.set(l.skillId, []);
		bySkill.get(l.skillId).push(l);
	}

	for (const [skillId, skillLines] of bySkill) {
		const urls = [];
		for (const l of skillLines) {
			if (!fetchedSet.has(l.rel)) continue; // 已记录在 fetchFailed 里

			const destName = `${skillId}-${l.idx + 1}`;
			const already = !FORCE && readdirSync(OUT_VOICE_DIR).find((f) => f.startsWith(`${destName}.`));
			if (already) {
				urls.push(`/audio/voice/${already}`);
				report.skipped.push(`${skillId}[${l.idx + 1}]`);
				continue;
			}

			try {
				const srcPath = path.join(NN_REPO_DIR, l.rel);
				const written = placeAudio(srcPath, OUT_VOICE_DIR, destName);
				urls.push(`/audio/voice/${written}`);
				report.ok.push(`${skillId}[${l.idx + 1}]`);
			} catch (err) {
				report.convertFailed.push(`${skillId}[${l.idx + 1}]`);
				log(`[error] ${skillId}[${l.idx + 1}] 处理失败：${err.message.split('\n')[0]}`);
			}
		}
		voiceManifest[skillId] = urls.length ? urls : null;
	}

	// 体积预算：40 个技能的台词超过 5MB 就每个技能只留第一条，多余的文件删掉
	let outSize = dirSizeBytes(OUT_VOICE_DIR);
	if (outSize > SIZE_BUDGET_BYTES) {
		report.trimmedForSize = true;
		for (const [skillId, urls] of Object.entries(voiceManifest)) {
			if (!urls || urls.length <= 1) continue;
			for (const url of urls.slice(1)) {
				const p = path.join(PROJECT_ROOT, 'apps/web/public', url.replace(/^\//, ''));
				if (existsSync(p)) rmSync(p);
			}
			voiceManifest[skillId] = urls.slice(0, 1);
		}
		outSize = dirSizeBytes(OUT_VOICE_DIR);
	}

	// 合并写 manifest：voice 是这个脚本的地盘，effect 字段照抄已有文件（如果存在）
	// 原样保留，避免和 fetch-audio.mjs 谁跑在谁后面互相覆盖对方那部分字段
	const existing = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : {};
	writeFileSync(MANIFEST_PATH, JSON.stringify({ ...existing, voice: voiceManifest }, null, 2) + '\n');

	// ─────────────────────────── 报告 ───────────────────────────
	const totalSkills = Object.keys(SKILL_VOICE_MAP).length;
	const gotSkills = Object.values(voiceManifest).filter((v) => v !== null).length;
	const totalFiles = readdirSync(OUT_VOICE_DIR).length;

	log('\n========== 技能台词抓取报告 ==========');
	log(`共 ${totalSkills} 个技能，抓到台词的：${gotSkills} 个，完全没台词的：${totalSkills - gotSkills} 个`);
	if (report.noVoiceInSource.length) {
		log(`  源码里本来就没有台词（mod 技能，无发动时刻）：${report.noVoiceInSource.join(', ')}`);
	}
	if (report.fetchFailed.length) log(`  拉取失败：${report.fetchFailed.join(', ')}`);
	if (report.convertFailed.length) log(`  处理失败：${report.convertFailed.join(', ')}`);
	log(`  新处理：${report.ok.length} 条，已跳过（文件已存在）：${report.skipped.length} 条`);
	if (report.trimmedForSize) log(`  超出 5MB 预算，已把每个技能裁到只留第一条台词`);
	log(`\n输出目录：${OUT_VOICE_DIR}`);
	log(`输出文件数：${totalFiles} 个，总体积：${formatBytes(outSize)}`);
	log(`平均单个文件：${totalFiles ? formatBytes(outSize / totalFiles) : 'N/A'}`);
	log(`清单文件：${MANIFEST_PATH}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
