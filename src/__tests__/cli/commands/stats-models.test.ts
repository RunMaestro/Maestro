/**
 * @file stats-models.test.ts
 * @description Tests for `maestro-cli stats models`: the request crosses the WS
 * bridge in the shape the desktop handler expects, the record is printed as a
 * person reads it (and whole as JSON), a range that is not one of the six is
 * refused before anything is sent, and a failure the app reports is not a
 * success.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { statsModels } from '../../../cli/commands/stats';
import { CommandTimeoutError, withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import {
	BUSY_MODEL_USAGE as BUSY,
	EMPTY_MODEL_USAGE as EMPTY,
} from '../../helpers/modelUsageFixtures';
import { busyProxyEffectiveness } from '../../helpers/proxyTelemetryFixtures';
import { TOKEN_PROXY_UNKNOWN_LABELS } from '../../../shared/local-models/token-proxy';
import {
	TOKEN_PROXY_PROVIDER_USAGE_NOTE,
	TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE,
} from '../../../shared/local-models/token-proxy-report';

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

describe('stats models command', () => {
	it('asks the app for the range and prints every block of the record', async () => {
		const captured = mockSend({ type: 'model_usage', success: true, data: BUSY });

		await statsModels({ range: 'quarter' });

		expect(captured.payload).toEqual({ type: 'get_model_usage', range: 'quarter' });
		expect(captured.responseType).toBe('model_usage');
		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/MODEL USAGE\s+.*quarter/);
		expect(output).toContain(
			'164 requests, 1.3M tokens in, 80.1K out, 25% on this machine, 3 errors'
		);

		// Sources: the split says which unit each count is in.
		expect(output).toMatch(
			/Maestro model server\s+.*Model server.*41 requests .*\(36 runs, 4 turns, 1 routed\).*45\.0K in, 3\.2K out.*1 error.*p50 240ms {2}p95 1\.2s/
		);
		expect(output).toContain('qwen3-coder, qwen3.5-4b');
		// A provider has no single-request latency: its turns are what was timed.
		expect(output).toMatch(
			/Claude Code\s+.*Provider cloud.*40 requests .*\(40 turns\).*p50 1\.5m {2}p95 10\.0m \(turns\)/
		);
		expect(output).toContain(
			'p50 and p95 marked (turns) are whole agent turns, not single requests'
		);
		expect(output).toMatch(
			/Jev \(TypeSafe cloud\)\s+.*System One.*83 requests .*2 errors.*p50 123ms {2}p95 410ms/
		);

		// Tasks, with where each ran.
		expect(output).toMatch(/Cue gate\s+83 runs\s+.*2 errors.*p50 123ms.*Jev \(TypeSafe cloud\) 83/);
		expect(output).toMatch(/Tab naming\s+36 runs\s+.*1 error\b.*Maestro model server 36/);

		// Only an agent that launched turns on another model is listed.
		expect(output).toMatch(
			/Alpha\s+4 turns\s+36\.0K in, 2\.8K out\s+.*qwen3-coder on Maestro model server 4/
		);
		expect(output).not.toMatch(/Beta/);

		// System One: the ledger's retention is said when the range outruns it.
		expect(output).toMatch(/System One\s+.*decisions are kept 30 days/);
		expect(output).toContain(
			'90 decisions (7 from the cache): 86 answered, 3 failed open, 1 failed closed, 2 timed out, $0.001900'
		);
		expect(output).toMatch(/Auto routing\s+17 turns: low 10, medium 5, high 2/);

		// The proxy's saving is an estimate, and the report says so.
		expect(output).toMatch(
			/All agents\s+12 requests, est\. tokens saved 10,000 \(25%\), average added latency 14 ms\n/
		);
		expect(output).toMatch(/Alpha\s+9 requests/);
		expect(output).toMatch(/No agent\s+3 requests, -/);
		expect(output).toContain('1 background request sent to a Local Models target');
		expect(output).toContain('Token counts are estimates at 4 characters per token.');
		// No dollar or quality result exists for it, and the record says so.
		expect(output).toContain(TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('reads the week when no range is named', async () => {
		const captured = mockSend({ type: 'model_usage', success: true, data: EMPTY });

		await statsModels({});

		expect(captured.payload).toEqual({ type: 'get_model_usage', range: 'week' });
	});

	it('says nothing ran, and where to look, for an empty range, and exits 0', async () => {
		mockSend({ type: 'model_usage', success: true, data: EMPTY });

		await statsModels({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toMatch(/MODEL USAGE\s+.*week/);
		expect(output).toContain('Nothing ran in this range.');
		expect(output).toContain('maestro-cli models status');
		expect(output).not.toMatch(/Sources|Tasks|System One|Token proxy/);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints the providers alone when no other model did anything', async () => {
		const provider = BUSY.sources[1];
		mockSend({
			type: 'model_usage',
			success: true,
			data: {
				...EMPTY,
				totals: { ...EMPTY.totals, requests: 40, tokensIn: 1_200_000, tokensOut: 76_000 },
				sources: [provider],
			},
		});

		await statsModels({});

		const output = logSpy.mock.calls[0][0] as string;
		expect(output).toContain(
			'40 requests, 1.2M tokens in, 76.0K out, 0% on this machine, 0 errors'
		);
		expect(output).toMatch(/Claude Code\s+.*40 requests/);
		expect(output).not.toMatch(/Tasks|Agents|System One|Token proxy/);
	});

	describe('the token proxy block of a current desktop', () => {
		const provider = {
			requests: 112,
			inputTokens: 1_200_000,
			cacheReadTokens: 4_100_000,
			cacheWriteTokens: 0,
			outputTokens: 61_000,
		};
		const none = {
			compressRequests: 0,
			originalTokens: 0,
			sentTokens: 0,
			tokensSaved: 0,
			avgAddedLatencyMs: 0,
			timedRequests: 0,
			provider: { ...provider, requests: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
		};
		const read = {
			compressRequests: 100,
			originalTokens: 400_000,
			sentTokens: 300_000,
			tokensSaved: 100_000,
			avgAddedLatencyMs: 14,
			timedRequests: 98,
			provider,
		};
		const CURRENT = {
			...BUSY,
			proxy: {
				routedRequests: 0,
				totals: { requests: 120, ...read },
				byAgent: [
					{ agentId: 'agent-alpha-0001', name: 'Alpha', requests: 100, ...read },
					{ agentId: null, name: null, requests: 20, ...none },
				],
				byMode: [
					{ effectiveMode: 'compress', requests: 100, ...read },
					{ effectiveMode: null, requests: 20, ...none },
				],
				byRoute: [
					{ route: 'anthropic', requests: 100, ...read },
					{ route: 'acme-gateway', requests: 20, ...none },
				],
				effectiveness: busyProxyEffectiveness(),
			},
		};

		it('says what the proxy did with the requests in the words `models proxy status` uses', async () => {
			mockSend({ type: 'model_usage', success: true, data: CURRENT });

			await statsModels({ range: 'month' });

			const output = logSpy.mock.calls[0][0] as string;
			expect(output).toMatch(
				/Requests\s+120 requests carried\. Of those: 100 read, 8 forwarded without the compressor's result/
			);
			expect(output).toMatch(
				/Blocks\s+90 of 100 read requests counted: 300 candidate blocks \(160 shortened/
			);
			expect(output).toMatch(
				/Processing time\s+p50 12ms, p95 80ms, p99 1\.2s over 98 timed requests/
			);
			expect(output).toMatch(/Algorithms\s+json 150 blocks in 40 requests/);
		});

		it('files a request with no recorded mode as not recorded, apart from the agents', async () => {
			mockSend({ type: 'model_usage', success: true, data: CURRENT });

			await statsModels({ range: 'month' });

			const output = logSpy.mock.calls[0][0] as string;
			const [agents, modes] = output.split('By mode (what each request was carried as):');
			expect(agents).toMatch(/Alpha\s+100 requests/);
			expect(modes).toMatch(/Compress tool results\s+100 requests, est\. tokens saved 100,000/);
			expect(modes).toContain(`${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']}  20 requests, -`);
		});

		it('prints each provider route as the Gateway names it, keeping a route it does not know', async () => {
			mockSend({ type: 'model_usage', success: true, data: CURRENT });

			await statsModels({ range: 'month' });

			const output = logSpy.mock.calls[0][0] as string;
			const routes = output.split('By provider route:')[1];
			expect(routes).toMatch(
				/Claude Code\s+100 requests, est\. tokens saved 100,000 \(25%\), average added latency 14 ms/
			);
			expect(routes).toContain('acme-gateway  20 requests, -');
		});

		it('prints the provider classes with their coverage, apart from the estimates', async () => {
			mockSend({ type: 'model_usage', success: true, data: CURRENT });

			await statsModels({ range: 'month' });

			const output = logSpy.mock.calls[0][0] as string;
			const [estimates, classes] = output.split('Provider usage');
			expect(estimates).toContain('est. tokens saved 100,000 (25%)');
			expect(classes).toContain(TOKEN_PROXY_PROVIDER_USAGE_NOTE);
			expect(classes).toMatch(/Input\s+1\.2M tokens on 100 of 120 requests\./);
			expect(classes).toMatch(/Cache write\s+0 tokens on 50 of 120 requests\./);
			expect(output).toContain(TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE);
		});

		it('leaves the originals read back to `models proxy status`: they belong to no range', async () => {
			mockSend({ type: 'model_usage', success: true, data: CURRENT });

			await statsModels({ range: 'month' });

			const output = logSpy.mock.calls[0][0] as string;
			expect(output).not.toContain('Original recovery');
			expect(output).not.toContain('Retrieve tool');
		});

		it('keeps the effectiveness whole in the JSON record', async () => {
			mockSend({ type: 'model_usage', success: true, data: CURRENT });

			await statsModels({ range: 'month', json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(parsed.proxy.effectiveness).toEqual(busyProxyEffectiveness());
			expect(parsed.proxy.byMode[1].effectiveMode).toBeNull();
			expect(parsed.proxy.byRoute.map((row: { route: string }) => row.route)).toEqual([
				'anthropic',
				'acme-gateway',
			]);
			expect(parsed.proxy.totals.timedRequests).toBe(98);
			expect(parsed.proxy).not.toHaveProperty('recovery');
		});
	});

	it('prints the whole record as JSON with --json', async () => {
		mockSend({ type: 'model_usage', success: true, data: BUSY });

		await statsModels({ range: 'quarter', json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(BUSY);
	});

	it('refuses a range that is not one of the six before anything is sent', async () => {
		await expect(statsModels({ range: 'fortnight' })).rejects.toThrow('__exit__');

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls[0][0]).toContain(
			'Invalid range "fortnight". Must be one of: day, week, month, quarter, year, all'
		);
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
	});

	it('reports a failure the app answered with, as JSON when asked', async () => {
		mockSend({ type: 'model_usage', success: false, error: 'Stats database is not ready' });

		await expect(statsModels({ json: true })).rejects.toThrow('__exit__');

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			error: 'Stats database is not ready',
		});
		expect(errorSpy).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});

	it('exits with the bridge code when the app does not answer in time', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new CommandTimeoutError('model_usage'));

		await expect(statsModels({})).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.Timeout);
	});
});
