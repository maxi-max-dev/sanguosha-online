/**
 * 音效播放模块。
 *
 * 用 WebAudio（AudioContext + AudioBuffer）而不是 <audio> 元素：
 * 预先把文件解码成 AudioBuffer，之后每次 play() 都是同步起播，没有网络/解码延迟，
 * 满足"第一次触发不能有延迟"的要求；也只需要解锁一个 AudioContext，
 * 不用像多个 <audio> 元素那样在用户手势里逐个 play()+pause() 解锁（iOS Safari 的老坑）。
 */

import { create } from 'zustand';
import manifest from './audio-manifest.json';

type Manifest = { effect: Record<string, string | null> };
const m = manifest as Manifest;

export type SoundKey = keyof Manifest['effect'];

const MUTE_KEY = 'sgs.muted';
/** 同一个音效在这个窗口内只响一次，避免同一帧好几条战报叠成刺耳的噪音 */
const THROTTLE_MS = 120;

interface SoundStore {
	muted: boolean;
	toggle(): void;
}

/** 静音状态用 zustand 暴露成 hook，静音按钮和其他想读这个状态的地方都能订阅 */
export const useSound = create<SoundStore>((set, get) => ({
	// localStorage 里没存过就是默认开启（未静音）
	muted: localStorage.getItem(MUTE_KEY) === '1',
	toggle() {
		const muted = !get().muted;
		localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
		set({ muted });
	},
}));

let ctx: AudioContext | undefined;
function getCtx(): AudioContext {
	if (!ctx) {
		// Safari 早期版本没有裸 AudioContext，兜底一下前缀版本
		const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		ctx = new Ctor();
	}
	return ctx;
}

const buffers = new Map<string, AudioBuffer>();
const lastPlayedAt = new Map<string, number>();

/**
 * 预加载 manifest 里所有音效。调用方在 App 挂载时调一次即可 —— 越早调用，
 * 到真正进桌开始出牌时就越不可能出现"还没解码完"的情况。
 * 用 Map 天然去重，重复调用是幂等的。
 */
export function preloadSounds(): void {
	const c = getCtx();
	for (const [key, url] of Object.entries(m.effect)) {
		if (!url || buffers.has(key)) continue;
		fetch(url)
			.then((r) => r.arrayBuffer())
			.then((buf) => c.decodeAudioData(buf))
			.then((decoded) => {
				buffers.set(key, decoded);
			})
			.catch(() => {
				// 音效本来就是锦上添花的表现层，一个文件加载失败不该影响游戏本身，静默跳过
			});
	}
}

let unlocked = false;
/** 浏览器自动播放策略：AudioContext 建出来默认是 suspended，必须在真实用户手势的回调里 resume 一次 */
function unlock(): void {
	if (unlocked) return;
	unlocked = true;
	void getCtx().resume();
}

if (typeof window !== 'undefined') {
	const onFirstGesture = () => unlock();
	window.addEventListener('pointerdown', onFirstGesture, { once: true, capture: true });
	window.addEventListener('keydown', onFirstGesture, { once: true, capture: true });
}

/** 播放一个音效；静音、没解锁、没这个音效、还没解码完，都是直接跳过而不是报错 */
export function play(key: SoundKey): void {
	if (useSound.getState().muted) return;
	if (!unlocked) return; // 用户还没交互过，播了浏览器也会拦截，不如不播

	const now = performance.now();
	const last = lastPlayedAt.get(key) ?? -Infinity;
	if (now - last < THROTTLE_MS) return;
	lastPlayedAt.set(key, now);

	const buf = buffers.get(key);
	if (!buf) return;
	const c = getCtx();
	const src = c.createBufferSource();
	src.buffer = buf;
	src.connect(c.destination);
	src.start(0);
}
