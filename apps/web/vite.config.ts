import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			// 开发时把 API 打到本地 wrangler dev
			'/api': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: true },
		},
	},
	build: { outDir: 'dist', target: 'es2022' },
});
