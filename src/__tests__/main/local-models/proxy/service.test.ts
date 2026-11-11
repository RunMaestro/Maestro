/**
 * @file service.test.ts
 *
 * The token proxy's lifecycle: the port is chosen once and kept, the listener
 * is up exactly while a local agent's gateway points at it, and a launch that
 * needs it gets a running proxy or a failure that names it.
 *
 * And what it tells the server and the user: an agent's mode is read from its
 * stored record on every request, a launch gets a base URL with the agent in
 * it only when the gateway is the proxy, each request is handed to the stats
 * recorder, and the report and the block read answer from the same stores.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const tempRoot = vi.hoisted(() => ({ dir: '' }));

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
}));

const logger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({ logger }));

// The stats database and the compressor are their own suites. Here they are
// the two things the service must hand a request to.
const requestStats = vi.hoisted(() => ({
	recordTokenProxyRequest: vi.fn(),
	readTokenProxyUsage: vi.fn(() => ({ usage: null, recentCompressions: [] as unknown[] })),
}));
vi.mock('../../../../main/local-models/proxy/request-stats', () => requestStats);

const compressor = vi.hoisted(() => ({
	compressRequestBody: vi.fn(),
}));
vi.mock('../../../../main/local-models/proxy/compress', () => compressor);

const sentry = vi.hoisted(() => ({ captureException: vi.fn(async () => {}) }));
vi.mock('../../../../main/utils/sentry', () => sentry);

const taskNotices = vi.hoisted(() => ({ reportLocalTaskUnavailable: vi.fn() }));
vi.mock('../../../../main/local-models/task-notices', () => taskNotices);

const cache = vi.hoisted(() => ({
	read: vi.fn(),
	write: vi.fn(),
	readOriginal: vi.fn(),
}));
vi.mock('../../../../main/local-models/proxy/compression-cache', () => ({
	getCompressionCache: () => cache,
	isContentHash: (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
}));

import {
	agentHasTokenProxyRetrieval,
	applyAgentGatewayToSpawn,
	configureTokenProxy,
	ensureTokenProxyForGateway,
	ensureTokenProxyPort,
	getTokenProxyRecoveryObservations,
	getTokenProxyReport,
	getTokenProxyStatus,
	readTokenProxyBlock,
	registerTokenProxyRecoveryLaunch,
	resetTokenProxyForTests,
	stopTokenProxy,
	syncTokenProxy,
	TOKEN_PROXY_STATE_FILE,
	tokenProxyLaunchGatewayUrl,
} from '../../../../main/local-models/proxy/service';
import {
	createTokenProxyServer,
	type TokenProxyServer,
	type TokenProxyServerOptions,
} from '../../../../main/local-models/proxy/server';
import { configureAgentRunOn, resetAgentRunOnForTests } from '../../../../main/local-models/run-on';
import type { LocalModelEndpoint } from '../../../../shared/local-models/endpoints';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../../shared/local-models/model-server';
import {
	resolveTokenProxyTarget,
	tokenProxyGatewayUrl,
} from '../../../../shared/local-models/token-proxy';
import type { LocalRecoveryCapability } from '../../../../main/local-models/proxy/compress';

let agents: Array<Record<string, unknown>> = [];

function configure(extra: { createServer?: (options: TokenProxyServerOptions) => never } = {}) {
	configureTokenProxy({ sessions: () => agents, dataDir: () => tempRoot.dir, ...extra });
}

/** Whether anything accepts a connection on loopback at `port`. */
function isListening(port: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const socket = net.connect({ host: '127.0.0.1', port });
		socket.once('connect', () => {
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => resolve(false));
	});
}

/** Hold `port` the way an unrelated program would. */
async function occupy(port: number): Promise<() => Promise<void>> {
	const squatter = net.createServer();
	await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
	return () => new Promise<void>((resolve) => squatter.close(() => resolve()));
}

const stateFile = () => path.join(tempRoot.dir, TOKEN_PROXY_STATE_FILE);

beforeEach(async () => {
	vi.clearAllMocks();
	// Leaked from an agent shell, this would point the default data dir at the
	// user's real one. Every test here passes its own.
	vi.stubEnv('MAESTRO_USER_DATA', undefined as unknown as string);
	tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-token-proxy-'));
	agents = [];
});

afterEach(async () => {
	await resetTokenProxyForTests();
	vi.unstubAllEnvs();
	await fs.rm(tempRoot.dir, { recursive: true, force: true });
});

