/**
 * @vitest-environment node
 *
 * From a live request to a stored row, with nothing between stubbed but the
 * provider: a real HTTP request through the real token proxy and the real
 * compressor, then the same `onRequest` wiring the service uses
 * (`recordTokenProxyRequest`), the real row mapping, the real writer, and the
 * real `proxy_requests` table (built by the real migrations on SQLite).
 *
 * What it pins is what the stored row may claim. The mode in force is stated for
 * every request, so the two compress modes stay apart. The nine block counts are
 * stated only for a request the proxy read and shortened the way it sent, and are
 * unknown (NULL) for one it only counted, one it forwarded unread, and one whose
 * compressor failed. The body that reaches the provider is never changed by any of
 * it.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/token-proxy-pipeline-unused' } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));
vi.mock('../../../../main/local-models/task-router', () => ({ runLocalTask: vi.fn() }));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(async () => {}),
}));
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => undefined }),
}));

// The service reaches the database through this singleton. Here it hands the
// writer the in-memory database of the running test.
const stats = vi.hoisted(() => ({
	db: null as null | { isReady(): boolean; recordProxyRequest(request: unknown): string },
}));
vi.mock('../../../../main/stats/singleton', () => ({ getStatsDB: () => stats.db }));

import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';
import { createTokenProxyServer } from '../../../../main/local-models/proxy/server';
import type { TokenProxyServerOptions } from '../../../../main/local-models/proxy/server';
import { compressRequestBody } from '../../../../main/local-models/proxy/compress';
import { createCompressionCache } from '../../../../main/local-models/proxy/compression-cache';
import { recordTokenProxyRequest } from '../../../../main/local-models/proxy/request-stats';
import { runMigrations } from '../../../../main/stats/migrations';
import { clearProxyRequestsCache, recordProxyRequest } from '../../../../main/stats/proxy-requests';
import type { TokenProxyRequestMode } from '../../../../shared/local-models/token-proxy';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../../helpers/nodeSqlite';

/** A log the heuristics fold to two lines: well over the size a block must have to be shortened. */
const LOG = 'INFO worker heartbeat ok\n'.repeat(400);
const OTHER_LOG = 'WARN queue depth above limit\n'.repeat(300);

/**
 * Four tool results: a log the proxy shortens, a short answer it leaves under the
 * threshold, a failed result it sets aside, and the fresh result of the turn that
 * a delayed compress mode protects.
 */
const BODY = JSON.stringify({
	model: 'claude-opus-5-5',
	messages: [
		{ role: 'user', content: 'run the checks' },
		{ role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Bash', input: {} }] },
		{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: LOG }] },
		{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
		{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a short answer' }],
		},
		{ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] },
		{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 't2', content: OTHER_LOG, is_error: true }],
		},
		{ role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: {} }] },
		{
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: 't3', content: 'fresh result' }],
		},
	],
});

const NO_COUNTS = {
	blocks_protected: null,
	blocks_vetoed_failed: null,
	blocks_vetoed_recovery: null,
	blocks_vetoed_retrieval: null,
	blocks_candidates: null,
	blocks_below_threshold: null,
	blocks_kept: null,
	blocks_store_failed: null,
	blocks_model_failed: null,
};

const cleanups: Array<() => Promise<void>> = [];
let db: Database.Database;
let cacheDir: string;

beforeEach(async () => {
	clearProxyRequestsCache();
	const Shim = nodeSqliteBetterSqlite3Mock().default;
	db = new Shim(':memory:') as unknown as Database.Database;
	runMigrations(db);
	stats.db = {
		isReady: () => true,
		recordProxyRequest: (request) => recordProxyRequest(db, request as never),
	};
	cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-proxy-pipeline-'));
});

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
	await fs.rm(cacheDir, { recursive: true, force: true });
});

interface Upstream {
	origin: string;
	seen: Array<{ url: string; body: Buffer }>;
}

/** A real HTTP server standing in for the provider. Records what reached it. */
async function startUpstream(): Promise<Upstream> {
	const seen: Upstream['seen'] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			seen.push({ url: req.url ?? '', body: Buffer.concat(chunks) });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{}');
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			})
	);
	return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The real compressor, on a cache of its own and with the model tier off. */
function realCompressor(): NonNullable<TokenProxyServerOptions['compress']> {
	const cache = createCompressionCache({ dir: () => cacheDir });
	return (kind, text, { early }) =>
		compressRequestBody(kind, text, {
			early,
			cache,
			summarize: async () => ({ status: 'skipped' }),
		});
}

