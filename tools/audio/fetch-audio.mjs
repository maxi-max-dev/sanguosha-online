#!/usr/bin/env node
/**
 * 音效抓取管线：从开源项目 noname（GPL-3.0）按需拉取**通用**音效，
 * 原样拷贝（源文件本来就是 mp3，已经是 web 友好格式）到 apps/web/public/audio/，
 * 并生成 audio-manifest.json。结构照抄 tools/art/fetch-art.mjs。
 *
 * 用法：
 *   node tools/audio/fetch-audio.mjs            # 正常运行，已处理过的文件会跳过
 *   node tools/audio/fetch-audio.mjs --force    # 忽略缓存，强制重新拷贝全部音效
 *
 * 环境变量：
 *   NN_REPO_DIR / NN_REPO_URL   同 fetch-art.mjs，默认复用同一个本地 clone
 *   （两个脚本按需拉取各自的路径，共用一份 partial clone 不会互相冲突）。
 *
 * 范围（刻意收窄）：
 *   只抓"通用"音效 —— 出牌/受伤/回复/判定/阵亡/摸牌这类场景化提示音，
 *   不抓武将技能台词（audio/skill/，5000+ 文件）也不抓阵亡台词（audio/die/，
 *   1281 个按武将命名的语音），那些是"每将每技能好几条"的体量，
 *   多一个武将就多一批文件，跟音效这种一次性资源完全是两个数量级的维护成本。
 *
 * 幂等性：同 fetch-art.mjs —— blob 缓存在 .git/objects 里，输出文件存在就跳过。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const NN_REPO_URL = process.env.NN_REPO_URL || 'https://github.com/libccy/noname.git';
const NN_REPO_DIR = process.env.NN_REPO_DIR
	? path.resolve(process.env.NN_REPO_DIR)
	: path.join(PROJECT_ROOT, 'tools/.cache/noname');

const OUT_ROOT = path.join(PROJECT_ROOT, 'apps/web/public/audio');
const OUT_EFFECT_DIR = path.join(OUT_ROOT, 'effect');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'apps/web/src/audio-manifest.json');

const FORCE = process.argv.includes('--force');

// ─────────────────────────── 清单 ───────────────────────────

/**
 * 引擎日志 kind -> noname 音效文件。key 就是 audio-manifest.json 里的字段名，
 * 也是输出文件名（不含扩展名）。value 为 null 表示核实过 noname 没有贴切的通用音效
 * （不拿气氛不对的声音凑数，缺了就是缺了）。
 *
 * 出处核对方式：不是照着文件名猜的，是读了 noname 源码里 game.playAudio() 的调用点
 * （noname/library/element/content.js、noname/library/index.js 的 natureAudio 表）核实的：
 *   - recover/loseHp/judge/draw/discard 各自在源码里就是这个文件名，一一对应。
 *   - damage 的自然属性音效来自 lib.natureAudio.damage 表：
 *     fire -> damage_fire.mp3，thunder -> damage_thunder.mp3，无属性 -> damage.mp3。
 *   - card/default.mp3 是 noname"打出一张牌"音效链（SkillAudio）里没有该牌专属配音时
 *     的最终兜底音，本身不是任何一张牌的台词，只有这一个文件，拿来当"出牌/打出响应牌"
 *     的通用音效很合适。
 *   - die_male.mp3 / die_female.mp3 是 effect/ 下仅有的两个按性别分的阵亡音效，
 *     和 audio/die/<武将id>.mp3（每个武将专属的阵亡台词，1281 个文件）是两码事——
 *     前者是通用效果音，后者是台词，只抓前者。
 */