describe('the port', () => {
	it('does not exist until something asks for it', async () => {
		configure();

		await syncTokenProxy();
		const status = await getTokenProxyStatus();

		expect(status).toEqual({
			port: null,
			running: false,
			agentIds: [],
			lastError: null,
			gatewayUrls: null,
		});
		await expect(fs.access(stateFile())).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('is chosen once, persisted, and returned again', async () => {
		configure();

		const port = await ensureTokenProxyPort();
		expect(port).toBeGreaterThan(0);
		expect(JSON.parse(await fs.readFile(stateFile(), 'utf-8'))).toEqual({ port });
		expect(await ensureTokenProxyPort()).toBe(port);
		// Choosing a port starts nothing.
		expect(await isListening(port)).toBe(false);
	});

	it('survives a restart: a new process reads the same port back', async () => {
		configure();
		const port = await ensureTokenProxyPort();

		await resetTokenProxyForTests();
		configure();

		expect(await ensureTokenProxyPort()).toBe(port);
		expect((await getTokenProxyStatus()).gatewayUrls).toEqual({
			anthropic: `http://127.0.0.1:${port}/anthropic`,
			openai: `http://127.0.0.1:${port}/openai/v1`,
			chatgpt: `http://127.0.0.1:${port}/chatgpt`,
		});
	});

	it('picks a new port when the state file holds nothing usable', async () => {
		await fs.writeFile(stateFile(), '{"port":"eighty"}', 'utf-8');
		configure();

		expect((await getTokenProxyStatus()).port).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
		const port = await ensureTokenProxyPort();
		expect(JSON.parse(await fs.readFile(stateFile(), 'utf-8'))).toEqual({ port });
	});

	it('gives concurrent first callers one port', async () => {
		configure();

		const ports = await Promise.all([
			ensureTokenProxyPort(),
			ensureTokenProxyPort(),
			ensureTokenProxyPort(),
		]);

		expect(new Set(ports).size).toBe(1);
	});
});

describe('syncTokenProxy', () => {
	it('starts when an agent points at the proxy and stops when none do', async () => {
		configure();
		const port = await ensureTokenProxyPort();

		agents = [{ id: 'a1', gatewayUrl: `http://127.0.0.1:${port}/anthropic` }];
		await syncTokenProxy();
		expect(await isListening(port)).toBe(true);
		expect(await getTokenProxyStatus()).toMatchObject({ running: true, agentIds: ['a1'] });

		agents = [{ id: 'a1' }];
		await syncTokenProxy();
		expect(await isListening(port)).toBe(false);
		expect(await getTokenProxyStatus()).toMatchObject({ running: false, agentIds: [] });
	});

	it('stays down for gateways that are not the proxy', async () => {
		configure();
		const port = await ensureTokenProxyPort();

		agents = [
			{ id: 'a1', gatewayUrl: 'http://127.0.0.1:8787' },
			{ id: 'a2', gatewayUrl: `https://proxy.example.com:${port}` },
			{ id: 'a3', gatewayUrl: '' },
			{ id: 'a4' },
		];
		await syncTokenProxy();

		expect(await isListening(port)).toBe(false);
	});

	it('does not start for an agent on an SSH remote, which cannot reach loopback', async () => {
		configure();
		const port = await ensureTokenProxyPort();

		agents = [
			{
				id: 'remote',
				gatewayUrl: `http://127.0.0.1:${port}/anthropic`,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			},
		];
		await syncTokenProxy();
		expect(await isListening(port)).toBe(false);

		// The same record with SSH switched off is a local agent again.
		agents = [{ ...agents[0], sessionSshRemoteConfig: { enabled: false, remoteId: 'r1' } }];
		await syncTokenProxy();
		expect(await isListening(port)).toBe(true);
	});

	it('keeps running while one of several agents still points at it', async () => {
		configure();
		const port = await ensureTokenProxyPort();
		const gatewayUrl = `http://localhost:${port}/openai/v1`;

		agents = [
			{ id: 'a1', gatewayUrl },
			{ id: 'a2', gatewayUrl },
		];
		await syncTokenProxy();
		agents = [{ id: 'a1' }, { id: 'a2', gatewayUrl }];
		await syncTokenProxy();

		expect(await isListening(port)).toBe(true);
		expect((await getTokenProxyStatus()).agentIds).toEqual(['a2']);
	});

	it('settles on the last state when calls overlap', async () => {
		configure();
		const port = await ensureTokenProxyPort();
		const pointing = [{ id: 'a1', gatewayUrl: `http://127.0.0.1:${port}/anthropic` }];

		agents = pointing;
		const first = syncTokenProxy();
		agents = [];
		const second = syncTokenProxy();
		agents = pointing;
		const third = syncTokenProxy();
		await Promise.all([first, second, third]);

		expect(await isListening(port)).toBe(true);
	});

	it('does not move to another port when its own is taken, and says why', async () => {
		configure();
		const port = await ensureTokenProxyPort();
		const release = await occupy(port);
		agents = [{ id: 'a1', gatewayUrl: `http://127.0.0.1:${port}/anthropic` }];

		await expect(syncTokenProxy()).resolves.toBeUndefined();

		const status = await getTokenProxyStatus();
		expect(status.running).toBe(false);
		expect(status.port).toBe(port);
		expect(status.lastError).toContain(`another program is using 127.0.0.1:${port}`);
		expect(logger.error).toHaveBeenCalled();

		// Once the port is free the next pass starts it and clears the error.
		await release();
		await syncTokenProxy();
		expect(await getTokenProxyStatus()).toMatchObject({ running: true, lastError: null });
	});
});

describe('ensureTokenProxyForGateway', () => {
	it('starts the proxy for a gateway that points at it', async () => {
		configure();
		const port = await ensureTokenProxyPort();

		const result = await ensureTokenProxyForGateway(`http://127.0.0.1:${port}/anthropic`);

		expect(result).toEqual({ ok: true });
		expect(await isListening(port)).toBe(true);
	});

	it('leaves any other gateway alone', async () => {
		configure();
		const port = await ensureTokenProxyPort();

		expect(await ensureTokenProxyForGateway('http://127.0.0.1:8787')).toEqual({ ok: true });
		expect(await ensureTokenProxyForGateway('https://litellm.example.com')).toEqual({ ok: true });

		expect(await isListening(port)).toBe(false);
	});

	it('is a no-op before a port was ever chosen', async () => {
		configure();

		expect(await ensureTokenProxyForGateway('http://127.0.0.1:8787/anthropic')).toEqual({
			ok: true,
		});
		await expect(fs.access(stateFile())).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('fails by name when the proxy port is held by another program', async () => {
		configure();
		const port = await ensureTokenProxyPort();
		const release = await occupy(port);
		const gatewayUrl = `http://127.0.0.1:${port}/anthropic`;

		const result = await ensureTokenProxyForGateway(gatewayUrl);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('Maestro token proxy');
			expect(result.error).toContain(gatewayUrl);
			expect(result.error).toContain(`another program is using 127.0.0.1:${port}`);
			expect(result.error).toContain('The turn was not sent.');
		}
		await release();
	});

	it('reports a start failure of any other kind too', async () => {
		configure({
			createServer: () => {
				throw new Error('never built');
			},
		});
		const port = await ensureTokenProxyPort();

		const result = await ensureTokenProxyForGateway(`http://127.0.0.1:${port}/anthropic`);

		expect(result.ok).toBe(false);
		expect((await getTokenProxyStatus()).running).toBe(false);
	});
});

describe('applyAgentGatewayToSpawn', () => {
	const input = { agentId: 'a1', toolType: 'claude-code', args: ['--print'] };

	it('changes nothing for an agent with no gateway, and for an unknown agent', async () => {
		configure();
		agents = [{ id: 'a1', toolType: 'claude-code' }];

		const expected = { ok: true, args: ['--print'], customEnvVars: undefined, gateway: null };
		expect(await applyAgentGatewayToSpawn(input)).toEqual(expected);
		expect(await applyAgentGatewayToSpawn({ ...input, agentId: 'gone' })).toEqual(expected);
	});

	it("sets the provider's base-URL variable to the agent's gateway", async () => {
		configure();
		agents = [{ id: 'a1', toolType: 'claude-code', gatewayUrl: 'https://litellm.example.com' }];

		const result = await applyAgentGatewayToSpawn({ ...input, customEnvVars: { FOO: '1' } });

		expect(result).toEqual({
			ok: true,
			args: ['--print'],
			customEnvVars: { FOO: '1', ANTHROPIC_BASE_URL: 'https://litellm.example.com' },
			gateway: { envVar: 'ANTHROPIC_BASE_URL', url: 'https://litellm.example.com' },
		});
	});

	it('puts a config argument in front for a provider that needs one', async () => {
		configure();
		agents = [{ id: 'a1', toolType: 'codex', gatewayUrl: 'https://litellm.example.com' }];

		const result = await applyAgentGatewayToSpawn({
			...input,
			toolType: 'codex',
			args: ['exec', '--json'],
		});

		expect(result.ok && result.args).toEqual([
			'-c',
			'openai_base_url="https://litellm.example.com"',
			'exec',
			'--json',
		]);
	});

	it("adds OpenCode's gateway to its inline config, built on the provider default", async () => {
		configure();
		agents = [{ id: 'a1', toolType: 'opencode', gatewayUrl: 'https://litellm.example.com/v1' }];
		const defaults = '{"permission":{"question":"deny"},"tools":{"question":false}}';

		const result = await applyAgentGatewayToSpawn({
			...input,
			toolType: 'opencode',
			agent: {
				batchModePrefix: ['run'],
				defaultEnvVars: { OPENCODE_CONFIG_CONTENT: defaults },
			},
			args: ['run', '--format', 'json'],
		});

		if (!result.ok) throw new Error(result.error);
		expect(result.args).toEqual(['run', '--standalone', '--format', 'json']);
		const config = JSON.parse(result.customEnvVars?.OPENCODE_CONFIG_CONTENT ?? 'null');
		expect(config.permission).toEqual({ question: 'deny' });
		expect(config.provider.anthropic.options.baseURL).toBe('https://litellm.example.com/v1');
		expect(result.gateway).toEqual({
			envVar: 'OPENCODE_CONFIG_CONTENT',
			url: 'https://litellm.example.com/v1',
		});
	});

	it("starts the Maestro proxy and puts the agent's id in the URL", async () => {
		configure();
		const port = await ensureTokenProxyPort();
		agents = [
			{ id: 'a1', toolType: 'claude-code', gatewayUrl: `http://127.0.0.1:${port}/anthropic` },
		];

		const result = await applyAgentGatewayToSpawn(input);

		expect(result.ok && result.gateway?.url).toBe(
			await tokenProxyLaunchGatewayUrl('a1', `http://127.0.0.1:${port}/anthropic`)
		);
		expect(result.ok && result.gateway?.url).toContain('a1');
		expect(await isListening(port)).toBe(true);
	});

	it('leaves the spawn alone when the agent sets the variable itself', async () => {
		configure();
		agents = [{ id: 'a1', toolType: 'claude-code', gatewayUrl: 'https://litellm.example.com' }];
		const customEnvVars = { ANTHROPIC_BASE_URL: 'https://mine.example.com' };

		expect(await applyAgentGatewayToSpawn({ ...input, customEnvVars })).toEqual({
			ok: true,
			args: ['--print'],
			customEnvVars,
			gateway: null,
		});
	});

	it('refuses a loopback gateway for a process on an SSH remote', async () => {
		configure();
		agents = [{ id: 'a1', toolType: 'claude-code', gatewayUrl: 'http://127.0.0.1:8787' }];

		const result = await applyAgentGatewayToSpawn({ ...input, remote: { name: 'build-box' } });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('SSH remote "build-box" cannot reach');
	});

	it('refuses when the Maestro proxy cannot start', async () => {
		configure();
		const port = await ensureTokenProxyPort();
		const release = await occupy(port);
		agents = [
			{ id: 'a1', toolType: 'claude-code', gatewayUrl: `http://127.0.0.1:${port}/anthropic` },
		];

		const result = await applyAgentGatewayToSpawn(input);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('The turn was not sent.');
		await release();
	});
});

describe('stopTokenProxy', () => {
	it('releases the port, and a later launch brings it back', async () => {
		configure();
		const port = await ensureTokenProxyPort();
		const gatewayUrl = `http://127.0.0.1:${port}/anthropic`;
		await ensureTokenProxyForGateway(gatewayUrl);

		await stopTokenProxy();
		expect(await isListening(port)).toBe(false);

		expect(await ensureTokenProxyForGateway(gatewayUrl)).toEqual({ ok: true });
		expect(await isListening(port)).toBe(true);
	});
});

describe('request logging', () => {
	it('logs the byte counts of a forwarded request, and never a header', async () => {
		const upstream = net.createServer((socket) => {
			socket.once('data', () => {
				socket.end('HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello');
			});
		});
		await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
		const upstreamPort = (upstream.address() as net.AddressInfo).port;
		configureTokenProxy({
			sessions: () => agents,
			dataDir: () => tempRoot.dir,
			createServer: (options) =>
				createTokenProxyServer({
					...options,
					upstreams: { anthropic: `http://127.0.0.1:${upstreamPort}` },
				}),
		});
		const port = await ensureTokenProxyPort();
		await ensureTokenProxyForGateway(`http://127.0.0.1:${port}/anthropic`);

		const response = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
			method: 'POST',
			headers: { authorization: 'Bearer sk-secret', 'content-type': 'application/json' },
			body: '{"a":1}',
		});
		expect(await response.text()).toBe('hello');

		await vi.waitFor(() =>
			expect(logger.info).toHaveBeenCalledWith(
				'POST /anthropic/v1/messages -> 200: 7 bytes sent, 5 bytes received',
				'[TokenProxy]',
				expect.objectContaining({
					route: 'anthropic',
					kind: 'anthropic-messages',
					requestBytes: 7,
					responseBytes: 5,
					outcome: 'completed',
				})
			)
		);
		expect(JSON.stringify(logger.info.mock.calls)).not.toContain('sk-secret');
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	});
});

/** Start the proxy with a server that only records the options it was built with. */
async function startWithCapturedOptions(): Promise<{
	port: number;
	options: TokenProxyServerOptions;
}> {
	let captured: TokenProxyServerOptions | undefined;
	configureTokenProxy({
		sessions: () => agents,
		dataDir: () => tempRoot.dir,
		safeSend: vi.fn() as never,
		createServer: (options): TokenProxyServer => {
			captured = options;
			let bound: number | null = null;
			return {
				listen: async (port) => (bound = port),
				port: () => bound,
				close: async () => {
					bound = null;
				},
			};
		},
	});
	const port = await ensureTokenProxyPort();
	await ensureTokenProxyForGateway(`http://127.0.0.1:${port}/anthropic`);
	return { port, options: captured! };
}

describe("an agent's mode", () => {
	it('is read from the stored agent on every request', async () => {
		const { options } = await startWithCapturedOptions();
		agents = [{ id: 'a', tokenProxyMode: 'compress' }, { id: 'b' }];

		expect(options.modeFor?.('a')).toBe('compress');
		expect(options.modeFor?.('b')).toBe('passthrough');

		// The user switches both. No restart: the next request sees it.
		agents = [{ id: 'a' }, { id: 'b', tokenProxyMode: 'compress' }];
		expect(options.modeFor?.('a')).toBe('passthrough');
		expect(options.modeFor?.('b')).toBe('compress');
	});

	it('is passthrough for a request with no agent, an unknown agent, and a bad value', async () => {
		const { options } = await startWithCapturedOptions();
		agents = [{ id: 'a', tokenProxyMode: 'everything' }];

		expect(options.modeFor?.(null)).toBe('passthrough');
		expect(options.modeFor?.('gone')).toBe('passthrough');
		expect(options.modeFor?.('a')).toBe('passthrough');
	});

	it('compresses through compress.ts, and reports a model that could not run', async () => {
		const { options } = await startWithCapturedOptions();
		const result = { body: '{}', changed: false, blocks: [], stats: {} };
		compressor.compressRequestBody.mockResolvedValueOnce(result);

		await expect(
			options.compress?.('anthropic-messages', '{"a":1}', { early: true })
		).resolves.toBe(result);

		expect(compressor.compressRequestBody).toHaveBeenCalledWith(
			'anthropic-messages',
			'{"a":1}',
			// The agent's early choice reaches the compressor as it was made.
			expect.objectContaining({ early: true, onModelUnavailable: expect.any(Function) })
		);
		const verdict = { status: 'unavailable', code: 'model-not-installed', reason: 'Not installed' };
		compressor.compressRequestBody.mock.calls[0][2].onModelUnavailable(verdict);
		expect(taskNotices.reportLocalTaskUnavailable).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: 'token-proxy', verdict })
		);
	});

	it('hands every finished request to the stats recorder', async () => {
		const { options } = await startWithCapturedOptions();
		const entry = {
			route: 'anthropic',
			kind: 'anthropic-messages',
			agentId: 'a',
			mode: 'compress',
			startedAt: 1,
			method: 'POST',
			path: '/v1/messages',
			status: 200,
			requestBytes: 10,
			sentBytes: 8,
			responseBytes: 5,
			durationMs: 3,
			outcome: 'completed',
		} as const;

		options.onRequest?.(entry);

		expect(requestStats.recordTokenProxyRequest).toHaveBeenCalledWith(entry);
	});
});

