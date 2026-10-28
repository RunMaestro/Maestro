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
	applyAgentGatewayToSpawn,
	configureTokenProxy,
	ensureTokenProxyForGateway,
	ensureTokenProxyPort,
	getTokenProxyReport,
	getTokenProxyStatus,
	readTokenProxyBlock,
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

	it('refuses a value that is not a hash before it reaches the cache', async () => {
		for (const value of ['../../etc/passwd', 'ABC', '', undefined, 12]) {
			await expect(readTokenProxyBlock(value)).rejects.toThrow('SHA-256');
		}
		expect(cache.read).not.toHaveBeenCalled();
	});
});
