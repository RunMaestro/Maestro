/**
 * @file models-proxy.test.ts
 * @description Tests for `maestro-cli models proxy status` and `models proxy
 * block`: each request crosses the WS bridge in the shape the desktop handler
 * expects, the report and a block are printed as a person reads them (and
 * whole as JSON). Bounded original recovery preserves exact text and reports
 * completeness; invalid ranges, missing originals and unsupported desktops fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	modelsProxyBlock,
	modelsProxyCache,
	modelsProxyStatus,
} from '../../../cli/commands/models-proxy';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type {
	TokenProxyBlockDetail,
	TokenProxyReport,
} from '../../../shared/local-models/token-proxy';
import { TOKEN_PROXY_OPPORTUNITY_NOTE } from '../../../shared/local-models/token-proxy';
import {
	TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE,
	TOKEN_PROXY_UNKNOWN_LABELS,
} from '../../../shared/local-models/token-proxy';
import {
	TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE,
	TOKEN_PROXY_PROVIDER_USAGE_NOTE,
	TOKEN_PROXY_RECOVERY_HEADING,
	TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE,
	TOKEN_PROXY_TREND_NOTE,
} from '../../../shared/local-models/token-proxy-report';
import { formatError, formatTokenProxyOpportunities } from '../../../cli/output/formatter';
import {
	busyProxyEffectiveness,
	readOpportunities,
	recoveryObservations,
} from '../../helpers/proxyTelemetryFixtures';

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
			timedRequests: 5,
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
				timedRequests: 5,
			},
			{
				agentId: null,
				requests: 3,
				compressRequests: 0,
				originalTokens: 0,
				sentTokens: 0,
				tokensSaved: 0,
				avgAddedLatencyMs: 0,
				timedRequests: 0,
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

const OPPORTUNITIES = readOpportunities();

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

const RANGED_BLOCK: TokenProxyBlockDetail = {
	...BLOCK,
	original: 'خط دو\r\n三',
	originalRange: {
		hash: HASH,
		source: 'original',
		requested: { startLine: 2, endLine: 3 },
		returned: { startLine: 2, endLine: 3 },
		complete: true,
		hasMore: true,
	},
};

let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;
let writeSpy: MockInstance;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => vi.restoreAllMocks());

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
		expect(output).toMatch(
			/All agents\s+12 requests, est\. tokens saved 10,000 \(25%\), average added latency 14 ms\n/
		);
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
	describe('read opportunities', () => {
		it('prints what the proxy could have shortened, apart from what it removed', async () => {
			mockSend({ success: true, report: { ...RUNNING, readOpportunities: OPPORTUNITIES } });

			await modelsProxyStatus({});

			const output = logSpy.mock.calls[0][0] as string;
			const [realized, potential] = output.split('Read opportunities');
			// What the proxy removed is printed first, and the block that follows is not part of it.
			expect(realized).toMatch(/est\. tokens saved 10,000 \(25%\)/);
			expect(potential).toContain('observation only: none of this was applied');
			expect(potential).toMatch(/412 requests examined, 38 with a read among their newest results/);
			expect(potential).toContain('Passthrough requests are not read.');
			expect(potential).toContain(
				'Not examined: 2 an earlier request was still being examined; 1 the body is past the examination limit'
			);
			expect(potential).toContain(
				'Newest reads: 41 examined: 20 first, 9 identical re-reads, 4 changed re-reads, 8 not comparable (outside-workspace 5, partial-range 3)'
			);
			expect(potential).toContain(
				'Re-read previews: 9 unchanged, 3 delta, 1 refused (insufficient-reduction 1); potential reduction 4,200 tokens'
			);
			expect(potential).toContain(
				'Source outlines: 11 outlined, 2 refused (parse-error 2); potential reduction 31,000 tokens'
			);
			expect(potential).toContain(TOKEN_PROXY_OPPORTUNITY_NOTE);
			expect(potential).toContain('Not available: tab, native-session, subagent, window.');
			expect(potential).toMatch(
				/Unchanged re-read\s+\/work\/app\/src\/a\.ts\s+sha 3fa2c1d9e0b1\s+1200 -> 40 tokens \(potential\)\s+whole, /
			);
			// No figure is labelled as a saving. Only the note names the phrase, to rule it out.
			const figures = potential
				.split('\n')
				.filter((line) => !line.includes(TOKEN_PROXY_OPPORTUNITY_NOTE));
			expect(figures.join('\n')).not.toMatch(/tokens saved/);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('prints nothing about them for a desktop that predates them', async () => {
			mockSend({ success: true, report: RUNNING });

			await modelsProxyStatus({});

			expect(logSpy.mock.calls[0][0] as string).not.toContain('Read opportunities');
		});

		it('prints nothing about them while the proxy has never been set up', async () => {
			mockSend({ success: true, report: { ...NOT_SET_UP, readOpportunities: OPPORTUNITIES } });

			await modelsProxyStatus({});

			expect(logSpy.mock.calls[0][0] as string).not.toContain('Read opportunities');
		});

		it('keeps them whole in the JSON report, as a field apart from the usage', async () => {
			mockSend({ success: true, report: { ...RUNNING, readOpportunities: OPPORTUNITIES } });

			await modelsProxyStatus({ json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(parsed.readOpportunities).toEqual(OPPORTUNITIES);
			expect(parsed.readOpportunities).toMatchObject({ mode: 'observation', realized: false });
			expect(parsed.usage.totals.tokensSaved).toBe(10000);
			expect(JSON.stringify(parsed.usage)).not.toContain('potential');
		});

		it('says so when nothing was examined and nothing was skipped', () => {
			const lines = formatTokenProxyOpportunities({
				...OPPORTUNITIES,
				coverage: {
					...OPPORTUNITIES.coverage,
					observed: 1,
					withReads: 0,
					skipped: { ...OPPORTUNITIES.coverage.skipped, busy: 0, 'too-large': 0 },
				},
				recent: [],
			}).join('\n');

			expect(lines).toMatch(/1 request examined, 0 with a read/);
			expect(lines).not.toContain('Not examined');
			expect(lines).not.toContain('Recent previews');
		});

		it('says when a work bound left older reads unexamined', () => {
			const lines = formatTokenProxyOpportunities({
				...OPPORTUNITIES,
				coverage: { ...OPPORTUNITIES.coverage, incomplete: 2 },
			}).join('\n');

			expect(lines).toContain('2 requests hit a work bound; older reads went unexamined.');
		});
	});

	describe('effectiveness', () => {
		const NO_PROVIDER = {
			requests: 0,
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			outputTokens: 0,
		};
		const group = (overrides: Record<string, unknown>) => ({
			requests: 0,
			compressRequests: 0,
			originalTokens: 0,
			sentTokens: 0,
			tokensSaved: 0,
			avgAddedLatencyMs: 0,
			timedRequests: 0,
			provider: NO_PROVIDER,
			...overrides,
		});
		const BUSY: TokenProxyReport = {
			...RUNNING,
			usage: {
				range: 'month',
				totals: group({
					requests: 120,
					compressRequests: 100,
					originalTokens: 400_000,
					sentTokens: 300_000,
					tokensSaved: 100_000,
					avgAddedLatencyMs: 14,
					timedRequests: 98,
					provider: {
						requests: 112,
						inputTokens: 1_200_000,
						cacheReadTokens: 4_100_000,
						cacheWriteTokens: 0,
						outputTokens: 61_000,
					},
				}),
				byAgent: [
					group({
						agentId: 'agent-1',
						requests: 100,
						compressRequests: 100,
						originalTokens: 400_000,
						sentTokens: 300_000,
						tokensSaved: 100_000,
						avgAddedLatencyMs: 14,
						timedRequests: 98,
					}),
					group({ agentId: null, requests: 20 }),
				],
				byMode: [
					group({
						effectiveMode: 'compress',
						requests: 70,
						compressRequests: 70,
						originalTokens: 280_000,
						sentTokens: 210_000,
						tokensSaved: 70_000,
						avgAddedLatencyMs: 12,
						timedRequests: 68,
					}),
					group({
						effectiveMode: 'compress-early',
						requests: 30,
						compressRequests: 30,
						originalTokens: 120_000,
						sentTokens: 90_000,
						tokensSaved: 30_000,
						avgAddedLatencyMs: 0,
						timedRequests: 30,
					}),
					group({ effectiveMode: null, requests: 20, compressRequests: 0 }),
				],
				byRoute: [
					group({
						route: 'anthropic',
						requests: 95,
						compressRequests: 95,
						originalTokens: 380_000,
						sentTokens: 285_000,
						tokensSaved: 95_000,
						avgAddedLatencyMs: 14,
						timedRequests: 93,
					}),
					group({
						route: 'openai',
						requests: 5,
						compressRequests: 5,
						originalTokens: 20_000,
						sentTokens: 15_000,
						tokensSaved: 5_000,
						avgAddedLatencyMs: 0,
						timedRequests: 0,
					}),
					group({ route: 'acme-gateway', requests: 20, compressRequests: 0 }),
				],
				effectiveness: busyProxyEffectiveness(),
			},
		} as TokenProxyReport;

		async function printed(report: TokenProxyReport): Promise<string> {
			mockSend({ success: true, report });
			await modelsProxyStatus({});
			return logSpy.mock.calls.at(-1)?.[0] as string;
		}

		it('prints what the proxy did with the requests, each count with its coverage', async () => {
			const output = await printed(BUSY);

			expect(output).toMatch(
				/Requests\s+120 requests carried\. Of those: 100 read, 8 forwarded without the compressor's result, 60 with a block shortened \(210 blocks\)/
			);
			expect(output).toMatch(
				/Blocks\s+90 of 100 read requests counted: 300 candidate blocks \(160 shortened, 50 kept whole, 80 under the size threshold, 10 left alone because the cache failed\)/
			);
			// Maestro's own cache is not the provider's, and the line says so.
			expect(output).toContain(
				"40 verdicts reused from Maestro's compression cache (not the provider's prompt cache)"
			);
			expect(output).toMatch(/Set aside\s+120 recent or at a cache breakpoint, 3 failed results/);
			expect(output).toMatch(
				/Skipped\s+5 a body that is not UTF-8 text; 3 decoding or compressing failed/
			);
			expect(output).toMatch(
				/Processing time\s+p50 12ms, p95 80ms, p99 1\.2s over 98 timed requests; 2 read requests without a time/
			);
			// The algorithms overlap, and the unique count is a subtotal said against the range's.
			expect(output).toContain(
				'200 unique blocks in the requests that recorded their algorithms, out of 210 shortened in the range; a block that two algorithms shortened is listed under each, so the lists do not add up'
			);
			// Three kinds of figure are on the screen and the report says they are never added.
			expect(output).toContain(TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('says the time against the sample of each group, never an unmeasured 0 ms', async () => {
			const output = await printed({
				...BUSY,
				usage: {
					...BUSY.usage!,
					totals: { ...BUSY.usage!.totals, avgAddedLatencyMs: 0, timedRequests: 1 },
					byAgent: [
						{ ...BUSY.usage!.byAgent[0], avgAddedLatencyMs: 0, timedRequests: 0 },
						{
							...BUSY.usage!.byAgent[0],
							agentId: 'agent-2',
							avgAddedLatencyMs: 0,
							timedRequests: 1,
						},
						{
							...BUSY.usage!.byAgent[0],
							agentId: 'agent-3',
							avgAddedLatencyMs: 14,
							timedRequests: undefined,
						},
					],
				},
			});

			expect(output).toMatch(/All agents\s+120 requests, .*average added latency 0 ms\n/);
			expect(output).toMatch(/Alpha\s+100 requests, .*average added latency unknown\n/);
			expect(output).toMatch(/agent-2\s+100 requests, .*average added latency 0 ms\n/);
			// An older desktop sent a mean and not its sample.
			expect(output).toMatch(
				/agent-3\s+100 requests, .*average added latency 14 ms \(sample unknown\)\n/
			);
		});

		it('prints each mode apart from the agents, and a historical request as not recorded', async () => {
			const output = await printed(BUSY);

			const [agents, modes] = output.split('By mode (what each request was carried as):');
			expect(agents).toMatch(/Alpha\s+100 requests/);
			expect(agents).not.toContain('Compress early');
			expect(modes).toMatch(
				/Compress tool results\s+70 requests, est\. tokens saved 70,000 \(25%\), average added latency 12 ms/
			);
			// A measured zero in one mode is still a measurement.
			expect(modes).toMatch(
				/Compress early\s+30 requests, est\. tokens saved 30,000 \(25%\), average added latency 0 ms/
			);
			// A request that predates the field is not filed under the agent's setting today.
			expect(modes).toContain(`${TOKEN_PROXY_UNKNOWN_LABELS['not-recorded']}  20 requests, -`);
		});

		it('prints each provider route apart from the agents and modes, keeping a route it does not know', async () => {
			const output = await printed(BUSY);

			const routes = output.split('By provider route:')[1];
			// The route is named as the Gateway names it.
			expect(routes).toMatch(
				/Claude Code\s+95 requests, est\. tokens saved 95,000 \(25%\), average added latency 14 ms\n/
			);
			// A route whose requests carry no time is unknown, not 0 ms.
			expect(routes).toMatch(
				/Codex with an OpenAI API key\s+5 requests, est\. tokens saved 5,000 \(25%\), average added latency unknown\n/
			);
			// A route another build stored stays as it was stored, and is only counted.
			expect(routes).toContain('acme-gateway  20 requests, -');
			// The cut sits after the modes, and each cut holds the same requests.
			expect(output.indexOf('By provider route:')).toBeGreaterThan(
				output.indexOf('By mode (what each request was carried as):')
			);
		});

		it('prints no route cut for a desktop that sent none', async () => {
			const output = await printed({
				...BUSY,
				usage: { ...BUSY.usage!, byRoute: undefined },
			});

			expect(output).not.toContain('By provider route:');
			expect(output).toContain('By mode (what each request was carried as):');
		});

		it('lists the latest days of the range, each with its estimate, and says the rest are in the JSON', async () => {
			const day = (date: string, requests: number, compressRequests: number) => ({
				date,
				requests,
				compressRequests,
				originalTokens: compressRequests * 4_000,
				sentTokens: compressRequests * 3_000,
				blocksShortened: compressRequests,
			});
			const trend = Array.from({ length: 9 }, (_, index) =>
				day(`2026-11-0${index + 1}`, 10 + index, index === 8 ? 0 : 4)
			);
			const output = await printed({
				...BUSY,
				usage: { ...BUSY.usage!, effectiveness: { ...busyProxyEffectiveness(), trend } },
			});

			const days = output.split('Recent days')[1].split('Provider usage')[0];
			expect(days).toContain(TOKEN_PROXY_TREND_NOTE);
			// The latest seven, oldest first; the two before them are in the JSON record.
			expect(days).not.toContain('2026-11-01');
			expect(days).not.toContain('2026-11-02');
			expect(days).toMatch(
				/2026-11-03\s+12 requests, 4 read, est\. tokens saved 4,000 \(25%\), 4 blocks shortened/
			);
			// A day with nothing read has no estimate to show.
			expect(days).toMatch(/2026-11-09\s+18 requests, none read\n/);
			expect(days.indexOf('2026-11-03')).toBeLessThan(days.indexOf('2026-11-09'));
			expect(days).toContain('2 earlier days in the JSON record (--json)');
		});

		it('prints no days when the range has none, and no note about earlier ones for a short range', async () => {
			expect(await printed(BUSY)).not.toContain('Recent days');

			const output = await printed({
				...BUSY,
				usage: {
					...BUSY.usage!,
					effectiveness: {
						...busyProxyEffectiveness(),
						trend: [
							{
								date: '2026-11-12',
								requests: 3,
								compressRequests: 3,
								originalTokens: 12_000,
								sentTokens: 9_000,
								blocksShortened: 2,
							},
						],
					},
				},
			});
			expect(output).toMatch(/2026-11-12\s+3 requests, 3 read, est\. tokens saved 3,000 \(25%\)/);
			expect(output).not.toContain('earlier day');
		});

		it('prints the provider classes apart from the estimates, with the coverage of each', async () => {
			const output = await printed(BUSY);

			const [estimates, provider] = output.split('Provider usage');
			expect(estimates).toContain('est. tokens saved 100,000 (25%)');
			expect(provider).toContain(TOKEN_PROXY_PROVIDER_USAGE_NOTE);
			expect(provider).toMatch(
				/Input\s+1\.2M tokens on 100 of 120 requests\. Other requests: 12 not reported in the answer \(unknown, not zero\); 8 recorded before reporting was tracked \(unknown\)/
			);
			expect(provider).toMatch(
				/Cache write\s+0 tokens on 50 of 120 requests\. Other requests: 50 not a class this provider has \(zero by definition\)/
			);
			expect(provider).toMatch(/Output\s+61\.0K tokens on 112 of 120 requests/);
			// The old line summed stored numbers, defaults included. It is gone.
			expect(output).not.toContain('Provider counted');
		});

		it('says no dollar or quality result exists, whatever the desktop sent', async () => {
			expect(await printed(BUSY)).toContain(TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE);
			expect(await printed(RUNNING)).toContain(TOKEN_PROXY_RESULTS_NOT_EVALUATED_NOTE);
		});

		it('prints the older desktop shape as stored sums of unknown provenance, not as provider counts', async () => {
			const output = await printed({
				...RUNNING,
				usage: {
					...RUNNING.usage!,
					totals: {
						...RUNNING.usage!.totals,
						timedRequests: undefined,
						provider: {
							requests: 12,
							inputTokens: 4_000,
							cacheReadTokens: 120_000,
							cacheWriteTokens: 0,
							outputTokens: 600,
						},
					},
				},
			});

			expect(output).toMatch(
				/All agents\s+12 requests, .*average added latency 14 ms \(sample unknown\)/
			);
			expect(output).not.toContain('By mode');
			expect(output).not.toContain(TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE);
			// The sums sit under the note for sums. The note for classes would promote
			// them to reported or derived counts, and it is not printed.
			const provider = output.split('Provider usage')[1];
			expect(provider).toContain(TOKEN_PROXY_PROVIDER_STORED_SUMS_NOTE);
			expect(output).not.toContain(TOKEN_PROXY_PROVIDER_USAGE_NOTE);
			expect(provider).toMatch(
				/Stored sums\s+unknown provenance and coverage for each class, over 12 requests with usage: input 4\.0K, cache read 120\.0K, cache write 0, output 600/
			);
			expect(output).not.toContain('Provider counted');
		});

		it('keeps the whole record in the JSON report, with the unknowns as unknowns', async () => {
			mockSend({ success: true, report: BUSY });

			await modelsProxyStatus({ json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(parsed.usage.effectiveness).toEqual(busyProxyEffectiveness());
			expect(
				parsed.usage.byMode.map((row: { effectiveMode: unknown }) => row.effectiveMode)
			).toEqual(['compress', 'compress-early', null]);
			expect(parsed.usage.byMode[2].timedRequests).toBe(0);
			expect(parsed.usage.totals.timedRequests).toBe(98);
			// The stored route text survives untouched, an unknown one included.
			expect(parsed.usage.byRoute.map((row: { route: string }) => row.route)).toEqual([
				'anthropic',
				'openai',
				'acme-gateway',
			]);
			expect(parsed.usage.byRoute[1].timedRequests).toBe(0);
		});
	});

	describe('original recovery', () => {
		const READ = {
			mcpRetrieveTool: {
				invocations: 3,
				rangedInvocations: 3,
				recoveredOriginals: 2,
				missingOriginals: 1,
				returnedOriginalBytes: 18_432,
				returnedOriginalTokenEstimate: 4_608,
			},
			otherReads: {
				invocations: 1,
				recoveredOriginals: 1,
				returnedOriginalBytes: 2_048,
				returnedOriginalTokenEstimate: 512,
			},
		};

		async function printed(report: TokenProxyReport): Promise<string> {
			mockSend({ success: true, report });
			await modelsProxyStatus({});
			return logSpy.mock.calls.at(-1)?.[0] as string;
		}

		it('prints the retrieve tool apart from other reads, and apart from the range', async () => {
			const output = await printed({ ...RUNNING, recovery: recoveryObservations(READ) });

			const [range, recovery] = output.split(TOKEN_PROXY_RECOVERY_HEADING);
			expect(recovery).toMatch(
				/Retrieve tool\s+3 calls: 2 returned original text \(18\.0 KB, about 4\.6K tokens, an estimate\); 1 found the original no longer stored/
			);
			expect(recovery).toMatch(
				/Other reads\s+1 read: 1 returned original text \(2\.0 KB, about 512 tokens, an estimate\); the actor is unknown/
			);
			expect(recovery).toMatch(/Not known\s+whether a model read a returned original/);
			expect(recovery).toMatch(
				/Net saving\s+not evaluated\. A return is not subtracted from the tokens saved/
			);
			// The range above says nothing of it, and the saving there is as it was.
			expect(range).not.toContain('18.0 KB');
			expect(range).toMatch(/est\. tokens saved 10,000 \(25%\)/);
		});

		it('changes nothing above itself: the range prints the same with and without it', async () => {
			const without = await printed(RUNNING);
			const withRecovery = await printed({ ...RUNNING, recovery: recoveryObservations(READ) });

			expect(withRecovery.startsWith(without)).toBe(true);
			expect(withRecovery.length).toBeGreaterThan(without.length);
		});

		it('says in one line that nothing was read back', async () => {
			const output = await printed({ ...RUNNING, recovery: recoveryObservations() });

			expect(output).toMatch(
				/Original recovery\s+none read back since the app started; reads outside this app are not counted/
			);
			expect(output).not.toContain('Retrieve tool');
		});

		it('prints nothing about it for a desktop that predates it', async () => {
			const output = await printed(RUNNING);

			expect(output).not.toContain('Original recovery');
			expect(output).not.toContain('Retrieve tool');
		});

		it('says when a counter reached its limit', async () => {
			const output = await printed({ ...RUNNING, recovery: recoveryObservations(READ, true) });

			expect(output).toContain(
				'a counter reached its largest value, so these figures are lower bounds'
			);
		});

		it('keeps it whole in the JSON report, as a field apart from the usage', async () => {
			const recovery = recoveryObservations(READ);
			mockSend({ success: true, report: { ...RUNNING, recovery } });

			await modelsProxyStatus({ json: true });

			const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(parsed.recovery).toEqual(recovery);
			expect(parsed.recovery).toMatchObject({
				scope: 'process-lifetime',
				modelExposure: 'unknown',
				unobservedRetrievals: 'unknown',
				byCaller: { mcpRetrieveTool: { invocations: 3 }, otherReads: { invocations: 1 } },
			});
			expect(JSON.stringify(parsed.usage)).not.toContain('returnedOriginalBytes');
			expect(parsed.usage.totals.tokensSaved).toBe(10000);
		});
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

	it('sends typed inclusive bounds and prints exact ranged text with metadata on stderr', async () => {
		const captured = mockSend({ success: true, block: RANGED_BLOCK });

		await modelsProxyBlock(` ${HASH.toUpperCase()} `, { original: true, lines: '2:3' });

		expect(captured.payload).toEqual({
			type: 'local_models_proxy_block',
			hash: HASH,
			range: { startLine: 2, endLine: 3 },
		});
		expect(captured.responseType).toBe('local_models_proxy_block_result');
		expect(writeSpy).toHaveBeenCalledExactlyOnceWith('خط دو\r\n三');
		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
			`Original ${HASH}: requested 2:3; returned 2:3; complete=true; hasMore=true`
		);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('preserves a single blank original line without adding a terminator', async () => {
		mockSend({
			success: true,
			block: {
				...RANGED_BLOCK,
				original: '\n',
				originalRange: {
					...RANGED_BLOCK.originalRange!,
					requested: { startLine: 2, endLine: 2 },
					returned: { startLine: 2, endLine: 2 },
				},
			},
		});

		await modelsProxyBlock(HASH, { original: true, lines: '2:2' });

		expect(writeSpy).toHaveBeenCalledExactlyOnceWith('\n');
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('returned 2:2; complete=true'));
	});

	it('keeps the JSON block envelope, provenance, completeness and whole-block totals', async () => {
		mockSend({ success: true, block: RANGED_BLOCK });

		await modelsProxyBlock(HASH, { original: true, lines: '2:3', json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			block: RANGED_BLOCK,
		});
		expect(writeSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it.each([
		{ text: 'last\n', returned: { startLine: 2, endLine: 2 }, label: '2:2' },
		{ text: '', returned: null, label: 'none' },
	])('reports clipped or absent EOF lines: $label', async ({ text, returned, label }) => {
		mockSend({
			success: true,
			block: {
				...RANGED_BLOCK,
				original: text,
				originalRange: {
					...RANGED_BLOCK.originalRange!,
					returned,
					complete: false,
					hasMore: false,
				},
			},
		});

		await modelsProxyBlock(HASH, { original: true, lines: '2:3' });

		expect(writeSpy).toHaveBeenCalledExactlyOnceWith(text);
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining(`returned ${label}; complete=false; hasMore=false`)
		);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('accepts the inclusive 1000-line limit', async () => {
		const range = { startLine: 1, endLine: 1000 };
		const block = {
			...RANGED_BLOCK,
			original: 'x\n'.repeat(1000),
			originalRange: {
				...RANGED_BLOCK.originalRange!,
				requested: range,
				returned: range,
			},
		};
		const captured = mockSend({ success: true, block });

		await modelsProxyBlock(HASH, { original: true, lines: '1:1000', json: true });

		expect(captured.payload?.range).toEqual(range);
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({ success: true, block });
	});

	it.each([
		{ lines: '1:2' },
		{ lines: '1:2', compressed: true },
		{ lines: '1:2', compressed: true, original: true },
	])('refuses incompatible range flags before the bridge: %j', async (options) => {
		await expect(modelsProxyBlock(HASH, { ...options, json: true })).rejects.toThrow('__exit__');

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({ success: false });
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it.each([
		'',
		'1',
		'1-2',
		':2',
		'1:',
		'1:2:3',
		' 1:2',
		'1:2 ',
		'1:2\n',
		'1:2\r\n',
		'1.0:2',
		'1e2:102',
		'0x1:2',
		'-1:2',
		'+1:2',
		'1:2suffix',
		'0:2',
		'2:1',
		'1:1001',
		'9007199254740992:9007199254740992',
	])('rejects malformed or out-of-bounds lines %j before the bridge', async (lines) => {
		await expect(modelsProxyBlock(HASH, { original: true, lines, json: true })).rejects.toThrow(
			'__exit__'
		);

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
			success: false,
			error: expect.any(String),
		});
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		null,
		{ ...RANGED_BLOCK.originalRange!, requested: { startLine: 1, endLine: 4 } },
		{ ...RANGED_BLOCK.originalRange!, hash: 'b'.repeat(64) },
	])('refuses an unconfirmed range, including older desktops: %j', async (originalRange) => {
		mockSend({ success: true, block: { ...BLOCK, originalRange } });

		await expect(
			modelsProxyBlock(HASH, { original: true, lines: '2:3', json: true })
		).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.Unsupported);
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			error: expect.stringContaining('did not confirm'),
		});
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('fails explicitly when a ranged original is missing, including JSON callers', async () => {
		mockSend({ success: true, block: { ...BLOCK, original: null, originalRange: null } });

		await expect(
			modelsProxyBlock(HASH, { original: true, lines: '2:3', json: true })
		).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toMatchObject({
			success: false,
			error: expect.stringContaining('no longer in the cache'),
		});
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('keeps the full JSON behavior when an original is missing and no range was requested', async () => {
		const block = { ...BLOCK, original: null };
		mockSend({ success: true, block });

		await modelsProxyBlock(HASH, { original: true, json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({ success: true, block });
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it.each([
		'Original line range exceeds the output byte limit',
		'Original line range exceeds the archive scan limit',
		'EACCES: archive cannot be read',
	])('propagates archive failures without printing an excerpt: %s', async (error) => {
		mockSend({ success: false, error });

		await expect(
			modelsProxyBlock(HASH, { original: true, lines: '2:3', json: true })
		).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({ success: false, error });
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it.each([{}, { original: true, lines: '2:3' }])(
		'fails for a missing block with options %j',
		async (options) => {
			mockSend({ success: true, block: null });

			await expect(modelsProxyBlock(HASH, options)).rejects.toThrow('__exit__');

			expect(errorSpy).toHaveBeenCalledWith(
				formatError(`The proxy cache holds no compressed block for ${HASH}.`)
			);
		}
	);

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

describe('models proxy cache command', () => {
	const USAGE = { entries: 3, bytes: 2048, oldestUseAt: Date.now() - 2 * 24 * 60 * 60 * 1000 };

	it('reads what the cache holds without pruning', async () => {
		const captured = mockSend({ success: true, usage: USAGE });

		await modelsProxyCache(false, {});

		expect(captured.payload).toEqual({ type: 'local_models_proxy_cache', prune: false });
		expect(captured.responseType).toBe('local_models_proxy_cache_result');
		expect(logSpy.mock.calls[0][0]).toMatch(
			/^Proxy cache: 3 entries, 2(\.0)? KB; least recently used/
		);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prunes with an idle limit and reports what it removed', async () => {
		const pruned = { removedEntries: 2, removedBytes: 4096, removedOrphans: 1, usage: USAGE };
		const captured = mockSend({ success: true, usage: USAGE, pruned });

		await modelsProxyCache(true, { olderThan: '7d', json: true });

		expect(captured.payload).toEqual({
			type: 'local_models_proxy_cache',
			prune: true,
			olderThanMs: 7 * 24 * 60 * 60 * 1000,
		});
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			usage: USAGE,
			pruned,
		});
	});

	it('refuses a duration it cannot read, and --older-than without prune, before the app', async () => {
		mockSend({ success: true, usage: USAGE });

		await expect(modelsProxyCache(true, { olderThan: 'soon' })).rejects.toThrow('__exit__');
		await expect(modelsProxyCache(false, { olderThan: '7d' })).rejects.toThrow('__exit__');

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
	});
});
