/**
 * Tests for MediaRoutes
 *
 * The web-desktop bundle cannot load `maestro-media://`, so the web server
 * exposes the same range-aware handler over HTTP. These drive the route
 * through a REAL Fastify instance with a real temp file, so status codes,
 * Range handling, the stale-token refusal, and route MATCHING are all the
 * production behavior. Matching is the one a mocked server cannot test: the
 * hex path param is over 100 characters for any real file, and Fastify's
 * default `maxParamLength` answered 404 before the handler ever ran.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
	MediaRoutes,
	MEDIA_PATH_PARAM_MAX_LENGTH,
} from '../../../../main/web-server/routes/mediaRoutes';
import { buildLocalMediaStreamUrl } from '../../../../main/media/media-stream';
import { buildMediaStreamHttpPath } from '../../../../shared/mediaTypes';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECURITY_TOKEN = 'master-token';
const dir = mkdtempSync(join(tmpdir(), 'maestro-media-route-'));
const filePath = join(dir, 'clip.mp4');
writeFileSync(filePath, Buffer.from('0123456789'));
const httpPath = buildMediaStreamHttpPath(SECURITY_TOKEN, buildLocalMediaStreamUrl(filePath))!;

let server: FastifyInstance;

beforeAll(async () => {
	// Same server option WebServer passes, so the test proves it is sufficient.
	server = Fastify({ maxParamLength: MEDIA_PATH_PARAM_MAX_LENGTH });
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
