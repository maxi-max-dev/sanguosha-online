#!/usr/bin/env node
/**
 * 美术资源抓取管线：从开源项目 noname（GPL-3.0）按需拉取武将立绘和卡面，
 * 压缩转码成 webp，输出到 apps/web/public/art/，并生成 art-manifest.json。
 *
 * 用法：
 *   node tools/art/fetch-art.mjs            # 正常运行，已处理过的图会跳过
 *   node tools/art/fetch-art.mjs --force    # 忽略缓存，强制重新转码全部图
 *
 * 环境变量：
 *   NN_REPO_DIR   noname 仓库的本地路径（sparse/partial clone）。
 *                 不设置时默认用 tools/.cache/noname，首次运行会自动
 *                 `git clone --filter=blob:none --no-checkout` 出这个目录。
 *   NN_REPO_URL   noname 的 git 地址，默认 https://github.com/libccy/noname.git
 *
 * 工作原理：
 *   1. 确保本地有一个 noname 的 partial clone（只有 tree，没有 blob）。
 *   2. 对清单里每个需要的文件，用 `git checkout HEAD -- <path>` 按需把那
 *      一个 blob 拉下来（不会把 image/character 整个 2342 张都下载）。
 *   3. 用 sharp 把拉下来的图 resize + 转 webp；sharp 装不上时降级用系统自带
 *      的 sips（缩放）+ cwebp（转 webp，如果有的话）。
 *   4. 把结果写进 apps/web/public/art/，同时生成 art-manifest.json。
 *
 * 幂等性：
 *   - git checkout 拉过的 blob 会留在本地 .git/objects 里，重跑不再需要网络。
 *   - 已经生成的 webp 默认跳过转码（--force 可强制重来）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const NN_REPO_URL = process.env.NN_REPO_URL || 'https://github.com/libccy/noname.git';
const NN_REPO_DIR = process.env.NN_REPO_DIR
	? path.resolve(process.env.NN_REPO_DIR)
	: path.join(PROJECT_ROOT, 'tools/.cache/noname');

const OUT_ROOT = path.join(PROJECT_ROOT, 'apps/web/public/art');
const OUT_CHARACTER_DIR = path.join(OUT_ROOT, 'character');
const OUT_CARD_DIR = path.join(OUT_ROOT, 'card');
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'apps/web/src/art-manifest.json');

const CHARACTER_MAX_DIM = 512; // 立绘长边
const CARD_MAX_DIM = 256; // 卡面长边
const WEBP_QUALITY = 80;

const FORCE = process.argv.includes('--force');

// ─────────────────────────── 清单 ───────────────────────────

/** 标准包 25 将。id 就是 noname 的文件名（image/character/<id>.jpg）。 */
const CHARACTER_IDS = [
	'caocao', 'simayi', 'xiahoudun', 'zhangliao', 'xuzhu',
	'guojia', 'zhenji', 'liubei', 'guanyu', 'zhangfei',
	'zhugeliang', 'zhaoyun', 'machao', 'huangyueying', 'sunquan',
	'ganning', 'lvmeng', 'huanggai', 'zhouyu', 'daqiao',
	'luxun', 'sunshangxiang', 'huatuo', 'lvbu', 'diaochan',
];

/**
 * 我们引擎里的牌名 -> noname image/card/ 下的文件名（不含扩展名）。
 * 右边全部对着 `git ls-tree HEAD image/card/ --name-only` 的实际输出核实过，
 * 不是猜的。值为 null 表示核实过 noname 没有这张牌专属的图。
 *
 * 已知缺图：
 *   - huosha / leisha（火杀/雷杀）：noname 里这两种杀是运行时对【杀】的图做
 *     染色叠加特效，没有单独的图片文件，image/card/ 下找不到对应资源。
 */