describe('agentHasTokenProxyRetrieval', () => {
	it('is true only for a local agent with retrieval on that the proxy compresses for', async () => {
		configure();
		const port = await ensureTokenProxyPort();
		const gatewayUrl = tokenProxyGatewayUrl(port, 'anthropic');
		agents = [
			{ id: 'early', gatewayUrl, tokenProxyMode: 'compress-early', tokenProxyRetrieval: true },
			{ id: 'late', gatewayUrl, tokenProxyMode: 'compress', tokenProxyRetrieval: true },
			// Kept on a passthrough agent, but it shortens nothing, so no tool.
			{ id: 'pass', gatewayUrl, tokenProxyRetrieval: true },
			{ id: 'off', gatewayUrl, tokenProxyMode: 'compress-early' },
			{
				id: 'other-gateway',
				gatewayUrl: 'http://127.0.0.1:1/x',
				tokenProxyMode: 'compress',
				tokenProxyRetrieval: true,
			},
			{
				id: 'ssh',
				gatewayUrl,
				tokenProxyMode: 'compress',
				tokenProxyRetrieval: true,
				sessionSshRemoteConfig: { enabled: true },
			},
		];

		expect(await agentHasTokenProxyRetrieval('early')).toBe(true);
		expect(await agentHasTokenProxyRetrieval('late')).toBe(true);
		for (const id of ['pass', 'off', 'other-gateway', 'ssh', 'gone']) {
			expect(await agentHasTokenProxyRetrieval(id)).toBe(false);
		}
	});

	it('is false while no proxy port has been chosen', async () => {
		configure();
		agents = [
			{
				id: 'a',
				gatewayUrl: 'http://127.0.0.1:4000/anthropic',
				tokenProxyMode: 'compress',
				tokenProxyRetrieval: true,
			},
		];
		expect(await agentHasTokenProxyRetrieval('a')).toBe(false);
	});
});

