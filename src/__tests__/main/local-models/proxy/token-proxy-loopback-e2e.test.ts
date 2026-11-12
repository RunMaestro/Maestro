/**
 * @vitest-environment node
 *
 * The token proxy chain on loopback, from a client's request to what the model
 * can ask back and what the stats keep. Only the provider is a stand-in (a local
 * HTTP server). The product's own service, server, compressor, compression
 * cache, retrieve tool, bridge handlers and stats writer run for real, on a
 * temporary data directory and an in-memory SQLite database built by the real
 * migrations. No paid traffic, and nothing of the user's data is read.
 *
 * Four contracts are pinned together, because each is only worth what the
 * others leave intact:
 *
 *   - compression: only the tool result changes. Every other byte of the
 *     request reaches the provider as the client sent it.
 *   - the immutable cache: a repeated block is served from its stored verdict,
 *     byte for byte, with the stored record unchanged. A failed copy of the same
 *     text is set aside before the cache is read.
 *   - scoped retrieval: the model's tool returns the exact original of the hash
 *     in a marker, only to the agent the run proof names, only while retrieval is
 *     on, and what it returns is never shortened again.
 *   - accounting: one row per request with the mode in force and the counts, and
 *     the retrieve tool's reads counted apart from every other read.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import type Database from 'better-sqlite3';

const scratch = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
	app: { getPath: () => scratch.dir },
	safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(async () => {}),
}));
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: () => undefined }),
}));
// The model tier is off: this chain is the deterministic one.
vi.mock('../../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(async () => ({ status: 'off' })),
}));
// Plugins off: the bridge offers the core tool alone.
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
	getHeadlessAgentRunner: () => null,
}));

// The service reaches the database through this singleton. Here it hands the
// writer the in-memory database of the running test.
const stats = vi.hoisted(() => ({
	db: null as null | { isReady(): boolean; recordProxyRequest(request: unknown): string },
}));
vi.mock('../../../../main/stats/singleton', () => ({ getStatsDB: () => stats.db }));

import { parseCompressionMarker } from '../../../../main/local-models/proxy/compress';
import { TOKEN_PROXY_CACHE_DIRNAME } from '../../../../main/local-models/proxy/compression-cache';
import { createTokenProxyServer } from '../../../../main/local-models/proxy/server';
import {
	configureTokenProxy,
	ensureTokenProxyForGateway,
	ensureTokenProxyPort,
	getTokenProxyRecoveryObservations,
	registerTokenProxyRecoveryLaunch,
	resetTokenProxyForTests,
	TOKEN_PROXY_STATE_FILE,
	tokenProxyLaunchGatewayUrl,
} from '../../../../main/local-models/proxy/service';
import { pluginToolRunIdentity } from '../../../../main/plugins/plugin-tool-run-identity';
import { runMigrations } from '../../../../main/stats/migrations';
import { clearProxyRequestsCache, recordProxyRequest } from '../../../../main/stats/proxy-requests';
import {
	handlePluginsCallTool,
	handlePluginsListTools,
} from '../../../../main/web-server/handlers/messageHandlers/plugins';
import type {
	MessageHandlerContext,
	WebClient,
	WebClientMessage,
} from '../../../../main/web-server/handlers/messageHandlers/types';
import {
	defaultTokenProxyUpstreams,
	tokenProxyGatewayUrl,
} from '../../../../shared/local-models/token-proxy';
import {
	TOKEN_PROXY_RETRIEVE_TOOL_ID,
	TOKEN_PROXY_RETRIEVE_TOOL_NAME,
} from '../../../../shared/local-models/token-proxy-retrieve-tool';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../../helpers/nodeSqlite';

const AGENT_ID = 'agent-loopback';
const OTHER_AGENT_ID = 'agent-without-retrieval';

/**
 * A log of forty lines that differ, then four hundred repeats the heuristics
 * fold. The compression cache outlives a test, as it does in the app, and a
 * verdict is found by the text alone, so each test names its own log and starts
 * from a miss.
 */
