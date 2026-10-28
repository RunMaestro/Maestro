/**
 * @file models-proxy.test.ts
 * @description Tests for `maestro-cli models proxy status` and `models proxy
 * block`: each request crosses the WS bridge in the shape the desktop handler
 * expects, the report and a block are printed as a person reads them (and
 * whole as JSON), and the exit code is non-zero only for a proxy that could
 * not start or a block the cache does not hold.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { modelsProxyBlock, modelsProxyStatus } from '../../../cli/commands/models-proxy';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type {
	TokenProxyBlockDetail,
	TokenProxyReport,
} from '../../../shared/local-models/token-proxy';
import { formatError } from '../../../cli/output/formatter';

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(reply);
			}),
		} as never)
	);
	return captured;
}

const HASH = 'a'.repeat(64);

const RUNNING: TokenProxyReport = {
	status: {
		port: 48123,
		running: true,
		agentIds: ['agent-1'],
		lastError: null,
		gatewayUrls: {
			anthropic: 'http://127.0.0.1:48123/anthropic',
			openai: 'http://127.0.0.1:48123/openai/v1',
			chatgpt: 'http://127.0.0.1:48123/chatgpt',
		},
	},
	agents: [
		{
			id: 'agent-1',
			name: 'Alpha',
			toolType: 'claude-code',
			mode: 'compress',
			gatewayUrl: 'http://127.0.0.1:48123/anthropic',
		},
	],
	usage: {
		range: 'month',
		totals: {
			requests: 12,
			compressRequests: 5,
			originalTokens: 40000,
			sentTokens: 30000,
			tokensSaved: 10000,
			avgAddedLatencyMs: 14,
		},
		byAgent: [
			{
				agentId: 'agent-1',
				requests: 9,
				compressRequests: 5,
				originalTokens: 40000,
				sentTokens: 30000,
				tokensSaved: 10000,
				avgAddedLatencyMs: 14,
			},
			{
				agentId: null,
				requests: 3,
				compressRequests: 0,
				originalTokens: 0,
				sentTokens: 0,
				tokensSaved: 0,
				avgAddedLatencyMs: 0,
			},
		],
	},
	recentCompressions: [
		{
			hash: HASH,
			originalTokens: 2400,
			compressedTokens: 300,
			compressors: ['logs'],
			agentId: 'agent-1',
			at: Date.now() - 60_000,
		},
	],
};

const NOT_SET_UP: TokenProxyReport = {
	status: { port: null, running: false, agentIds: [], lastError: null, gatewayUrls: null },
	agents: [],
	usage: null,
	recentCompressions: [],
};

const BLOCK: TokenProxyBlockDetail = {
	hash: HASH,
	original: 'line one\nline two\nline two\nline two\n',
	compressed: 'line one\nline two\n[maestro: 2 more identical lines]\n',
	originalTokens: 2400,
	compressedTokens: 300,
	compressors: ['logs'],
	createdAt: Date.now() - 60_000,
};

let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

describe('models proxy status command', () => {
	it('asks the app for the report and prints the listener, agents, usage, and compressions', async () => {
		const captured = mockSend({ success: true, report: RUNNING });

		await modelsProxyStatus({});

		expect(captured.payload).toEqual({ type: 'local_models_proxy_status' });
		expect(captured.responseType).toBe('local_models_proxy_status_result');
		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/TOKEN PROXY/);
		expect(output).toMatch(/listening on 127\.0\.0\.1:48123/);
		expect(output).toMatch(/Alpha\s+compress\s+.*http:\/\/127\.0\.0\.1:48123\/anthropic/);
		expect(output).toMatch(/All agents\s+12 requests, 10000 tokens saved \(25%\), 14 ms average/);
		// A request with no agent was only counted.
		expect(output).toMatch(/No agent\s+3 requests, -/);
		// A saving is an estimate, and the report says which way it is off.
		expect(output).toContain('Token counts are estimates at 4 characters per token.');
		expect(output).toContain(`${HASH}  2400 -> 300 tokens`);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('says how to turn it on when it has never been set up, and exits 0', async () => {
		mockSend({ success: true, report: NOT_SET_UP });

		await modelsProxyStatus({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/not set up/);
		expect(output).toMatch(/maestro-cli update-agent <agent> --proxy-mode passthrough/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('treats a stopped proxy as healthy: nothing points at it', async () => {
		mockSend({
			success: true,
			report: {
				...NOT_SET_UP,
				status: { ...NOT_SET_UP.status, port: 48123 },
				usage: { range: 'month', totals: { ...RUNNING.usage!.totals, requests: 0 }, byAgent: [] },
			},
		});

		await modelsProxyStatus({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/stopped \(port 48123\)/);
		expect(output).toMatch(/No agent points at the proxy/);
		expect(output).toMatch(/No requests/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('exits non-zero when the proxy could not start, showing why', async () => {
		mockSend({
			success: true,
			report: {
				...RUNNING,
				status: {
					...RUNNING.status,
					running: false,
					lastError: 'another program is using 127.0.0.1:48123',
				},
			},
		});

		await expect(modelsProxyStatus({})).rejects.toThrow('__exit__');

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/could not start on 127\.0\.0\.1:48123/);
		expect(output).toMatch(/another program is using/);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('prints the whole report as JSON', async () => {
		mockSend({ success: true, report: RUNNING });

		await modelsProxyStatus({ json: true });

		const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
		expect(parsed.success).toBe(true);
		expect(parsed.status.port).toBe(48123);
		expect(parsed.agents[0]).toMatchObject({ id: 'agent-1', mode: 'compress' });
		expect(parsed.usage.totals.tokensSaved).toBe(10000);
		expect(parsed.recentCompressions[0].hash).toBe(HASH);
	});

	it('reports an app error, and a bridge that cannot be reached', async () => {
		mockSend({ success: false, error: 'stats database is closed' });
		await expect(modelsProxyStatus({ json: true })).rejects.toThrow('__exit__');
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			error: 'stats database is closed',
		});

		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));
		await expect(modelsProxyStatus({})).rejects.toThrow('__exit__');
		expect(errorSpy).toHaveBeenCalledWith(formatError('Maestro desktop app is not running'));
	});
});

describe('models proxy block command', () => {
	it('asks the app for the block by hash and prints a diff of both sides', async () => {
		const captured = mockSend({ success: true, block: BLOCK });

		await modelsProxyBlock(` ${HASH.toUpperCase()} `, {});

		// The hash is normalized here; the app checks it before it is a path.
		expect(captured.payload).toEqual({ type: 'local_models_proxy_block', hash: HASH });
		expect(captured.responseType).toBe('local_models_proxy_block_result');
		const header = logSpy.mock.calls[0][0] as string;
		expect(header).toMatch(/COMPRESSED BLOCK/);
		expect(header).toContain(HASH);
		expect(header).toMatch(/2400 -> 300 tokens/);
		const patch = logSpy.mock.calls[1][0] as string;
		expect(patch).toContain('-line two');
		expect(patch).toContain('+[maestro: 2 more identical lines]');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints one side alone with --original or --compressed', async () => {
		mockSend({ success: true, block: BLOCK });

		await modelsProxyBlock(HASH, { original: true });
		expect(logSpy.mock.calls[0][0]).toBe(BLOCK.original);

		logSpy.mockClear();
		await modelsProxyBlock(HASH, { compressed: true });
		expect(logSpy.mock.calls[0][0]).toBe(BLOCK.compressed);
	});

	it('refuses both flags together before it reaches the app', async () => {
		mockSend({ success: true, block: BLOCK });

		await expect(modelsProxyBlock(HASH, { original: true, compressed: true })).rejects.toThrow(
			'__exit__'
		);

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
	});

	it('prints the block as JSON', async () => {
		mockSend({ success: true, block: BLOCK });

		await modelsProxyBlock(HASH, { json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({ success: true, block: BLOCK });
	});

	it('exits non-zero for a hash the cache holds no compressed block for', async () => {
		mockSend({ success: true, block: null });

		await expect(modelsProxyBlock(HASH, {})).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith(
			formatError(`The proxy cache holds no compressed block for ${HASH}.`)
		);
	});

	it('says so when the original is gone, and still prints what was sent', async () => {
		mockSend({ success: true, block: { ...BLOCK, original: null } });

		await expect(modelsProxyBlock(HASH, {})).rejects.toThrow('__exit__');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no longer in the cache'));

		await modelsProxyBlock(HASH, { compressed: true });
		expect(logSpy.mock.calls[0][0]).toBe(BLOCK.compressed);
	});

	it('reports a value the app refused as not a hash', async () => {
		mockSend({ success: false, error: 'A compressed block is named by its SHA-256 hash' });

		await expect(modelsProxyBlock('nope', {})).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SHA-256 hash'));
	});
});
