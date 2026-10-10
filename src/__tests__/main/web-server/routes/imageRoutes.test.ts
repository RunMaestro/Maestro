/**
 * Tests for ImageRoutes
 *
 * The web-desktop browser bundle cannot resolve the `maestro-image://` scheme
 * the Electron app loads persisted conversation images from, so the web server
 * serves the same store files over a token-scoped HTTP route. The basename
 * guard is the important part: the route must never read outside the store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImageRoutes } from '../../../../main/web-server/routes/imageRoutes';
import {
	configureImageStore,
	getImageDir,
	__resetImageStoreCacheForTests,
} from '../../../../main/storage/session-image-store';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const TOKEN = 'security-token-abc';
const ROUTE = `/${TOKEN}/api/images/:name`;
const SHA = 'c'.repeat(64);

function createMockFastify() {
	const routes = new Map<string, Function>();
	return {
		get: vi.fn((routePath: string, handler: Function) => {
			routes.set(`GET:${routePath}`, handler);
		}),
		getHandler: (routePath: string) => routes.get(`GET:${routePath}`),
		routes,
	};
}

function createMockReply() {
	const state: { code?: number; type?: string; headers?: Record<string, string>; body?: unknown } =
		{};
	const reply: any = {
		code: vi.fn((value: number) => {
			state.code = value;
			return reply;
		}),
		type: vi.fn((value: string) => {
			state.type = value;
			return reply;
		}),
		headers: vi.fn((value: Record<string, string>) => {
			state.headers = value;
			return reply;
		}),
		send: vi.fn((value: unknown) => {
			state.body = value;
			return reply;
		}),
		state,
	};
	return reply;
}

describe('ImageRoutes', () => {
	let tmpDir: string;
	let mockFastify: ReturnType<typeof createMockFastify>;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-image-routes-'));
		configureImageStore(tmpDir);
		mockFastify = createMockFastify();
		new ImageRoutes(TOKEN).registerRoutes(mockFastify as any);
	});

	afterEach(() => {
		__resetImageStoreCacheForTests();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('registers the image route under the api base behind the security token', () => {
		expect(mockFastify.getHandler(ROUTE)).toBeDefined();
	});

	it('serves a stored image with its media type and immutable private caching', async () => {
		const bytes = Buffer.from('not-really-a-png');
		fs.writeFileSync(path.join(getImageDir(), `${SHA}.png`), bytes);

		const reply = createMockReply();
		await mockFastify.getHandler(ROUTE)!({ params: { name: `${SHA}.png` } }, reply);

		expect(reply.state.code).toBeUndefined();
		expect(Buffer.isBuffer(reply.state.body)).toBe(true);
		expect((reply.state.body as Buffer).equals(bytes)).toBe(true);
		expect(reply.state.headers?.['content-type']).toBe('image/png');
		expect(reply.state.headers?.['cache-control']).toBe('private, max-age=31536000, immutable');
		expect(reply.state.headers?.['x-content-type-options']).toBe('nosniff');
	});

	it('uses the real media type for a jpg (never image/jpg)', async () => {
		fs.writeFileSync(path.join(getImageDir(), `${SHA}.jpg`), Buffer.from('jpg-bytes'));
		const reply = createMockReply();
		await mockFastify.getHandler(ROUTE)!({ params: { name: `${SHA}.jpg` } }, reply);
		expect(reply.state.headers?.['content-type']).toBe('image/jpeg');
	});

	it('rejects a basename the store would never have written', async () => {
		for (const name of ['../../etc/passwd', `${SHA}.exe`, 'A'.repeat(64) + '.png', '', undefined]) {
			const reply = createMockReply();
			await mockFastify.getHandler(ROUTE)!({ params: { name } }, reply);
			expect(reply.state.code).toBe(400);
		}
	});

	it('404s a well-formed basename that is not on disk', async () => {
		const reply = createMockReply();
		await mockFastify.getHandler(ROUTE)!({ params: { name: `${'d'.repeat(64)}.png` } }, reply);
		expect(reply.state.code).toBe(404);
	});
});
