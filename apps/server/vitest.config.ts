import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// 每个测试文件在 beforeAll 里起一个真实的本地 wrangler 实例（workerd 子进程），
		// 两个文件并行跑就是两个子进程抢 CPU——本来就不快的 DO 测试会更容易因为
		// 读秒/alarm 的真实时间窗口被挤占而抖动，所以让文件顺序跑，用时间换稳定。
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
