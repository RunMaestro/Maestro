// Source: src/__tests__/main/web-server/routes/imageRoutes.test.ts
// Source: src/__tests__/main/web-server/routes/mediaRoutes.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImageRoutes } from '../../../../main/web-server/routes/imageRoutes';
import { configureImageStore } from '../../../../main/storage/session-image-store';
import { getImageDir } from '../../../../main/storage/session-image-store';
import { __resetImageStoreCacheForTests } from '../../../../main/storage/session-image-store';
import { beforeAll } from 'vitest';
import { afterAll } from 'vitest';
import { mkdirSync } from 'fs';
import { mkdtempSync } from 'fs';
import { writeFileSync } from 'fs';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { MediaRoutes } from '../../../../main/web-server/routes/mediaRoutes';
import { MEDIA_PATH_PARAM_MAX_LENGTH } from '../../../../main/web-server/routes/mediaRoutes';
import { buildLocalMediaStreamUrl } from '../../../../main/media/media-stream';
import { buildMediaStreamHttpPath } from '../../../../shared/mediaTypes';
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
describeSourceSuite('imageRoutes', () => {
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
		const state: {
			code?: number;
			type?: string;
			headers?: Record<string, string>;
			body?: unknown;
		} = {};
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
			for (const name of [
				'../../etc/passwd',
				`${SHA}.exe`,
				'A'.repeat(64) + '.png',
				'',
				undefined,
			]) {
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
});
describeSourceSuite('mediaRoutes', () => {
	const SECURITY_TOKEN = 'master-token';
	const dir = mkdtempSync(join(tmpdir(), 'maestro-media-route-'));
	// A real absolute path is well over 50 bytes, so its hex form is over Fastify's
	// default 100-character param cap. The OS temp dir alone is not on every
	// platform (Linux: /tmp), so nest a long directory name to make the case hold
	// on every CI leg rather than only where the temp dir happens to be deep.
	const longDir = join(dir, 'a-directory-name-long-enough-to-push-the-hex-param-past-one-hundred');
	mkdirSync(longDir);
	const filePath = join(longDir, 'clip.mp4');
	writeFileSync(filePath, Buffer.from('0123456789'));
	const httpPath = buildMediaStreamHttpPath(SECURITY_TOKEN, buildLocalMediaStreamUrl(filePath))!;

	let server: FastifyInstance;

	beforeAll(async () => {
		// Same server option WebServer passes, so the test proves it is sufficient.
		server = Fastify({ routerOptions: { maxParamLength: MEDIA_PATH_PARAM_MAX_LENGTH } });
		new MediaRoutes(SECURITY_TOKEN).registerRoutes(server);
		await server.ready();
	});

	afterAll(async () => {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});

	describe('MediaRoutes', () => {
		it('matches a real file path, whose hex param is well over the default 100 chars', async () => {
			expect(httpPath.split('/').pop()!.length).toBeGreaterThan(100);
			const res = await server.inject({ method: 'GET', url: httpPath });
			expect(res.statusCode).toBe(200);
		});

		it("streams the whole file with the handler's own headers", async () => {
			const res = await server.inject({ method: 'GET', url: httpPath });
			expect(res.statusCode).toBe(200);
			expect(res.headers['content-type']).toBe('video/mp4');
			expect(res.headers['accept-ranges']).toBe('bytes');
			expect(res.headers['content-length']).toBe('10');
			expect(res.headers['cache-control']).toBe('no-store');
			expect(res.body).toBe('0123456789');
		});

		it('honors a Range header with a 206 and the requested slice', async () => {
			const res = await server.inject({
				method: 'GET',
				url: httpPath,
				headers: { range: 'bytes=2-4' },
			});
			expect(res.statusCode).toBe(206);
			expect(res.headers['content-range']).toBe('bytes 2-4/10');
			expect(res.headers['content-length']).toBe('3');
			expect(res.body).toBe('234');
		});

		it('refuses a URL minted with a stale media token', async () => {
			const stale = httpPath.replace(/\/media\/stream\/[^/]+\//, '/media/stream/not-this-boot/');
			const res = await server.inject({ method: 'GET', url: stale });
			expect(res.statusCode).toBe(400);
		});

		it('does not answer outside the security token prefix', async () => {
			const res = await server.inject({
				method: 'GET',
				url: httpPath.replace(SECURITY_TOKEN, 'nope'),
			});
			expect(res.statusCode).toBe(404);
		});
	});
});