describe("an agent's background requests", () => {
	const OLLAMA: LocalModelEndpoint = {
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama',
		baseUrl: 'http://127.0.0.1:11434',
		apiKeyEnvVar: 'OLLAMA_KEY',
		enabled: true,
	};
	const LITELLM: LocalModelEndpoint = {
		id: 'ep-litellm',
		name: 'LiteLLM',
		kind: 'openai-compatible',
		baseUrl: 'https://llm.example.com',
		enabled: true,
	};
	const SERVER_URL = 'http://127.0.0.1:52100';
	const ON_SERVER = { type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: 'qwen3.5-4b' };
	const ON_OLLAMA = { type: 'source', endpointId: OLLAMA.id, model: 'qwen3:4b' };

	const modelServer = vi.fn();
	let endpoints: LocalModelEndpoint[] = [];

	const agent = (id: string, target?: unknown): Record<string, unknown> => ({
		id,
		toolType: 'claude-code',
		...(target === undefined ? {} : { backgroundRequests: { target } }),
	});

	beforeEach(() => {
		endpoints = [OLLAMA, LITELLM];
		modelServer.mockResolvedValue({ ok: true, baseUrl: SERVER_URL, key: 'sk-server' });
		configureAgentRunOn({
			sessions: () => agents,
			endpoints: () => endpoints,
			shellEnvVars: () => ({ OLLAMA_KEY: 'sk-ollama' }),
			modelServer,
		});
	});

	afterEach(() => {
		resetAgentRunOnForTests();
	});

	it('are read from the stored agent on every request', async () => {
		const { options } = await startWithCapturedOptions();
		agents = [agent('a', ON_SERVER), agent('b')];

		expect(options.backgroundRouteFor?.('a')).toMatchObject({
			toolType: 'claude-code',
			routedTo: 'maestro-server:qwen3.5-4b',
		});
		expect(options.backgroundRouteFor?.('b')).toBeNull();

		// The user moves the target and gives the other agent one. No restart.
		agents = [agent('a'), agent('b', ON_OLLAMA)];
		expect(options.backgroundRouteFor?.('a')).toBeNull();
		expect(options.backgroundRouteFor?.('b')).toMatchObject({ routedTo: 'ep-ollama:qwen3:4b' });
	});

	it('go to the provider for a request with no agent, an unknown agent, and a provider target', async () => {
		const { options } = await startWithCapturedOptions();
		agents = [agent('a', { type: 'provider' })];

		expect(options.backgroundRouteFor?.(null)).toBeNull();
		expect(options.backgroundRouteFor?.('gone')).toBeNull();
		expect(options.backgroundRouteFor?.('a')).toBeNull();
	});

	it('start the model server only when a request is routed, then say where it listens', async () => {
		const { options } = await startWithCapturedOptions();
		agents = [agent('a', ON_SERVER)];

		const route = options.backgroundRouteFor?.('a');
		// Asked on every Messages request, turns included: it must start nothing.
		expect(modelServer).not.toHaveBeenCalled();

		await expect(route?.resolve()).resolves.toEqual({
			ok: true,
			baseUrl: SERVER_URL,
			key: 'sk-server',
			model: 'qwen3.5-4b',
		});
		expect(modelServer).toHaveBeenCalledWith('qwen3.5-4b');
	});

	it('send a saved source the key Settings holds for it', async () => {
		const { options } = await startWithCapturedOptions();
		agents = [agent('a', ON_OLLAMA)];

		await expect(options.backgroundRouteFor?.('a')?.resolve()).resolves.toEqual({
			ok: true,
			baseUrl: OLLAMA.baseUrl,
			key: 'sk-ollama',
			model: 'qwen3:4b',
		});
		expect(modelServer).not.toHaveBeenCalled();
	});

	it('fail by name for a target that cannot be used, and never name the provider as a way out', async () => {
		const { options } = await startWithCapturedOptions();
		const refusal = async (target: unknown): Promise<string> => {
			agents = [agent('a', target)];
			const resolved = await options.backgroundRouteFor?.('a')?.resolve();
			if (!resolved || resolved.ok)
				throw new Error(`expected a refusal: ${JSON.stringify(resolved)}`);
			expect(resolved.error).toContain('The request was not sent to the provider.');
			return resolved.error;
		};

		expect(await refusal({ type: 'source', endpointId: 'ep-gone', model: 'm' })).toContain(
			'its source (ep-gone) is no longer configured'
		);

		endpoints = [{ ...OLLAMA, enabled: false }];
		expect(await refusal(ON_OLLAMA)).toContain('the source "Ollama" is disabled');

		endpoints = [LITELLM];
		expect(await refusal({ type: 'source', endpointId: LITELLM.id, model: 'm' })).toContain(
			'cannot tell that the source "LiteLLM" serves the Anthropic Messages route'
		);

		modelServer.mockResolvedValueOnce({ ok: false, error: 'Qwen 3.5 4B is not downloaded.' });
		expect(await refusal(ON_SERVER)).toContain(
			'Maestro model server could not serve it (Qwen 3.5 4B is not downloaded)'
		);
	});

	it('fail by name for a stored value that is not a target, which is never read as "not routed"', async () => {
		const { options } = await startWithCapturedOptions();
		agents = [
			{ id: 'a', toolType: 'claude-code', backgroundRequests: 'maestro-server:qwen3.5-4b' },
		];

		const route = options.backgroundRouteFor?.('a');

		expect(route).not.toBeNull();
		expect(route?.routedTo).toBeUndefined();
		const resolved = await route?.resolve();
		expect(resolved).toMatchObject({ ok: false });
		if (resolved?.ok === false) {
			expect(resolved.error).toContain("This agent's Background requests target cannot be used");
			expect(resolved.error).toContain('The request was not sent to the provider.');
		}
	});

	it('report a lookup that throws, and still fail the request instead of sending it on', async () => {
		const { options } = await startWithCapturedOptions();
		agents = [agent('a', ON_SERVER)];
		modelServer.mockRejectedValueOnce(new Error('supervisor state is corrupt'));

		const route = options.backgroundRouteFor?.('a');

		// The server turns this into a 502 that names the target (server.test.ts).
		await expect(route?.resolve()).rejects.toThrow('supervisor state is corrupt');
		expect(sentry.captureException).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'supervisor state is corrupt' }),
			expect.objectContaining({ agentId: 'a', routedTo: 'maestro-server:qwen3.5-4b' })
		);
		// A refusal is an answer, not a bug: nothing is reported for one.
		sentry.captureException.mockClear();
		modelServer.mockResolvedValueOnce({ ok: false, error: 'not downloaded' });
		await expect(route?.resolve()).resolves.toMatchObject({ ok: false });
		expect(sentry.captureException).not.toHaveBeenCalled();
	});

	it('route a real request to the source, log the target, and record it', async () => {
		const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
		const listen = async (who: string): Promise<{ server: http.Server; origin: string }> => {
			const server = http.createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on('data', (chunk: Buffer) => chunks.push(chunk));
				req.on('end', () => {
					if (who === 'source') {
						seen.push({
							url: req.url ?? '',
							headers: req.headers,
							body: Buffer.concat(chunks).toString('utf-8'),
						});
					}
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ from: who }));
				});
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			return { server, origin: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` };
		};
		const provider = await listen('provider');
		const source = await listen('source');
		endpoints = [{ ...OLLAMA, baseUrl: source.origin }];
		agents = [agent('a', ON_OLLAMA)];
		configureTokenProxy({
			sessions: () => agents,
			dataDir: () => tempRoot.dir,
			createServer: (options) =>
				createTokenProxyServer({ ...options, upstreams: { anthropic: provider.origin } }),
		});
		const port = await ensureTokenProxyPort();
		await ensureTokenProxyForGateway(`http://127.0.0.1:${port}/anthropic`);

		const response = await fetch(`http://127.0.0.1:${port}/agent/a/anthropic/v1/messages`, {
			method: 'POST',
			headers: { authorization: 'Bearer oauth-secret', 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 32,
				messages: [{ role: 'user', content: 'title this' }],
			}),
		});

		expect(await response.json()).toEqual({ from: 'source' });
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe('/v1/messages');
		expect(seen[0].headers.authorization).toBe('Bearer sk-ollama');
		expect(JSON.parse(seen[0].body).model).toBe('qwen3:4b');

		await vi.waitFor(() =>
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining('routed to ep-ollama:qwen3:4b'),
				'[TokenProxy]',
				expect.objectContaining({ agentId: 'a', routedTo: 'ep-ollama:qwen3:4b' })
			)
		);
		expect(requestStats.recordTokenProxyRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				background: expect.objectContaining({ routedTo: 'ep-ollama:qwen3:4b' }),
			})
		);
		// Neither credential is written to the log.
		const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
		expect(logged).not.toContain('oauth-secret');
		expect(logged).not.toContain('sk-ollama');

		await stopTokenProxy();
		await Promise.all(
			[provider, source].map(
				({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))
			)
		);
	});
});