function logOf(label: string) {
	const lines = [
		...Array.from(
			{ length: 40 },
			(_, index) =>
				`[step ${String(index + 1).padStart(2, '0')}] built ${label}/unit-${index + 1}.ts`
		),
		...Array.from({ length: 400 }, () => `INFO ${label} worker heartbeat ok`),
	];
	return {
		lines,
		text: `${lines.join('\n')}\n`,
		/** Lines `from` to `to` (1-based, inclusive), as the retrieve tool returns them. */
		range: (from: number, to: number): string =>
			lines
				.slice(from - 1, to)
				.map((line) => `${line}\n`)
				.join(''),
	};
}

/** What the provider answers: one message that names its usage. */
const PROVIDER_ANSWER = JSON.stringify({
	id: 'msg_loopback',
	type: 'message',
	role: 'assistant',
	model: 'claude-opus-5-5',
	content: [{ type: 'text', text: 'ok' }],
	stop_reason: 'end_turn',
	usage: {
		input_tokens: 120,
		output_tokens: 4,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
	},
});

interface ToolTurn {
	id: string;
	tool: string;
	input: Record<string, unknown>;
	result: string;
	isError?: boolean;
}

/** An Anthropic Messages request that carries these tool calls and their results. */
function messagesBody(turns: ToolTurn[]): string {
	const messages: unknown[] = [{ role: 'user', content: 'run the checks' }];
	for (const turn of turns) {
		messages.push({
			role: 'assistant',
			content: [{ type: 'tool_use', id: turn.id, name: turn.tool, input: turn.input }],
		});
		messages.push({
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: turn.id,
					content: turn.result,
					...(turn.isError ? { is_error: true } : {}),
				},
			],
		});
	}
	return JSON.stringify({
		model: 'claude-opus-5-5',
		max_tokens: 64,
		system: 'You are a build assistant.',
		messages,
	});
}

const readLog = (result: string, isError = false): ToolTurn => ({
	id: 'toolu_log',
	tool: 'Bash',
	input: { command: 'cat worker.log' },
	result,
	isError,
});

/** The text of the tool result that answers `toolUseId` in a request body. */
function toolResultOf(requestBody: string, toolUseId: string): string {
	const body = JSON.parse(requestBody) as {
		messages: Array<{ content: unknown }>;
	};
	for (const message of body.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<Record<string, unknown>>) {
			if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
				return String(block.content);
			}
		}
	}
	throw new Error(`no tool result answers ${toolUseId}`);
}

interface Upstream {
	origin: string;
	/** What reached the provider, in arrival order. */
	seen: Array<{ url: string; body: string }>;
}

const cleanups: Array<() => Promise<void> | void> = [];
let db: Database.Database;