/**
 * The proxy as the service wires it: every finished request goes to
 * `recordTokenProxyRequest`, and `compress` is the real compressor unless the
 * test supplies another.
 */
async function startProxy(
	upstream: Upstream,
	mode: TokenProxyRequestMode,
	compress: NonNullable<TokenProxyServerOptions['compress']> = realCompressor()
): Promise<number> {
	const proxy = createTokenProxyServer({
		upstreams: { anthropic: upstream.origin },
		onRequest: (entry) => recordTokenProxyRequest(entry),
		modeFor: () => mode,
		compress,
	});
	const port = await proxy.listen(0);
	cleanups.push(() => proxy.close({ force: true }));
	return port;
}

/**
 * POST one Anthropic request as agent-1 and wait for the provider's 200 to come
 * back through the proxy. The headers are a raw list, so `Host` is named here:
 * Node refuses a request without one before the proxy ever sees it.
 */
function post(port: number, body: Buffer, headers: string[] = []): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const req = http.request(
			{
				host: '127.0.0.1',
				port,
				method: 'POST',
				path: '/agent/agent-1/anthropic/v1/messages',
				headers: [
					'Host',
					`127.0.0.1:${port}`,
					'Content-Type',
					'application/json',
					'Content-Length',
					String(body.length),
					...headers,
				],
				agent: false,
			},
			(res) => {
				res.on('data', () => {});
				res.on('error', reject);
				res.on('end', () =>
					res.statusCode === 200
						? resolve()
						: reject(new Error(`the proxy answered ${res.statusCode}`))
				);
			}
		);
		req.on('error', reject);
		req.end(body);
	});
}

/** The rows stored so far, oldest first, as plain objects. */
async function storedRows(count: number): Promise<Array<Record<string, unknown>>> {
	const rows = (): Array<Record<string, unknown>> =>
		(db.prepare('SELECT * FROM proxy_requests ORDER BY started_at, id').all() as object[]).map(
			(row) => ({ ...row })
		);
	// The row is written when the proxy sees the response close, a moment after the client does.
	await vi.waitFor(() => expect(rows()).toHaveLength(count));
	return rows();
}

