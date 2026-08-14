/**
 * 确定性随机数。整个引擎只允许通过这里取随机 —— 这是"同样的种子 + 同样的决策日志
 * 必然重放出同样一局"的前提，断线重连、DO 休眠恢复和 bug 复现全都建在这上面。
 */
export class Rng {
	private s: number;

	constructor(seed: number) {
		// 避免 0 态自锁
		this.s = (seed >>> 0) || 0x9e3779b9;
	}

	/** mulberry32：小、快、无依赖，跨 V8/Workers 结果一致 */
	next(): number {
		this.s = (this.s + 0x6d2b79f5) >>> 0;
		let t = this.s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** [0, n) 的整数 */
	int(n: number): number {
		return Math.floor(this.next() * n);
	}

	pick<T>(arr: readonly T[]): T {
		return arr[this.int(arr.length)];
	}

	/** 原地 Fisher-Yates */
	shuffle<T>(arr: T[]): T[] {
		for (let i = arr.length - 1; i > 0; i--) {
			const j = this.int(i + 1);
			[arr[i], arr[j]] = [arr[j], arr[i]];
		}
		return arr;
	}

	/** 快照/恢复内部状态，便于把 RNG 一起存进 DO */
	getState(): number {
		return this.s;
	}

	setState(s: number): void {
		this.s = s >>> 0;
	}
}