/** A real HTTP server standing in for the provider. Records what reached it. */
async function startUpstream(): Promise<Upstream> {
	const seen: Upstream['seen'] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			seen.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(PROVIDER_ANSWER);
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

interface World {
	upstream: Upstream;
	/** The stored agent records the service reads on every request. */
	agents: Array<Record<string, unknown>>;
	/** The agent's base URL for this launch, bound to the retrieve tool. */
	launchUrl: string;
	/** Send one Messages request through the proxy; resolves with the provider's answer. */
	send(body: string): Promise<string>;
}

/**
 * The product's proxy service on loopback, with a stored agent that has
 * retrieval on and one that does not, and a launch of the first bound to the
 * retrieve tool the way `handle-spawn.ts` binds it.
 */
async function startWorld(): Promise<World> {
	const upstream = await startUpstream();
	const agents: World['agents'] = [
		{
			id: AGENT_ID,
			toolType: 'claude-code',
			tokenProxyMode: 'compress-early',
			tokenProxyRetrieval: true,
		},
		{
			id: OTHER_AGENT_ID,
			toolType: 'claude-code',
			tokenProxyMode: 'compress-early',
			tokenProxyRetrieval: false,
		},
	];
	configureTokenProxy({
		sessions: () => agents,
		dataDir: () => scratch.dir,
		createServer: (options) =>
			createTokenProxyServer({
				...options,
				upstreams: { ...defaultTokenProxyUpstreams(), anthropic: upstream.origin },
			}),
	});
	const gatewayUrl = tokenProxyGatewayUrl(await ensureTokenProxyPort(), 'anthropic');
	for (const agent of agents) agent.gatewayUrl = gatewayUrl;
	const agentUrl = await tokenProxyLaunchGatewayUrl(AGENT_ID, gatewayUrl);
	expect((await ensureTokenProxyForGateway(agentUrl!)).ok).toBe(true);
	const bound = await registerTokenProxyRecoveryLaunch(AGENT_ID, agentUrl!, {
		kind: 'mcp-retrieve-tool',
	});
	expect(bound).not.toBeNull();
	cleanups.push(() => bound!.release());
	return {
		upstream,
		agents,
		launchUrl: bound!.gatewayUrl,
		async send(body) {
			const response = await fetch(`${bound!.gatewayUrl}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
			});
			expect(response.status).toBe(200);
			return response.text();
		},
	};
}

/** The rows stored so far, oldest first. A row is written when the proxy sees the response close. */
async function storedRows(count: number): Promise<Array<Record<string, unknown>>> {
	const rows = (): Array<Record<string, unknown>> =>
		(db.prepare('SELECT * FROM proxy_requests ORDER BY started_at, rowid').all() as object[]).map(
			(row) => ({ ...row })
		);
	await vi.waitFor(() => expect(rows()).toHaveLength(count));
	return rows();
}

/** Every file in the compression cache, with a hash of its bytes. */
async function cacheContents(): Promise<Record<string, string>> {
	const root = path.join(scratch.dir, TOKEN_PROXY_CACHE_DIRNAME);
	const files: Record<string, string> = {};
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else
				files[path.relative(root, full)] = createHash('sha256')
					.update(await fs.readFile(full))
					.digest('hex');
		}
	};
	await walk(root);
	return files;
}

/** One message to the bridge handlers, as the MCP bridge sends it; resolves with the reply. */
function bridge(
	handle: typeof handlePluginsListTools,
	message: Record<string, unknown>
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const ctx = {
			send: (_client: WebClient, data: Record<string, unknown>) => resolve(data),
		} as unknown as MessageHandlerContext;
		handle(
			ctx,
			{ socket: {} } as unknown as WebClient,
			{
				requestId: 'loopback',
				...message,
			} as WebClientMessage
		).catch(reject);
	});
}

const listTools = (message: Record<string, unknown>) =>
	bridge(handlePluginsListTools, { type: 'plugins_list_tools', ...message });

const callRetrieve = (message: Record<string, unknown>) =>
	bridge(handlePluginsCallTool, {
		type: 'plugins_call_tool',
		toolId: TOKEN_PROXY_RETRIEVE_TOOL_ID,
		...message,
	});

/** A run proof for `agentId`, revoked when the test ends. */
function issueRunToken(agentId: string): string {
	const token = pluginToolRunIdentity.issue(agentId);
	cleanups.push(() => pluginToolRunIdentity.revoke(token));
	return token;
}

beforeAll(async () => {
	// One data directory for the file, as the app has one. The compression cache is a
	// process-wide singleton with a memory of its own, so a directory per test would
	// leave that memory answering for a directory that is gone.
	scratch.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-proxy-loopback-'));
	// Leaked from an agent shell, this would point the data dir at the user's real one.
	vi.stubEnv('MAESTRO_USER_DATA', scratch.dir);
});

afterAll(async () => {
	vi.unstubAllEnvs();
	await fs.rm(scratch.dir, { recursive: true, force: true });
});

beforeEach(() => {
	clearProxyRequestsCache();
	const Shim = nodeSqliteBetterSqlite3Mock().default;
	db = new Shim(':memory:') as unknown as Database.Database;
	runMigrations(db);
	stats.db = {
		isReady: () => true,
		recordProxyRequest: (request) => recordProxyRequest(db, request as never),
	};
});

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()!();
	await resetTokenProxyForTests();
	// The next test chooses its own port instead of reusing the one this test persisted.
	await fs.rm(path.join(scratch.dir, TOKEN_PROXY_STATE_FILE), { force: true });
});

describe.skipIf(!canLoadNodeSqlite())('the token proxy chain on loopback', () => {
	describe('compression and accounting', () => {
		it('shortens only the tool result, and the stored row says what was done', async () => {
			const world = await startWorld();
			const log = logOf('compression');
			const sent = messagesBody([readLog(log.text)]);

			const answer = await world.send(sent);

			// The provider's answer reaches the client as it came.
			expect(answer).toBe(PROVIDER_ANSWER);
			const [received] = world.upstream.seen;
			const shortened = toolResultOf(received.body, 'toolu_log');
			expect(parseCompressionMarker(shortened)).not.toBeNull();
			expect(shortened.length).toBeLessThan(log.text.length / 4);
			// Put the original back in place of the shortened text: nothing else differs.
			expect(received.body.split(JSON.stringify(shortened)).join(JSON.stringify(log.text))).toBe(
				sent
			);

			const [row] = await storedRows(1);
			expect(row).toMatchObject({
				agent_id: AGENT_ID,
				kind: 'anthropic-messages',
				mode: 'compress',
				effective_mode: 'compress-early',
				status: 200,
				blocks_compressed: 1,
				cache_hits: 0,
				blocks_candidates: 1,
				blocks_protected: 0,
				blocks_vetoed_failed: 0,
				blocks_vetoed_retrieval: 0,
				provider_input_tokens: 120,
				provider_output_tokens: 4,
			});
			expect(row.sent_tokens as number).toBeLessThan(row.original_tokens as number);
			expect(row.sent_bytes as number).toBeLessThan(row.request_bytes as number);
			expect(row.sent_bytes).toBe(Buffer.byteLength(received.body));
		});
	});

	describe('the immutable cache', () => {
		it('serves a repeated block unchanged, and sets a failed copy aside before the cache is read', async () => {
			const world = await startWorld();
			const log = logOf('cache');
			const sent = messagesBody([readLog(log.text)]);

			await world.send(sent);
			const stored = await cacheContents();
			expect(Object.keys(stored).length).toBeGreaterThan(0);

			await world.send(sent);
			const [first, second] = world.upstream.seen;
			// The same block gets the same bytes, and the stored records are not written again.
			expect(second.body).toBe(first.body);
			expect(await cacheContents()).toEqual(stored);

			// The same text as a failed result is never shortened, though its verdict is stored.
			const failed = messagesBody([readLog(log.text, true)]);
			await world.send(failed);
			expect(world.upstream.seen[2].body).toBe(failed);
			expect(await cacheContents()).toEqual(stored);

			const rows = await storedRows(3);
			expect(rows[0]).toMatchObject({ blocks_compressed: 1, cache_hits: 0 });
			expect(rows[1]).toMatchObject({ blocks_compressed: 1, cache_hits: 1 });
			expect(rows[2]).toMatchObject({
				blocks_compressed: 0,
				cache_hits: 0,
				blocks_vetoed_failed: 1,
				blocks_candidates: 0,
			});
		});
	});

	describe('scoped retrieval', () => {
		/** Send the log once and return the hash its marker names. */
		async function shortenedHash(world: World, log: ReturnType<typeof logOf>): Promise<string> {
			await world.send(messagesBody([readLog(log.text)]));
			const marker = parseCompressionMarker(toolResultOf(world.upstream.seen[0].body, 'toolu_log'));
			expect(marker).not.toBeNull();
			return marker!.hash;
		}

		it('gives the agent the run proof names the exact original, and counts each read as the tool', async () => {
			const world = await startWorld();
			const log = logOf('exact');
			const hash = await shortenedHash(world, log);
			const runToken = issueRunToken(AGENT_ID);

			const listed = await listTools({ runToken });
			expect(listed.tools).toEqual([
				expect.objectContaining({
					name: TOKEN_PROXY_RETRIEVE_TOOL_NAME,
					toolId: TOKEN_PROXY_RETRIEVE_TOOL_ID,
				}),
			]);
			expect(String(listed.instructions)).toContain(TOKEN_PROXY_RETRIEVE_TOOL_NAME);

			const head = await callRetrieve({ runToken, args: { hash, start_line: 1, end_line: 3 } });
			expect(head).toMatchObject({
				ok: true,
				result: `[original sha256=${hash} lines 1-3; more lines follow, call again with start_line=4]\n${log.range(1, 3)}`,
			});
			const total = log.lines.length;
			const tail = await callRetrieve({
				runToken,
				args: { hash, start_line: total - 2, end_line: total },
			});
			expect(tail).toMatchObject({
				ok: true,
				result: `[original sha256=${hash} lines ${total - 2}-${total}; this is the end of the original]\n${log.range(total - 2, total)}`,
			});

			// A hash nothing stored is a message to the model, and a read the tool made.
			const unknown = await callRetrieve({ runToken, args: { hash: 'a'.repeat(64) } });
			expect(unknown).toMatchObject({
				ok: false,
				toolError: expect.stringContaining('No compressed block'),
			});

			const { byCaller } = getTokenProxyRecoveryObservations();
			expect(byCaller.mcpRetrieveTool).toMatchObject({
				invocations: 3,
				rangedInvocations: 3,
				recoveredOriginals: 2,
				unavailableBlocks: 1,
			});
			expect(byCaller.mcpRetrieveTool.returnedOriginalBytes).toBe(
				Buffer.byteLength(log.range(1, 3)) + Buffer.byteLength(log.range(total - 2, total))
			);
			// Nothing else read an original.
			expect(byCaller.otherReads.invocations).toBe(0);
		});

		it('offers and answers nobody else', async () => {
			const world = await startWorld();
			const hash = await shortenedHash(world, logOf('scope'));
			const args = { hash, start_line: 1, end_line: 3 };

			// An agent with retrieval off, holding a valid proof of its own.
			const otherToken = issueRunToken(OTHER_AGENT_ID);
			expect((await listTools({ runToken: otherToken })).tools).toEqual([]);
			expect(await callRetrieve({ runToken: otherToken, args })).toMatchObject({
				ok: false,
				error: 'PLUGIN_DENIED',
			});
			// A call with no proof, a proof nobody issued, and a proof that was revoked.
			expect(await callRetrieve({ args })).toMatchObject({
				ok: false,
				error: `Unknown tool: ${TOKEN_PROXY_RETRIEVE_TOOL_ID}`,
			});
			expect(await callRetrieve({ runToken: 'f'.repeat(64), args })).toMatchObject({
				ok: false,
				error: 'PLUGIN_DENIED',
			});
			const revoked = pluginToolRunIdentity.issue(AGENT_ID);
			pluginToolRunIdentity.revoke(revoked);
			expect(await callRetrieve({ runToken: revoked, args })).toMatchObject({
				ok: false,
				error: 'PLUGIN_DENIED',
			});

			// The right agent loses the tool the moment its stored switch is turned off.
			const runToken = issueRunToken(AGENT_ID);
			expect(await callRetrieve({ runToken, args })).toMatchObject({ ok: true });
			world.agents[0].tokenProxyRetrieval = false;
			expect((await listTools({ runToken })).tools).toEqual([]);
			expect(await callRetrieve({ runToken, args })).toMatchObject({
				ok: false,
				error: 'PLUGIN_DENIED',
			});

			// Every refusal stopped before the reader: only the one allowed call was a read.
			const { byCaller } = getTokenProxyRecoveryObservations();
			expect(byCaller.mcpRetrieveTool).toMatchObject({ invocations: 1, recoveredOriginals: 1 });
		});

		it('never shortens what the tool returned', async () => {
			const world = await startWorld();
			const log = logOf('again');
			const hash = await shortenedHash(world, log);
			const runToken = issueRunToken(AGENT_ID);

			// Lines 1 to 200 repeat themselves from line 41 on: text the compressor would shorten.
			const reply = await callRetrieve({ runToken, args: { hash } });
			expect(reply.ok).toBe(true);
			const retrieved = String(reply.result);

			// The next request carries the model's call and the tool's answer, under the
			// prefix a client gives a tool of an MCP server.
			const followUp = messagesBody([
				readLog(log.text),
				{
					id: 'toolu_retrieve',
					tool: `mcp__maestro__${TOKEN_PROXY_RETRIEVE_TOOL_NAME}`,
					input: { hash },
					result: retrieved,
				},
			]);
			await world.send(followUp);

			const [, received] = world.upstream.seen;
			expect(toolResultOf(received.body, 'toolu_retrieve')).toBe(retrieved);
			// The log it came from is still shortened, from the stored verdict.
			expect(parseCompressionMarker(toolResultOf(received.body, 'toolu_log'))?.hash).toBe(hash);

			const rows = await storedRows(2);
			expect(rows[1]).toMatchObject({
				blocks_compressed: 1,
				cache_hits: 1,
				blocks_vetoed_retrieval: 1,
				blocks_vetoed_failed: 0,
			});
		});
	});
});