const AUDIO_MAP = {
	use: 'audio/card/default.mp3',
	respond: 'audio/card/default.mp3',
	damage: 'audio/effect/damage.mp3',
	damageFire: 'audio/effect/damage_fire.mp3',
	damageThunder: 'audio/effect/damage_thunder.mp3',
	recover: 'audio/effect/recover.mp3',
	judge: 'audio/effect/judge.mp3',
	dieMale: 'audio/effect/die_male.mp3',
	dieFemale: 'audio/effect/die_female.mp3',
	draw: 'audio/effect/draw.mp3',
	// 回合开始：noname 的 audio/effect/ 里没有对应的通用提示音（该目录下的其他
	// 音轨要么是伤害/回复这类具体判定结果，要么是彩蛋梗音效，没有一个"轮到你了"
	// 的中性提示音）。宁可缺这个场景，也不拿不搭的声音硬凑。
	turnStart: null,
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
 * 把 srcPath 落到 destPath。noname 的音效源本来就是 mp3（web 友好格式），
 * 绝大多数情况这里就是纯拷贝，不需要转码。只有遇到 mp3/ogg 之外的格式
 * （比如 noname 里偶尔出现的 .wav 梗音效）才会尝试用 ffmpeg 转成 mp3；
 * 没装 ffmpeg 就保留原格式拷贝过去，浏览器大概率还是能播，只是体积更大，
 * 报告里会注明不是理想格式。
 *
 * 返回实际写出的文件名（含扩展名）。
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
	ensureDir(OUT_EFFECT_DIR);
	ensureDir(path.dirname(MANIFEST_PATH));

	const report = { ok: [], skipped: [], noSource: [], fetchFailed: [], convertFailed: [] };
	const manifest = {};

	const needed = Object.entries(AUDIO_MAP).filter(([, rel]) => rel !== null);
	for (const [key, rel] of Object.entries(AUDIO_MAP)) {
		if (rel === null) {
			manifest[key] = null;
			report.noSource.push(key);
		}
	}

	const { ok: fetchedRel, failed: failedRel } = ensureFetched(needed.map(([, rel]) => rel));
	const fetchedSet = new Set(fetchedRel);
	for (const rel of failedRel) {
		const key = needed.find(([, r]) => r === rel)?.[0];
		manifest[key] = null;
		report.fetchFailed.push(key);
	}

	for (const [key, rel] of needed) {
		if (!fetchedSet.has(rel)) continue; // 已记录在 fetchFailed 里

		// 复用之前已经处理过的输出（不管扩展名是 mp3/ogg 还是别的），避免重复工作
		const already = !FORCE && readdirSync(OUT_EFFECT_DIR).find((f) => f.startsWith(`${key}.`));
		if (already) {
			manifest[key] = `/audio/effect/${already}`;
			report.skipped.push(key);
			continue;
		}

		try {
			const srcPath = path.join(NN_REPO_DIR, rel);
			const written = placeAudio(srcPath, OUT_EFFECT_DIR, key);
			manifest[key] = `/audio/effect/${written}`;
			report.ok.push(key);
		} catch (err) {
			manifest[key] = null;
			report.convertFailed.push(key);
			log(`[error] ${key} 处理失败：${err.message.split('\n')[0]}`);
		}
	}

	writeFileSync(MANIFEST_PATH, JSON.stringify({ effect: manifest }, null, 2) + '\n');

	// ─────────────────────────── 报告 ───────────────────────────
	const outSize = dirSizeBytes(OUT_ROOT);
	const total = Object.keys(AUDIO_MAP).length;

	log('\n========== 音效抓取报告 ==========');
	log(`共 ${total} 个场景`);
	log(`  新处理：${report.ok.length}${report.ok.length ? `（${report.ok.join(', ')}）` : ''}`);
	log(`  已跳过（文件已存在）：${report.skipped.length}`);
	if (report.noSource.length) log(`  noname 里没有贴切的通用音效：${report.noSource.join(', ')}`);
	if (report.fetchFailed.length) log(`  拉取失败：${report.fetchFailed.join(', ')}`);
	if (report.convertFailed.length) log(`  处理失败：${report.convertFailed.join(', ')}`);
	log(`\n输出目录：${OUT_ROOT}`);
	log(`输出体积：${formatBytes(outSize)}`);
	log(`清单文件：${MANIFEST_PATH}`);

	const totalMissing = report.noSource.length + report.fetchFailed.length + report.convertFailed.length;
	log(`\n缺音效合计：${totalMissing} 个（清单里对应值为 null，不是静默跳过）`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