const CARD_MAP = {
	sha: 'sha',
	huosha: null,
	leisha: null,
	shan: 'shan',
	tao: 'tao',
	jiu: 'jiu',
	juedou: 'juedou',
	guohechaiqiao: 'guohe',
	shunshouqianyang: 'shunshou',
	wuzhongshengyou: 'wuzhong',
	nanmanruqin: 'nanman',
	wanjianqifa: 'wanjian',
	taoyuanjieyi: 'taoyuan',
	wugufengdeng: 'wugu',
	jiedaosharen: 'jiedao',
	wuxiekeji: 'wuxie',
	tiesuolianhuan: 'tiesuo',
	huogong: 'huogong',
	lebusishu: 'lebu',
	shandian: 'shandian',
	bingliangcunduan: 'bingliang',
	zhugeliannu: 'zhuge',
	cixiongshuanggujian: 'cixiong',
	qinggangjian: 'qinggang',
	qinglongyanyuedao: 'qinglong',
	zhangbashemao: 'zhangba',
	guanshifu: 'guanshi',
	fangtianhuaji: 'fangtian',
	qilinong: 'qilin', // 麒麟弓
	hanbingjian: 'hanbing',
	bagua: 'bagua',
	renwangdun: 'renwang',
	tengjia: 'tengjia',
	baiyinshizi: 'baiyin',
	jueying: 'jueying',
	dayuan: 'dawan', // noname 里读 wǎn 不是 yuān，文件名是 dawan
	zixing: 'zixin', // noname 自己的文件名就没带 g，不是我们打错
	chitu: 'chitu',
	dilu: 'dilu',
	zhuahuangfeidian: 'zhuahuang',
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
 * `git checkout HEAD -- <path>` 按需拉取。已经在本地磁盘上的文件直接跳过
 * （包括之前跑过的、以及本来就在 partial clone 里的）。
 *
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
		// 批量失败时逐个重试，定位到底是哪个文件有问题
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

let sharpMod = null;
try {
	sharpMod = (await import('sharp')).default;
	log('[codec] 使用 sharp 转码');
} catch {
	log('[codec] sharp 不可用，降级到 sips + cwebp');
}

const hasCwebp = sharpMod ? false : commandExists('cwebp');
if (!sharpMod && !hasCwebp) {
	log('[codec] 警告：既没有 sharp 也没有 cwebp，只能用 sips 缩放并保留原格式（不是 webp）');
}

/**
 * 把 srcPath 缩放（长边 <= maxDim）压缩后写到 destPath（.webp）。
 * 优先 sharp；没有 sharp 时用 sips 缩放 + cwebp 转 webp；两者都没有就只用
 * sips 缩放，保留原始格式（返回的 path 会跟请求的不一样，调用方需要处理）。
 *
 * 返回实际写出的文件路径（正常情况下等于 destPath）。
 */
async function convertToWebp(srcPath, destPath, maxDim) {
	ensureDir(path.dirname(destPath));

	if (sharpMod) {
		await sharpMod(srcPath)
			.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
			.webp({ quality: WEBP_QUALITY })
			.toFile(destPath);
		return destPath;
	}

	// 降级路径：sips 负责缩放，cwebp（如果有）负责转 webp。
	// sips -Z 会把小图放大到目标尺寸（没有 sharp 的 withoutEnlargement 语义），
	// 这里手动量一下原图长边，取 min(maxDim, 原图长边) 避免放大。
	const ext = path.extname(srcPath) || '.png';
	const resizedTmp = destPath.replace(/\.webp$/, `.resized${ext}`);
	const srcDims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', srcPath], {
		stdio: 'pipe',
	}).toString();
	const srcLongEdge = Math.max(
		...[...srcDims.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1])),
	);
	const targetDim = Math.min(maxDim, srcLongEdge || maxDim);
	execFileSync('sips', ['-Z', String(targetDim), srcPath, '--out', resizedTmp], { stdio: 'pipe' });

	if (hasCwebp) {
		execFileSync('cwebp', ['-quiet', '-q', String(WEBP_QUALITY), resizedTmp, '-o', destPath], {
			stdio: 'pipe',
		});
		execFileSync('rm', [resizedTmp]);
		return destPath;
	}

	// 没有 cwebp：保留 sips 缩放后的原格式，不是 webp。
	const fallbackDest = destPath.replace(/\.webp$/, ext);
	execFileSync('mv', [resizedTmp, fallbackDest]);
	return fallbackDest;
}

// ─────────────────────────── 主流程 ───────────────────────────