describe.skipIf(!canLoadNodeSqlite())(
	'a live request, to the row it leaves in the stats table',
	() => {
		it('records an agent in passthrough as counted, with the mode and no block counts', async () => {
			const upstream = await startUpstream();
			const port = await startProxy(upstream, 'passthrough');
			const body = Buffer.from(BODY);

			await post(port, body);

			const [row] = await storedRows(1);
			expect(row).toMatchObject({
				agent_id: 'agent-1',
				mode: 'passthrough',
				effective_mode: 'passthrough',
				original_tokens: null,
				skip_reason: null,
				blocks_compressed: 0,
				...NO_COUNTS,
			});
			expect(upstream.seen[0].body.equals(body)).toBe(true);
		});

		it('records the delayed compress mode with what it protected, set aside, left alone and shortened', async () => {
			const upstream = await startUpstream();
			const port = await startProxy(upstream, 'compress');

			await post(port, Buffer.from(BODY));

			const [row] = await storedRows(1);
			expect(row).toMatchObject({
				mode: 'compress',
				effective_mode: 'compress',
				skip_reason: null,
				blocks_compressed: 1,
				cache_hits: 0,
				// The fresh result is protected; the failed one is set aside before any lookup.
				blocks_protected: 1,
				blocks_vetoed_failed: 1,
				blocks_vetoed_recovery: 0,
				blocks_vetoed_retrieval: 0,
				// The log is shortened, the short answer is under the threshold.
				blocks_candidates: 2,
				blocks_below_threshold: 1,
				blocks_kept: 0,
				blocks_store_failed: 0,
				blocks_model_failed: 0,
			});
			expect(row.sent_tokens as number).toBeLessThan(row.original_tokens as number);
			// What the provider received is what the row's counts describe.
			expect(upstream.seen[0].body.length).toBeLessThan(Buffer.byteLength(BODY));
			expect(upstream.seen[0].body.toString()).toContain('maestro-compressed');
		});

		it('records the early compress mode apart from the delayed one: nothing is protected', async () => {
			const upstream = await startUpstream();
			const port = await startProxy(upstream, 'compress-early');

			await post(port, Buffer.from(BODY));

			const [row] = await storedRows(1);
			// The table stores the two compress modes alike, and effective_mode keeps them apart.
			expect(row).toMatchObject({
				mode: 'compress',
				effective_mode: 'compress-early',
				blocks_compressed: 1,
				blocks_protected: 0,
				blocks_vetoed_failed: 1,
				// The fresh result is a candidate now, and as short as the other answer.
				blocks_candidates: 3,
				blocks_below_threshold: 2,
				blocks_kept: 0,
			});
		});

		it('records a verdict taken from the cache as a cache hit, with the counts unchanged', async () => {
			const upstream = await startUpstream();
			const port = await startProxy(upstream, 'compress');

			await post(port, Buffer.from(BODY));
			const [first] = await storedRows(1);
			await post(port, Buffer.from(BODY));

			// Two requests can start in the same millisecond, so the second is found by its id.
			const second = (await storedRows(2)).find((row) => row.id !== first.id)!;
			expect(first.cache_hits).toBe(0);
			expect(second).toMatchObject({
				cache_hits: 1,
				blocks_compressed: 1,
				blocks_protected: 1,
				blocks_candidates: 2,
			});
		});

		describe.each(['compress', 'compress-early'] as const)(
			'a %s request the proxy forwarded as it arrived',
			(mode) => {
				const skipped = (reason: string, effective: string) =>
					expect.objectContaining({
						mode: 'compress',
						effective_mode: effective,
						skip_reason: reason,
						original_tokens: null,
						blocks_compressed: 0,
						...NO_COUNTS,
					});

				it('is recorded with its mode and no counts when it used an encoding the proxy cannot read', async () => {
					const upstream = await startUpstream();
					const port = await startProxy(upstream, mode);
					const body = randomBytes(256);

					await post(port, body, ['Content-Encoding', 'snappy']);

					expect((await storedRows(1))[0]).toEqual(skipped('encoding', mode));
					expect(upstream.seen[0].body.equals(body)).toBe(true);
				});

				it('is recorded with its mode and no counts when its body is not text', async () => {
					const upstream = await startUpstream();
					const port = await startProxy(upstream, mode);
					const body = Buffer.from([0xff, 0xfe, 0x00, 0xc3]);

					await post(port, body);

					expect((await storedRows(1))[0]).toEqual(skipped('not-text', mode));
					expect(upstream.seen[0].body.equals(body)).toBe(true);
				});

				it('is recorded with its mode and no counts when the compressor failed', async () => {
					const upstream = await startUpstream();
					const port = await startProxy(upstream, mode, async () => {
						throw new Error('compressor fault');
					});
					const body = Buffer.from(BODY);

					await post(port, body);

					expect((await storedRows(1))[0]).toEqual(skipped('failed', mode));
					expect(upstream.seen[0].body.equals(body)).toBe(true);
				});
			}
		);

		it('credits no compression to a request that failed after the compressor had returned', async () => {
			const upstream = await startUpstream();
			const real = realCompressor();
			// The real compressor shortens the log, and then its result cannot be turned into bytes.
			const port = await startProxy(upstream, 'compress', async (kind, text, options) => ({
				...(await real(kind, text, options)),
				body: 42 as unknown as string,
			}));
			const body = Buffer.from(BODY);

			await post(port, body);

			const [row] = await storedRows(1);
			expect(row).toMatchObject({
				mode: 'compress',
				effective_mode: 'compress',
				skip_reason: 'failed',
				blocks_compressed: 0,
				cache_hits: 0,
				compressor_counts: null,
				new_blocks: null,
				...NO_COUNTS,
			});
			// Nothing was removed from the request: the same estimate before and after.
			expect(row.original_tokens).not.toBeNull();
			expect(row.sent_tokens).toBe(row.original_tokens);
			expect(upstream.seen[0].body.equals(body)).toBe(true);
		});

		it('never lets a failed stats write reach the client or the provider', async () => {
			const upstream = await startUpstream();
			const port = await startProxy(upstream, 'compress');
			const attempted = vi.fn((): string => {
				throw new Error('disk full');
			});
			stats.db = { isReady: () => true, recordProxyRequest: attempted };

			await post(port, Buffer.from(BODY));

			// The write was attempted and failed after the response; the request itself completed
			// and was forwarded whole (post() resolves only on the provider's 200).
			await vi.waitFor(() => expect(attempted).toHaveBeenCalledTimes(1));
			expect(upstream.seen).toHaveLength(1);
			expect(db.prepare('SELECT COUNT(*) AS n FROM proxy_requests').get()).toEqual({ n: 0 });
		});
	}
);
