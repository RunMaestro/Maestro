/** Regression coverage for stats-tokens accounting at the CLI output boundary. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { TokenUsageAggregate } from '../../../shared/tokenUsage';
import type { UsageCost } from '../../../shared/types';
import { emptyTokenSpeedSummary } from '../../../shared/tokenSpeed';
import { providerProfileKey } from '../../../shared/providerProfiles';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/session-command', () => ({ exitIfMaestroNotRunning: vi.fn() }));

import { statsTokens } from '../../../cli/commands/stats';
import { withMaestroClient } from '../../../cli/services/maestro-client';

describe('stats-tokens accounting', () => {
	let data: TokenUsageAggregate;
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;
	const sendCommand = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
		data = {
			totals: {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 3,
				cacheCreationTokens: 2,
				costUsd: 99,
				costEstimated: true,
				sessionCount: 1,
			},
			byAgent: [],
			byModel: [],
			byProject: [],
			byAccount: [],
			timeline: [],
			series: {
				byDay: {},
				byHour: {},
				byAgentByDay: {},
				bySessionByDay: {},
				bySource: { user: 0, auto: 0 },
			},
			speed: emptyTokenSpeedSummary(),
			coverageByAgent: { grok: 'partial' },
			generatedAtMs: 1_700_000_000_000,
		};
		sendCommand.mockReset().mockImplementation(async () => ({ type: 'token_usage', data }));
		// Same inert bridge pattern as throughput-gauge.test.ts; no desktop or native reads.
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
	});

	afterEach(() => vi.restoreAllMocks());

	it.each<{ name: string; cost: UsageCost; label: string }>([
		{ name: 'unknown', cost: { status: 'unknown' }, label: 'Unknown' },
		{ name: 'amountless partial', cost: { status: 'partial' }, label: 'Unknown (partial)' },
		{
			name: 'partial ticks',
			cost: { status: 'partial', costUsdTicks: '12500000000' },
			label: '$1.25 (partial)',
		},
		{
			name: 'partial zero',
			cost: { status: 'partial', costUsdTicks: '0' },
			label: '$0.00 (partial)',
		},
		{ name: 'exact zero', cost: { status: 'exact', costUsdTicks: '0' }, label: '$0.00' },
		{
			name: 'ticks before stale decimal',
			cost: { status: 'exact', costUsdTicks: '12500000000', costUsd: 99 },
			label: '$1.25',
		},
		...(['complete', 'partial', 'unknown'] as const).map((completeness) => ({
			name: `${completeness} estimate`,
			cost: {
				status: 'estimated' as const,
				costUsd: 1.25,
				model: 'fixture-model',
				pricingRevision: 'fixture',
				completeness,
			},
			label: completeness === 'complete' ? '~$1.25' : '~$1.25 (partial)',
		})),
	])(
		'preserves $name in text and JSON despite conflicting legacy projections',
		async ({ cost, label }) => {
			data.totals.accounting = { completeness: 'partial', cost };
			data.totals.costEstimated = cost.status !== 'estimated';
			const rawModel = 'xai/grok-4-fast-non-reasoning:2026-10';
			const account = providerProfileKey('grok', 'fixture-account');
			data.byAgent = [{ ...data.totals, key: 'grok', label: 'Grok CLI' }];
			data.byModel = [{ ...data.totals, key: JSON.stringify(['grok', rawModel]), label: rawModel }];
			data.byAccount = [{ ...data.totals, key: account, label: 'work' }];
			await statsTokens({});
			expect(sendCommand).toHaveBeenCalledWith(
				{ type: 'get_token_usage', range: 'week', force: false },
				'token_usage'
			);
			const text = logSpy.mock.calls[0][0] as string;
			expect(text).toContain(`  Cost:            ${label}\n`);
			for (const identity of [
				'Grok CLI [grok]',
				`${rawModel} [${JSON.stringify(['grok', rawModel])}]`,
				`work [${account}]`,
			]) {
				expect(text).toContain(
					`  ${identity}: ${label}\n    10 in / 5 out / 3 cache read / 2 cache creation; 1 sessions`
				);
			}
			expect(text).toContain('Overall:         Unknown (no timed calls)');
			expect(text).not.toContain('99.00');
			await statsTokens({ range: 'all', refresh: true, json: true });
			expect(sendCommand).toHaveBeenLastCalledWith(
				{ type: 'get_token_usage', range: 'all', force: true },
				'token_usage'
			);
			expect(JSON.parse(logSpy.mock.calls[1][0] as string)).toEqual({ range: 'all', ...data });
			expect(errorSpy).not.toHaveBeenCalled();
			expect(exitSpy).not.toHaveBeenCalled();
		}
	);

	it('keeps mixed providers, colliding account labels and partial model detail separate from lifetime totals', async () => {
		const unknown = {
			...data.totals,
			costUsd: 0,
			costEstimated: false,
			accounting: { completeness: 'unknown' as const, cost: { status: 'unknown' as const } },
		};
		const partial = {
			...data.totals,
			costUsd: 1.25,
			costEstimated: false,
			accounting: {
				completeness: 'partial' as const,
				cost: { status: 'partial' as const, costUsdTicks: '12500000000' },
			},
		};
		const legacy = { ...data.totals, costUsd: 2, costEstimated: false };
		const rawModels = ['grok-4-fast', 'grok-4-fast-non-reasoning'];
		data.totals = {
			...partial,
			inputTokens: 80,
			sessionCount: 3,
			accounting: {
				completeness: 'partial',
				cost: { status: 'partial', costUsdTicks: '32500000000' },
			},
		};
		data.byAgent = [
			{ ...partial, key: 'grok', label: 'Grok CLI' },
			{ ...legacy, key: 'claude-code', label: 'Claude Code' },
		];
		data.byAccount = [partial, unknown].map((totals, i) => ({
			...totals,
			key: providerProfileKey('grok', `fixture-${i}`),
			label: 'work',
		}));
		data.byModel = [partial, unknown].map((totals, i) => ({
			...totals,
			key: JSON.stringify(['grok', rawModels[i]]),
			label: rawModels[i],
		}));
		data.timeline = [{ ...data.totals, startMs: data.generatedAtMs }];
		data.coverageByAgent['claude-code'] = 'full';
		const before = JSON.stringify(data);
		await statsTokens({});
		const text = logSpy.mock.calls[0][0] as string;
		expect(text).toContain('Cost:            $3.25 (partial)\n');
		expect(text).toContain('Tokens:          80 in / 5 out / 3 cache read / 2 cache creation');
		expect(text).toContain('Sessions:        3\n');
		expect(text).toContain('Claude Code [claude-code]: $2.00\n');
		expect(text).toContain('Grok CLI [grok]: $1.25 (partial)\n');
		for (const [i, amount] of ['$1.25 (partial)', 'Unknown'].entries()) {
			expect(text).toContain(`work [${providerProfileKey('grok', `fixture-${i}`)}]: ${amount}\n`);
			expect(text).toContain(
				`${rawModels[i]} [${JSON.stringify(['grok', rawModels[i]])}]: ${amount}\n`
			);
		}
		await statsTokens({ json: true });
		expect(JSON.parse(logSpy.mock.calls[1][0] as string)).toEqual({ range: 'week', ...data });
		expect(JSON.stringify(data)).toBe(before);
	});

	it('preserves exact tick strings beyond safe integers in JSON', async () => {
		data.totals.accounting = {
			completeness: 'complete',
			cost: { status: 'exact', costUsdTicks: '9223372036854775807' },
		};
		await statsTokens({ json: true });
		expect(JSON.parse(logSpy.mock.calls[0][0] as string).totals.accounting.cost.costUsdTicks).toBe(
			'9223372036854775807'
		);
	});

	it.each([false, true])(
		'retains legacy cost without canonical accounting (estimated=%s)',
		async (costEstimated) => {
			data.totals.costUsd = 2;
			data.totals.costEstimated = costEstimated;
			await statsTokens({});
			expect(logSpy.mock.calls[0][0]).toContain(
				`Cost:            ${costEstimated ? '~' : ''}$2.00\n`
			);
		}
	);

	it('reports absent usage as unknown even when numeric compatibility fields are zero', async () => {
		data.totals = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			costUsd: 0,
			costEstimated: false,
			sessionCount: 0,
			accounting: { completeness: 'unknown', cost: { status: 'unknown' } },
		};
		await statsTokens({});
		const text = logSpy.mock.calls[0][0] as string;
		expect(text).toContain('Cost:            Unknown\n');
		expect(text).toContain('Sessions:        0\n');
		expect(text).toContain('Unknown (no timed calls)');
		expect(text).not.toMatch(/\$0\.00|By account:|By model:/);
		await statsTokens({ json: true });
		expect(JSON.parse(logSpy.mock.calls[1][0] as string)).toEqual({ range: 'week', ...data });
	});

	it.each([false, true])(
		'does not print a successful zero-spend summary when the bridge fails (json=%s)',
		async (json) => {
			sendCommand.mockRejectedValue(new Error('Usage unavailable'));
			await expect(statsTokens({ json })).rejects.toThrow('process.exit');
			expect(exitSpy).toHaveBeenCalledWith(1);
			expect(logSpy).not.toHaveBeenCalled();
			expect(errorSpy.mock.calls[0][0]).toContain('Usage unavailable');
			if (json)
				expect(JSON.parse(errorSpy.mock.calls[0][0] as string)).toEqual({
					error: 'Usage unavailable',
				});
		}
	);
});