describe('host-issued recovery launch bindings', () => {
	let recovery: LocalRecoveryCapability;
	beforeEach(() => {
		// Synthetic host evidence only. These POSIX paths are never executed.
		recovery = {
			kind: 'local-posix-cli',
			environmentId: 'e'.repeat(64),
			runtimePath: '/runtime',
			cliPath: '/maestro-cli.js',
			dataDir: tempRoot.dir,
		};
	});

	function targetFor(url: string) {
		const target = resolveTokenProxyTarget('POST', new URL(url).pathname);
		if (!target.ok) throw new Error(target.error);
		return target;
	}

	it('registers separate opaque bindings, snapshots evidence and forwards it to the prepared compressor', async () => {
		const { port, options } = await startWithCapturedOptions();
		const plain = `http://127.0.0.1:${port}/anthropic`;
		const before = await fs.readFile(stateFile(), 'utf-8');
		const first = await registerTokenProxyRecoveryLaunch('a', plain, recovery);
		const second = await registerTokenProxyRecoveryLaunch('a', plain, recovery);
		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		const target = targetFor(first!.gatewayUrl);
		expect(target.launchBinding).toMatch(/^[0-9a-f]{64}$/);
		expect(first!.gatewayUrl).not.toBe(second!.gatewayUrl);
		expect(first!.gatewayUrl).not.toContain(recovery.environmentId);
		const expected = { ...recovery };
		recovery.runtimePath = '/mutated';
		const resolved = options.recoveryFor?.(target);
		expect(resolved).toEqual(expected);
		resolved!.runtimePath = '/also-mutated';
		expect(options.recoveryFor?.(target)).toEqual(expected);
		compressor.compressRequestBody.mockResolvedValueOnce({ body: '{}', changed: false });
		await options.compress?.('anthropic-messages', '{}', {
			early: true,
			recovery: options.recoveryFor?.(target),
		});
		expect(compressor.compressRequestBody).toHaveBeenLastCalledWith(
			'anthropic-messages',
			'{}',
			expect.objectContaining({ early: true, recovery: expected })
		);
		first!.release();
		first!.release();
		expect(options.recoveryFor?.(target)).toBeUndefined();
		expect(options.recoveryFor?.(targetFor(second!.gatewayUrl))).toEqual(expected);
		expect(await fs.readFile(stateFile(), 'utf-8')).toBe(before);
		expect(logger.info.mock.calls.flat().join(' ')).not.toContain(target.launchBinding);
	});

	it('cannot obtain evidence from agent settings, an unknown token, another agent or another route', async () => {
		const { port, options } = await startWithCapturedOptions();
		const plain = `http://127.0.0.1:${port}/anthropic`;
		agents = [
			{
				id: 'a',
				gatewayUrl: plain,
				tokenProxyMode: 'compress',
				recovery,
				sessionSshRemoteConfig: { enabled: false },
			},
		];
		const legacy = await tokenProxyLaunchGatewayUrl('a', plain);
		expect(legacy).toBe(`http://127.0.0.1:${port}/agent/a/anthropic`);
		expect(options.recoveryFor?.(targetFor(legacy!))).toBeUndefined();
		expect(options.recoveryFor?.(targetFor(plain + '?recovery=local'))).toBeUndefined();
		const launch = await registerTokenProxyRecoveryLaunch('a', plain, recovery);
		const target = targetFor(launch!.gatewayUrl);
		for (const changed of [
			{ ...target, agentId: null },
			{ ...target, agentId: 'b' },
			{ ...target, route: 'openai' },
			{ ...target, launchBinding: 'f'.repeat(64) },
		]) {
			expect(options.recoveryFor?.(changed)).toBeUndefined();
		}
		expect(options.recoveryFor?.(target)).toEqual(recovery);
	});

	it('does not start a listener or choose a port to register a launch', async () => {
		configure();
		expect(
			await registerTokenProxyRecoveryLaunch('a', 'http://127.0.0.1:41234/anthropic', recovery)
		).toBeNull();
		await expect(fs.access(stateFile())).rejects.toMatchObject({ code: 'ENOENT' });
		const port = await ensureTokenProxyPort();
		expect(
			await registerTokenProxyRecoveryLaunch('a', `http://127.0.0.1:${port}/anthropic`, recovery)
		).toBeNull();
		expect((await getTokenProxyStatus()).running).toBe(false);
	});

	it('rejects unsupported or mismatched host evidence and gateway namespaces', async () => {
		const { port } = await startWithCapturedOptions();
		const plain = `http://127.0.0.1:${port}/anthropic`;
		for (const gateway of [
			'not a url',
			plain.replace('http:', 'https:'),
			'http://127.0.0.1:1/anthropic',
			`http://remote.invalid:${port}/anthropic`,
			`http://127.0.0.1:${port}/agent/b/anthropic`,
			plain + '/v1/messages',
			plain + '?other=1',
			plain + '#fragment',
			plain.replace('http://', 'http://user:secret@'),
		]) {
			expect(await registerTokenProxyRecoveryLaunch('a', gateway, recovery)).toBeNull();
		}
		for (const changed of [
			{ ...recovery, kind: 'ssh' },
			{ ...recovery, kind: 'unknown' },
			{ ...recovery, dataDir: path.join(tempRoot.dir, 'other') },
			{ ...recovery, runtimePath: 'x'.repeat(2049) },
			{ ...recovery, environmentId: 'not-an-environment-hash' },
		]) {
			expect(
				await registerTokenProxyRecoveryLaunch('a', plain, changed as LocalRecoveryCapability)
			).toBeNull();
		}
		expect(await registerTokenProxyRecoveryLaunch('', plain, recovery)).toBeNull();
		const launch = await registerTokenProxyRecoveryLaunch('a', plain, recovery);
		expect(await registerTokenProxyRecoveryLaunch('a', launch!.gatewayUrl, recovery)).toBeNull();
	});

	it('accepts already attributed gateways for all three known routes', async () => {
		const { port, options } = await startWithCapturedOptions();
		for (const route of ['anthropic', 'openai/v1', 'chatgpt']) {
			const scoped = await tokenProxyLaunchGatewayUrl('a b', `http://127.0.0.1:${port}/${route}`);
			const launch = await registerTokenProxyRecoveryLaunch('a b', scoped!, recovery);
			expect(launch).not.toBeNull();
			expect(options.recoveryFor?.(targetFor(launch!.gatewayUrl))).toEqual(recovery);
		}
	});

	it('bounds active registrations without evicting earlier launches, and reuses released capacity', async () => {
		const { port, options } = await startWithCapturedOptions();
		const plain = `http://127.0.0.1:${port}/anthropic`;
		const launches = [];
		for (let i = 0; i < 256; i++)
			launches.push(await registerTokenProxyRecoveryLaunch('a', plain, recovery));
		expect(launches.every(Boolean)).toBe(true);
		expect(await registerTokenProxyRecoveryLaunch('a', plain, recovery)).toBeNull();
		expect(options.recoveryFor?.(targetFor(launches[0]!.gatewayUrl))).toEqual(recovery);
		launches[0]!.release();
		expect(await registerTokenProxyRecoveryLaunch('a', plain, recovery)).not.toBeNull();
		expect(options.recoveryFor?.(targetFor(launches[0]!.gatewayUrl))).toBeUndefined();
	});

	it('revokes every binding on stop/restart and configuration replacement', async () => {
		const { port, options } = await startWithCapturedOptions();
		const plain = `http://127.0.0.1:${port}/anthropic`;
		const first = await registerTokenProxyRecoveryLaunch('a', plain, recovery);
		await stopTokenProxy();
		expect(options.recoveryFor?.(targetFor(first!.gatewayUrl))).toBeUndefined();
		await ensureTokenProxyForGateway(plain);
		expect(options.recoveryFor?.(targetFor(first!.gatewayUrl))).toBeUndefined();
		const second = await registerTokenProxyRecoveryLaunch('a', plain, recovery);
		configure();
		expect(options.recoveryFor?.(targetFor(second!.gatewayUrl))).toBeUndefined();
	});

	it('withholds evidence if the desktop archive namespace changes', async () => {
		const { port, options } = await startWithCapturedOptions();
		const launch = await registerTokenProxyRecoveryLaunch(
			'a',
			`http://127.0.0.1:${port}/anthropic`,
			recovery
		);
		vi.stubEnv('MAESTRO_USER_DATA', path.join(tempRoot.dir, 'other'));
		expect(options.recoveryFor?.(targetFor(launch!.gatewayUrl))).toBeUndefined();
		vi.stubEnv('MAESTRO_USER_DATA', undefined as unknown as string);
		expect(options.recoveryFor?.(targetFor(launch!.gatewayUrl))).toBeUndefined();
	});

	it('binds a launch that was given the retrieve tool, while its switch stays on', async () => {
		const { port, options } = await startWithCapturedOptions();
		const plain = `http://127.0.0.1:${port}/anthropic`;
		agents = [
			{ id: 'a', gatewayUrl: plain, tokenProxyMode: 'compress-early', tokenProxyRetrieval: true },
		];
		const launch = await registerTokenProxyRecoveryLaunch('a', plain, {
			kind: 'mcp-retrieve-tool',
		});
		expect(launch).not.toBeNull();
		const target = targetFor(launch!.gatewayUrl);
		expect(options.recoveryFor?.(target)).toEqual({ kind: 'mcp-retrieve-tool' });
		// Extra fields a caller passes are not kept.
		const padded = await registerTokenProxyRecoveryLaunch('a', plain, {
			kind: 'mcp-retrieve-tool',
			dataDir: '/elsewhere',
		} as never);
		expect(options.recoveryFor?.(targetFor(padded!.gatewayUrl))).toEqual({
			kind: 'mcp-retrieve-tool',
		});
		// Another agent, an unbound URL and the agent's settings prove nothing.
		expect(options.recoveryFor?.({ ...target, agentId: 'b' })).toBeUndefined();
		expect(
			options.recoveryFor?.(targetFor((await tokenProxyLaunchGatewayUrl('a', plain))!))
		).toBeUndefined();
		// The switch turned off mid-launch: the next call is refused, so the
		// next request must not get a block only the tool could bring back.
		agents = [{ ...agents[0], tokenProxyRetrieval: false }];
		expect(options.recoveryFor?.(target)).toBeUndefined();
		agents = [{ ...agents[0], tokenProxyRetrieval: true }];
		expect(options.recoveryFor?.(target)).toEqual({ kind: 'mcp-retrieve-tool' });
		agents = [];
		expect(options.recoveryFor?.(target)).toBeUndefined();
		agents = [{ id: 'a', gatewayUrl: plain, tokenProxyRetrieval: true }];
		launch!.release();
		expect(options.recoveryFor?.(target)).toBeUndefined();
	});

	it('does not revive a queued registration after configuration replacement', async () => {
		const { port } = await startWithCapturedOptions();
		const pending = registerTokenProxyRecoveryLaunch(
			'a',
			`http://127.0.0.1:${port}/anthropic`,
			recovery
		);
		configure();
		expect(await pending).toBeNull();
	});
});

