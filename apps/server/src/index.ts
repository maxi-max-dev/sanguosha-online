/**
 * Worker 入口。职责很薄：发房间码、把 WebSocket 路由到对应的 Durable Object、
 * 其余交给静态资源。所有游戏逻辑都在 RoomDO 里。
 */

export { RoomDO } from './room.js';

interface Env {
	ROOM: DurableObjectNamespace;
	ASSETS: Fetcher;
}

/** 去掉了易混淆字符（0/O、1/I/L），四位，口头念得清楚 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function makeCode(): string {
	const buf = new Uint8Array(4);
	crypto.getRandomValues(buf);
	return Array.from(buf, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === '/api/room' && req.method === 'POST') {
			return json({ code: makeCode() });
		}

		// /api/ws?code=XXXX —— 房间码直接映射成 DO 实例名，
		// 于是"同一个房间码"天然对应"同一个 DO"，不需要额外的房间注册表。
		if (url.pathname === '/api/ws') {
			const code = (url.searchParams.get('code') ?? '').toUpperCase();
			if (!/^[A-Z0-9]{4,8}$/.test(code)) return new Response('bad room code', { status: 400 });
			const id = env.ROOM.idFromName(code);
			return env.ROOM.get(id).fetch(req);
		}

		return env.ASSETS.fetch(req);
	},
};