async function processCategory({ label, ids, srcRelPath, outDir, maxDim, manifestPrefix }) {
	const report = { ok: [], skipped: [], noSource: [], fetchFailed: [], convertFailed: [] };
	const manifest = {};

	const needed = ids
		.map((id) => ({ id, rel: srcRelPath(id) }))
		.filter((x) => x.rel !== null);
	const noSourceIds = ids.filter((id) => srcRelPath(id) === null);
	for (const id of noSourceIds) {
		manifest[id] = null;
		report.noSource.push(id);
	}

	const { ok: fetchedRel, failed: failedRel } = ensureFetched(needed.map((x) => x.rel));
	const fetchedSet = new Set(fetchedRel);
	for (const rel of failedRel) {
		const id = needed.find((x) => x.rel === rel)?.id;
		manifest[id] = null;
		report.fetchFailed.push(id);
	}

	for (const { id, rel } of needed) {
		if (!fetchedSet.has(rel)) continue; // 已记录在 fetchFailed 里
		const srcPath = path.join(NN_REPO_DIR, rel);
		const destPath = path.join(outDir, `${id}.webp`);
		const publicPath = `/art/${manifestPrefix}/${id}.webp`;

		if (!FORCE && existsSync(destPath)) {
			manifest[id] = publicPath;
			report.skipped.push(id);
			continue;
		}

		try {
			const written = await convertToWebp(srcPath, destPath, maxDim);
			if (written === destPath) {
				manifest[id] = publicPath;
				report.ok.push(id);
			} else {
				// 降级到非 webp 格式的情况：清单里记实际路径，方便前端还能用上
				manifest[id] = `/art/${manifestPrefix}/${path.basename(written)}`;
				report.ok.push(id);
				log(`[warn] ${label} ${id} 没转成 webp（没有 cwebp），保留为 ${path.basename(written)}`);
			}
		} catch (err) {
			manifest[id] = null;
			report.convertFailed.push(id);
			log(`[error] ${label} ${id} 转码失败：${err.message.split('\n')[0]}`);
		}
	}

	return { manifest, report };
}

async function main() {
	log(`[init] 项目根目录：${PROJECT_ROOT}`);
	log(`[init] noname 仓库：${NN_REPO_DIR}`);
	ensureRepoCloned();
	ensureDir(OUT_CHARACTER_DIR);
	ensureDir(OUT_CARD_DIR);
	ensureDir(path.dirname(MANIFEST_PATH));

	const characterResult = await processCategory({
		label: '立绘',
		ids: CHARACTER_IDS,
		srcRelPath: (id) => `image/character/${id}.jpg`,
		outDir: OUT_CHARACTER_DIR,
		maxDim: CHARACTER_MAX_DIM,
		manifestPrefix: 'character',
	});

	const cardIds = Object.keys(CARD_MAP);
	const cardResult = await processCategory({
		label: '卡面',
		ids: cardIds,
		srcRelPath: (id) => (CARD_MAP[id] ? `image/card/${CARD_MAP[id]}.png` : null),
		outDir: OUT_CARD_DIR,
		maxDim: CARD_MAX_DIM,
		manifestPrefix: 'card',
	});

	const manifest = {
		character: characterResult.manifest,
		card: cardResult.manifest,
	};
	writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

	// ─────────────────────────── 报告 ───────────────────────────
	const outSize = dirSizeBytes(OUT_ROOT);

	function summarize(label, r, total) {
		log(`\n${label}（共 ${total} 个）`);
		log(`  新处理：${r.ok.length}`);
		log(`  已跳过（webp 已存在）：${r.skipped.length}`);
		if (r.noSource.length) log(`  无对应源图：${r.noSource.join(', ')}`);
		if (r.fetchFailed.length) log(`  拉取失败：${r.fetchFailed.join(', ')}`);
		if (r.convertFailed.length) log(`  转码失败：${r.convertFailed.join(', ')}`);
	}

	log('\n========== 抓取报告 ==========');
	summarize('立绘', characterResult.report, CHARACTER_IDS.length);
	summarize('卡面', cardResult.report, cardIds.length);
	log(`\n输出目录：${OUT_ROOT}`);
	log(`输出体积：${formatBytes(outSize)}`);
	log(`清单文件：${MANIFEST_PATH}`);

	const totalMissing =
		characterResult.report.noSource.length +
		characterResult.report.fetchFailed.length +
		characterResult.report.convertFailed.length +
		cardResult.report.noSource.length +
		cardResult.report.fetchFailed.length +
		cardResult.report.convertFailed.length;
	log(`\n缺图合计：${totalMissing} 张（清单里对应值为 null，不是静默跳过）`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