describe('tokenProxyLaunchGatewayUrl', () => {
	it('puts the agent in the base URL of a gateway that is the proxy', async () => {
		configure();
		const port = await ensureTokenProxyPort();

		await expect(
			tokenProxyLaunchGatewayUrl('agent-1', `http://127.0.0.1:${port}/anthropic`)
		).resolves.toBe(`http://127.0.0.1:${port}/agent/agent-1/anthropic`);
	});

	it('returns any other gateway, and no gateway, as it was', async () => {
		configure();
		const port = await ensureTokenProxyPort();

		await expect(
			tokenProxyLaunchGatewayUrl('agent-1', 'http://127.0.0.1:1/anthropic')
		).resolves.toBe('http://127.0.0.1:1/anthropic');
		await expect(tokenProxyLaunchGatewayUrl('agent-1', undefined)).resolves.toBeUndefined();
		await expect(
			tokenProxyLaunchGatewayUrl(undefined, `http://127.0.0.1:${port}/anthropic`)
		).resolves.toBe(`http://127.0.0.1:${port}/anthropic`);
	});

	it('changes nothing, and chooses no port, before one exists', async () => {
		configure();

		await expect(
			tokenProxyLaunchGatewayUrl('agent-1', 'http://127.0.0.1:41234/anthropic')
		).resolves.toBe('http://127.0.0.1:41234/anthropic');
		await expect(fs.access(stateFile())).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

describe('getTokenProxyReport', () => {
	it('names the agents on the proxy with their mode, and carries the usage', async () => {
		configure();
		const port = await ensureTokenProxyPort();
		const onProxy = `http://127.0.0.1:${port}/anthropic`;
		agents = [
			{ id: 'a', name: 'Alpha', toolType: 'claude-code', gatewayUrl: onProxy },
			{
				id: 'b',
				name: 'Beta',
				toolType: 'claude-code',
				gatewayUrl: onProxy,
				tokenProxyMode: 'compress',
			},
			{ id: 'c', name: 'Elsewhere', toolType: 'codex', gatewayUrl: 'http://127.0.0.1:1' },
		];
		const usage = { range: 'month', totals: { requests: 2 }, byAgent: [] };
		const recentCompressions = [{ hash: 'f'.repeat(64) }];
		requestStats.readTokenProxyUsage.mockReturnValueOnce({ usage, recentCompressions } as never);

		const report = await getTokenProxyReport();

		expect(report.status.agentIds).toEqual(['a', 'b']);
		expect(report.agents).toEqual([
			{ id: 'a', name: 'Alpha', toolType: 'claude-code', mode: 'passthrough', gatewayUrl: onProxy },
			{ id: 'b', name: 'Beta', toolType: 'claude-code', mode: 'compress', gatewayUrl: onProxy },
		]);
		expect(report.usage).toBe(usage);
		expect(report.recentCompressions).toBe(recentCompressions);
	});

	it('answers before a port exists, without choosing one', async () => {
		configure();

		const report = await getTokenProxyReport();

		expect(report.status.port).toBeNull();
		expect(report.agents).toEqual([]);
		await expect(fs.access(stateFile())).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

describe('readTokenProxyBlock', () => {
	const hash = 'c'.repeat(64);

	it('returns both sides of a compressed block', async () => {
		cache.read.mockResolvedValueOnce({
			outcome: 'compressed',
			hash,
			originalTokens: 2000,
			compressedTokens: 300,
			compressors: ['logs', 'long-lines'],
			text: 'short\n[maestro-compressed]',
			createdAt: 42,
		});
		cache.readOriginal.mockResolvedValueOnce('the long original');

		await expect(readTokenProxyBlock(hash)).resolves.toEqual({
			hash,
			original: 'the long original',
			compressed: 'short\n[maestro-compressed]',
			originalTokens: 2000,
			compressedTokens: 300,
			compressors: ['logs', 'long-lines'],
			createdAt: 42,
		});
	});

	it('answers null for a block that was kept, or that the cache does not hold', async () => {
		cache.read.mockResolvedValueOnce({ outcome: 'kept', hash, originalTokens: 9, createdAt: 1 });
		await expect(readTokenProxyBlock(hash)).resolves.toBeNull();

		cache.read.mockResolvedValueOnce(null);
		await expect(readTokenProxyBlock(hash)).resolves.toBeNull();
		expect(cache.readOriginal).not.toHaveBeenCalled();
	});

	it('selects original lines through the same cache while retaining the full frozen replacement and totals', async () => {
		const requested = { startLine: 2, endLine: 4 };
		const range = {
			hash,
			source: 'original' as const,
			requested,
			returned: { startLine: 2, endLine: 3 },
			complete: false,
			hasMore: false,
		};
		cache.read.mockResolvedValueOnce({
			outcome: 'compressed',
			hash,
			originalTokens: 2000,
			compressedTokens: 300,
			compressors: ['logs'],
			text: 'full frozen replacement',
			createdAt: 42,
		});
		cache.readOriginal.mockResolvedValueOnce({ text: 'selected\r\nlast', range });
		await expect(readTokenProxyBlock(hash, requested)).resolves.toEqual({
			hash,
			original: 'selected\r\nlast',
			originalRange: range,
			compressed: 'full frozen replacement',
			originalTokens: 2000,
			compressedTokens: 300,
			compressors: ['logs'],
			createdAt: 42,
		});
		expect(cache.readOriginal).toHaveBeenCalledExactlyOnceWith(hash, requested);
		expect(cache.write).not.toHaveBeenCalled();
	});

	it('distinguishes a missing original from a missing verdict on range requests', async () => {
		const range = { startLine: 1, endLine: 2 };
		cache.read.mockResolvedValueOnce({
			outcome: 'compressed',
			hash,
			originalTokens: 2000,
			compressedTokens: 300,
			compressors: ['logs'],
			text: 'replacement',
			createdAt: 42,
		});
		cache.readOriginal.mockResolvedValueOnce(null);
		await expect(readTokenProxyBlock(hash, range)).resolves.toMatchObject({
			original: null,
			originalRange: null,
			compressed: 'replacement',
		});
		cache.read.mockResolvedValueOnce(null);
		await expect(readTokenProxyBlock(hash, range)).resolves.toBeNull();
		cache.read.mockResolvedValueOnce({ outcome: 'kept', hash, originalTokens: 2, createdAt: 1 });
		await expect(readTokenProxyBlock(hash, range)).resolves.toBeNull();
		expect(cache.readOriginal).toHaveBeenCalledTimes(1);
	});

	it('validates malformed bounds before consulting even a missing verdict', async () => {
		for (const value of [
			null,
			{},
			{ startLine: 0, endLine: 2 },
			{ startLine: 1, endLine: 1001 },
			{ startLine: 2, endLine: 1 },
		]) {
			await expect(readTokenProxyBlock(hash, value as never)).rejects.toThrow(
				'Original line range'
			);
		}
		expect(cache.read).not.toHaveBeenCalled();
		expect(cache.readOriginal).not.toHaveBeenCalled();
	});

	it('propagates archive and size-limit failures instead of returning a misleading successful range', async () => {
		for (const failure of [new RangeError('output limit'), new Error('archive read failed')]) {
			cache.read.mockResolvedValueOnce({
				outcome: 'compressed',
				hash,
				originalTokens: 2000,
				compressedTokens: 300,
				compressors: ['logs'],
				text: 'replacement',
				createdAt: 42,
			});
			cache.readOriginal.mockRejectedValueOnce(failure);
			await expect(readTokenProxyBlock(hash, { startLine: 1, endLine: 2 })).rejects.toBe(failure);
		}
	});

	it('refuses a value that is not a hash before it reaches the cache', async () => {
		for (const value of ['../../etc/passwd', 'ABC', '', undefined, 12]) {
			await expect(readTokenProxyBlock(value)).rejects.toThrow('SHA-256');
			await expect(readTokenProxyBlock(value, { startLine: 1, endLine: 2 })).rejects.toThrow(
				'SHA-256'
			);
		}
		expect(cache.read).not.toHaveBeenCalled();
	});

	describe('recovery observations', () => {
		beforeEach(() => {
			cache.read.mockReset().mockResolvedValue({
				outcome: 'compressed',
				hash,
				originalTokens: 2000,
				compressedTokens: 300,
				compressors: ['logs'],
				text: 'replacement',
				createdAt: 42,
			});
			cache.readOriginal.mockReset().mockResolvedValue('');
		});

		afterEach(() => {
			cache.read.mockReset();
			cache.readOriginal.mockReset();
		});

		it('counts actual repeated reads and exact returned UTF-8 volume, with explicit coverage limits', async () => {
			const first = 'caf\u00e9\r\n';
			const selected = '\u8cc7\u6599\n';
			cache.readOriginal
				.mockResolvedValueOnce(first)
				.mockResolvedValueOnce({
					text: selected,
					range: {
						hash,
						source: 'original',
						requested: { startLine: 2, endLine: 2 },
						returned: { startLine: 2, endLine: 2 },
						complete: true,
						hasMore: true,
					},
				})
				.mockResolvedValueOnce(first);
			const before = getTokenProxyRecoveryObservations();
			await readTokenProxyBlock(hash);
			await readTokenProxyBlock(hash, { startLine: 2, endLine: 2 });
			await readTokenProxyBlock(hash);
			expect(getTokenProxyRecoveryObservations()).toEqual({
				invocations: 3,
				rangedInvocations: 1,
				recoveredOriginals: 3,
				unavailableBlocks: 0,
				missingOriginals: 0,
				failedReads: 0,
				returnedOriginalBytes:
					Buffer.byteLength(first, 'utf8') * 2 + Buffer.byteLength(selected, 'utf8'),
				returnedOriginalTokenEstimate:
					Math.ceil(first.length / 4) * 2 + Math.ceil(selected.length / 4),
				scope: 'process-lifetime',
				coverage: 'canonical-block-reader',
				tokenCountKind: 'character-estimate',
				cliInvocations: null,
				modelExposure: 'unknown',
				unobservedRetrievals: 'unknown',
				saturated: false,
			});
			expect(before.invocations).toBe(0);
			expect(cache.write).not.toHaveBeenCalled();
		});

		it('counts an empty or past-EOF excerpt as a successful zero-volume read', async () => {
			cache.readOriginal.mockResolvedValueOnce({
				text: '',
				range: {
					hash,
					source: 'original',
					requested: { startLine: 99, endLine: 100 },
					returned: null,
					complete: false,
					hasMore: false,
				},
			});
			await readTokenProxyBlock(hash, { startLine: 99, endLine: 100 });
			await readTokenProxyBlock(hash);
			expect(getTokenProxyRecoveryObservations()).toMatchObject({
				invocations: 2,
				rangedInvocations: 1,
				recoveredOriginals: 2,
				returnedOriginalBytes: 0,
				returnedOriginalTokenEstimate: 0,
				missingOriginals: 0,
			});
		});

		it('distinguishes missing verdicts, missing originals and failures without counting unavailable bytes', async () => {
			cache.read.mockResolvedValueOnce(null).mockResolvedValueOnce({ outcome: 'kept' });
			await readTokenProxyBlock(hash);
			await readTokenProxyBlock(hash);
			cache.readOriginal.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
			await readTokenProxyBlock(hash);
			await readTokenProxyBlock(hash, { startLine: 1, endLine: 2 });
			const readFailure = new Error('archive read failed');
			cache.readOriginal.mockRejectedValueOnce(readFailure);
			await expect(readTokenProxyBlock(hash)).rejects.toBe(readFailure);
			const verdictFailure = new Error('verdict read failed');
			cache.read.mockRejectedValueOnce(verdictFailure);
			await expect(readTokenProxyBlock(hash)).rejects.toBe(verdictFailure);
			expect(getTokenProxyRecoveryObservations()).toMatchObject({
				invocations: 6,
				rangedInvocations: 1,
				recoveredOriginals: 0,
				unavailableBlocks: 2,
				missingOriginals: 2,
				failedReads: 2,
				returnedOriginalBytes: 0,
				returnedOriginalTokenEstimate: 0,
			});
		});

		it('excludes rejected inputs and compression/history replays from actual retrieval counts', async () => {
			await expect(readTokenProxyBlock('bad hash')).rejects.toThrow('SHA-256');
			await expect(readTokenProxyBlock(hash, { startLine: 0, endLine: 2 })).rejects.toThrow(
				'Original line range'
			);
			const { options } = await startWithCapturedOptions();
			compressor.compressRequestBody.mockResolvedValue({
				body: '{}',
				changed: false,
				blocks: [],
				stats: {},
			});
			await options.compress?.('anthropic-messages', '{}', { early: true });
			await options.compress?.('anthropic-messages', '{}', { early: true });
			expect(getTokenProxyRecoveryObservations()).toMatchObject({
				invocations: 0,
				recoveredOriginals: 0,
			});
			expect(cache.read).not.toHaveBeenCalled();
			expect(cache.readOriginal).not.toHaveBeenCalled();
		});

		it('saturates counters instead of overflowing and returns independent read-only snapshots', async () => {
			cache.readOriginal.mockResolvedValue('x');
			const byteLength = vi
				.spyOn(Buffer, 'byteLength')
				.mockReturnValueOnce(Number.MAX_SAFE_INTEGER);
			try {
				await readTokenProxyBlock(hash);
			} finally {
				byteLength.mockRestore();
			}
			await readTokenProxyBlock(hash);
			const snapshot = getTokenProxyRecoveryObservations();
			expect(snapshot).toMatchObject({
				invocations: 2,
				returnedOriginalBytes: Number.MAX_SAFE_INTEGER,
				saturated: true,
			});
			snapshot.invocations = 999;
			expect(getTokenProxyRecoveryObservations().invocations).toBe(2);
		});

		it('retains observations across listener stops and resets them only with the test reset', async () => {
			await readTokenProxyBlock(hash);
			await stopTokenProxy();
			expect(getTokenProxyRecoveryObservations().invocations).toBe(1);
			await resetTokenProxyForTests();
			expect(getTokenProxyRecoveryObservations()).toMatchObject({
				invocations: 0,
				rangedInvocations: 0,
				recoveredOriginals: 0,
				unavailableBlocks: 0,
				missingOriginals: 0,
				failedReads: 0,
				returnedOriginalBytes: 0,
				returnedOriginalTokenEstimate: 0,
				saturated: false,
			});
		});
	});
});
