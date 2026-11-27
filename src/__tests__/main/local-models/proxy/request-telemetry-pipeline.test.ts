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
 *
 * It also pins what the row may claim about the provider's own counts: a class the
 * answer never named is stored as 0 and recorded as unreported, so no default
 * zero is read back as a measurement, and nothing of the answer itself is stored.
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

/** What the provider answers: its content type and body, as the wire carries them. */
interface Answer {
	type: string;
	body: string;
}

/** An answer that names no usage. */
const NO_USAGE: Answer = { type: 'application/json', body: '{}' };

/** A real HTTP server standing in for the provider. Records what reached it. */
async function startUpstream(answer: Answer = NO_USAGE): Promise<Upstream> {
	const seen: Upstream['seen'] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			seen.push({ url: req.url ?? '', body: Buffer.concat(chunks) });
			res.writeHead(200, { 'Content-Type': answer.type });
			res.end(answer.body);
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
		upstreams: { anthropic: upstream.origin, openai: upstream.origin },
		onRequest: (entry) => recordTokenProxyRequest(entry),
		modeFor: () => mode,
		compress,
	});
	const port = await proxy.listen(0);
	cleanups.push(() => proxy.close({ force: true }));
	return port;
}

const ANTHROPIC_PATH = '/agent/agent-1/anthropic/v1/messages';

/**
 * POST one request as agent-1 (an Anthropic message unless `path` says otherwise)
 * and wait for the provider's 200 to come back through the proxy, resolving with
 * the answer's bytes. The headers are a raw list, so `Host` is named here: Node
 * refuses a request without one before the proxy ever sees it.
 */
function post(
	port: number,
	body: Buffer,
	headers: string[] = [],
	path: string = ANTHROPIC_PATH
): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const req = http.request(
			{
				host: '127.0.0.1',
				port,
				method: 'POST',
				path,
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
				const answer: Buffer[] = [];
				res.on('data', (chunk: Buffer) => answer.push(chunk));
				res.on('error', reject);
				res.on('end', () =>
					res.statusCode === 200
						? resolve(Buffer.concat(answer))
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

		describe("the provider's own counts, and how its answer gave them", () => {
			const ANSWER_TEXT = 'PRIVATE-ANSWER-TEXT';
			const OPENAI_PATH = '/agent/agent-1/openai/v1/chat/completions';
			const OPENAI_REQUEST = Buffer.from(
				JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hello' }] })
			);

			/** The eight provider columns of a row: four counts, then how each was given. */
			const providerColumns = (
				tokens: [number | null, number | null, number | null, number | null],
				given: [string | null, string | null, string | null, string | null]
			) => ({
				provider_input_tokens: tokens[0],
				provider_cache_read_tokens: tokens[1],
				provider_cache_write_tokens: tokens[2],
				provider_output_tokens: tokens[3],
				provider_input_reportedness: given[0],
				provider_cache_read_reportedness: given[1],
				provider_cache_write_reportedness: given[2],
				provider_output_reportedness: given[3],
			});

			/** An Anthropic answer that names its output and no other class. */
			const OUTPUT_ONLY: Answer = {
				type: 'application/json',
				body: JSON.stringify({
					id: 'msg_1',
					type: 'message',
					content: [{ type: 'text', text: ANSWER_TEXT }],
					usage: { output_tokens: 7 },
				}),
			};

			/** An Anthropic event stream that names all four classes, a cache write of zero included. */
			const FULL_STREAM: Answer = {
				type: 'text/event-stream',
				body:
					'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":900,"output_tokens":1}}}\n\n' +
					`event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"${ANSWER_TEXT}"}}\n\n` +
					'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":55}}\n\n',
			};

			/** An OpenAI chat completion, with the cached part of its prompt named or left out. */
			const chatCompletion = (usage: Record<string, unknown>): Answer => ({
				type: 'application/json',
				body: JSON.stringify({
					id: 'chatcmpl_1',
					object: 'chat.completion',
					choices: [{ message: { content: ANSWER_TEXT } }],
					usage,
				}),
			});

			it.each(['passthrough', 'compress', 'compress-early'] as const)(
				'records an answer that named only its output with three unreported classes: %s',
				async (mode) => {
					const upstream = await startUpstream(OUTPUT_ONLY);
					const port = await startProxy(upstream, mode);

					const received = await post(port, Buffer.from(BODY));

					const [row] = await storedRows(1);
					// The default 0 of three classes is stored, and the row says it is not a measurement.
					expect(row).toMatchObject(
						providerColumns([0, 0, 0, 7], ['unreported', 'unreported', 'unreported', 'reported'])
					);
					// The client got the provider's answer untouched, and the row holds none of its text.
					expect(received.toString('utf-8')).toBe(OUTPUT_ONLY.body);
					expect(JSON.stringify(row)).not.toContain(ANSWER_TEXT);
				}
			);

			it('records an event stream that named all four classes, a cache write of zero included, as reported', async () => {
				const upstream = await startUpstream(FULL_STREAM);
				const port = await startProxy(upstream, 'compress');

				const received = await post(port, Buffer.from(BODY));

				const [row] = await storedRows(1);
				expect(row).toMatchObject(
					providerColumns([7, 900, 0, 55], ['reported', 'reported', 'reported', 'reported'])
				);
				expect(received.toString('utf-8')).toBe(FULL_STREAM.body);
				expect(JSON.stringify(row)).not.toContain(ANSWER_TEXT);
			});

			it('records an OpenAI answer with cache detail: input derived, cache write not applicable', async () => {
				const upstream = await startUpstream(
					chatCompletion({
						prompt_tokens: 20,
						prompt_tokens_details: { cached_tokens: 5 },
						completion_tokens: 3,
					})
				);
				const port = await startProxy(upstream, 'passthrough');

				await post(port, OPENAI_REQUEST, [], OPENAI_PATH);

				const [row] = await storedRows(1);
				expect(row).toMatchObject({
					route: 'openai',
					kind: 'openai-chat-completions',
					...providerColumns([15, 5, 0, 3], ['derived', 'reported', 'not-applicable', 'reported']),
				});
			});

			it('records an OpenAI prompt total with no cache detail as unreported, never as uncached input', async () => {
				const upstream = await startUpstream(
					chatCompletion({ prompt_tokens: 20, completion_tokens: 3 })
				);
				const port = await startProxy(upstream, 'passthrough');

				await post(port, OPENAI_REQUEST, [], OPENAI_PATH);

				const [row] = await storedRows(1);
				// The prompt total of 20 is not stored: it does not say how much of it was uncached.
				expect(row).toMatchObject(
					providerColumns([0, 0, 0, 3], ['unreported', 'unreported', 'not-applicable', 'reported'])
				);
			});

			it('leaves every provider column unknown when the answer named no usage', async () => {
				const upstream = await startUpstream(NO_USAGE);
				const port = await startProxy(upstream, 'compress');

				await post(port, Buffer.from(BODY));

				const [row] = await storedRows(1);
				expect(row).toMatchObject(
					providerColumns([null, null, null, null], [null, null, null, null])
				);
			});
		});
	}
);
