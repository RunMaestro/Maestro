import { describe, it, expect } from 'vitest';
import { UsageAccumulator } from '../usage-accumulator';
import { CodexOutputParser } from '../../parsers/codex-output-parser';
import type { UsageAccounting, UsageCost, UsageStats } from '../../../types';

function usage(overrides: Partial<UsageStats> = {}, fact?: Partial<UsageAccounting>): UsageStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0,
		contextWindow: 200_000,
		...(fact && {
			accounting: {
				source: 'runtime-stream' as const,
				route: 'acp',
				scopeId: 'fixture-account-host',
				providerSessionId: 'native-session',
				processGeneration: 'process-1',
				turnId: 'turn-1',
				scope: 'response' as const,
				reporting: 'snapshot' as const,
				cacheReadCounting: 'beside-input' as const,
				cacheCreationCounting: 'beside-input' as const,
				completeness: 'complete' as const,
				childInclusion: 'unknown' as const,
				childCompleteness: 'unknown' as const,
				cost: { status: 'unknown' as const },
				...fact,
			},
		}),
		...overrides,
	};
}

describe('Grok scoped usage reconciliation', () => {
	it.each(['snapshot', 'delta'] as const)(
		'counts only new %s spend after a covering turn snapshot',
		(reporting) => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			acc.accumulate(usage({ inputTokens: 10 }, { responseId: 'call' }));
			acc.accumulate(usage({ inputTokens: 20 }, { scope: 'turn' }));
			const update = usage(
				{ inputTokens: reporting === 'snapshot' ? 15 : 5 },
				{ responseId: 'call', reporting }
			);
			expect(acc.accumulate(update)?.inputTokens).toBe(25);
			const ended = usage({ inputTokens: 18 }, { responseId: 'call', final: true });
			expect(acc.accumulate(ended)?.inputTokens).toBe(28);
			acc.accumulate(usage({ inputTokens: 30 }, { scope: 'turn' }));
			expect(acc.accumulate(usage({ inputTokens: 999 }, ended.accounting))?.inputTokens).toBe(30);
		}
	);

	it('accepts equal deltas as distinct observations and snapshots as replacements', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const delta = usage({ inputTokens: 3 }, { responseId: 'call', reporting: 'delta' });
		acc.accumulate(delta);
		expect(acc.accumulate(delta)?.inputTokens).toBe(6);
		expect(acc.accumulate(usage({ inputTokens: 8 }, { responseId: 'call' }))?.inputTokens).toBe(8);
	});

	it('deduplicates raw cost-omitting snapshots and retains stronger partial cost bounds', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.accumulate(
			usage({ inputTokens: 10 }, { cost: { status: 'exact', costUsdTicks: '9007199254740993' } })
		);
		const omitted = usage({ inputTokens: 12 }, {});
		const total = acc.accumulate(omitted);
		const reports = acc.scopedReports;
		expect(acc.accumulate(omitted)).toEqual(total);
		expect(acc.scopedReports).toEqual(reports);
		expect(total?.accounting?.cost).toMatchObject({
			status: 'partial',
			costUsdTicks: '9007199254740993',
		});
		for (const cost of [
			{ status: 'partial', costUsdTicks: '9007199254740992' },
			{ status: 'exact', costUsdTicks: '9007199254740992' },
		] satisfies UsageCost[]) {
			const weaker = usage({ inputTokens: 13 }, { cost });
			expect(acc.accumulate(weaker)?.accounting?.cost).toMatchObject({
				status: 'partial',
				costUsdTicks: '9007199254740993',
			});
		}
	});

	it('does not advance an accepted process watermark on regressed or still-stale reports', () => {
		const baseline = usage({ inputTokens: 100 }, { scope: 'process-session' });
		const acc = new UsageAccumulator({
			attachesAbsoluteUsage: false,
			processSessionBaseline: baseline,
		});
		for (const [inputTokens, expected] of [
			[110, 10],
			[105, 10],
			[108, 10],
			[112, 12],
		]) {
			const total = acc.accumulate(usage({ inputTokens }, { scope: 'process-session' }));
			expect(total).toMatchObject({
				inputTokens: expected,
				accounting: { final: false, cost: { status: 'unknown' } },
			});
		}
	});

	it.each([
		'route',
		'scopeId',
		'providerSessionId',
		'processGeneration',
		'turnId',
		'requestId',
	] as const)(
		'rejects conflicting %s while binding omitted event identity to this capture',
		(field) => {
			const identity = {
				route: 'acp',
				scopeId: 'fixture-account-host',
				providerSessionId: 'native-session',
				processGeneration: 'process-1',
				turnId: 'turn-1',
				requestId: 'prompt-request',
			};
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false, identity });
			const anonymous = usage(
				{ inputTokens: 7 },
				{
					route: undefined,
					scopeId: undefined,
					providerSessionId: undefined,
					processGeneration: undefined,
					turnId: undefined,
					requestId: 'internal-call',
				}
			);
			const total = acc.accumulate(anonymous);
			expect(total?.accounting).toMatchObject({ turnId: 'turn-1', requestId: 'prompt-request' });
			expect(
				acc.accumulate(usage({ inputTokens: 999 }, { scope: 'turn', [field]: 'foreign' }))
			).toEqual(total);
		}
	);

	it.each([
		{ scopeId: undefined },
		{ route: '' },
		{ completeness: 'partial' },
		{ reporting: 'delta' },
		{ scope: 'native-session' },
		{ processGeneration: 'foreign' },
	] satisfies Partial<UsageAccounting>[])(
		'refuses an unproven or mismatched baseline %j',
		(accounting) => {
			expect(
				() =>
					new UsageAccumulator({
						attachesAbsoluteUsage: false,
						identity: { processGeneration: 'process-1' },
						processSessionBaseline: usage({}, { scope: 'process-session', ...accounting }),
					})
			).toThrow('Process usage baseline requires complete, matching scoped identity');
		}
	);

	it('retains running/completed child and lifetime facts without adding them to parent spend', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const parent = acc.accumulate(usage({ inputTokens: 20 }, { childInclusion: 'completed' }));
		for (const status of ['running', 'completed'] as const) {
			const child = usage(
				{ inputTokens: 8 },
				{
					scope: 'child',
					providerSessionId: 'child-session',
					final: status === 'completed',
					children: [
						{
							providerSessionId: 'child-session',
							status,
							includedInParent: status === 'completed',
							completeness: 'partial',
							cost: { status: 'unknown' },
						},
					],
				}
			);
			expect(acc.accumulate(child)).toEqual(parent);
		}
		expect(acc.accumulate(usage({ inputTokens: 5000 }, { scope: 'native-session' }))).toEqual(
			parent
		);
		expect(acc.scopedReports.map((report) => report.accounting?.scope)).toEqual([
			'response',
			'child',
			'native-session',
		]);
		expect(acc.scopedReports[1].accounting?.children?.[0].status).toBe('completed');
	});
});

describe('UsageAccumulator', () => {
	it('returns the first event verbatim - nothing to delta against yet', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const first = usage({ inputTokens: 500, outputTokens: 100 });

		expect(acc.normalize(first)).toEqual(first);
	});

	it('computes a per-turn delta from cumulative, monotonically increasing totals', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 50 }));

		const second = acc.normalize(
			usage({ inputTokens: 800, outputTokens: 150, cacheReadInputTokens: 90 })
		);

		expect(second.inputTokens).toBe(300);
		expect(second.outputTokens).toBe(50);
		expect(second.cacheReadInputTokens).toBe(40);
	});

	it('re-attaches absoluteUsage with the pre-normalization cumulative totals when attachesAbsoluteUsage is true', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: true });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		const second = acc.normalize(usage({ inputTokens: 800, outputTokens: 150 }));

		expect(second.absoluteUsage).toEqual({
			inputTokens: 800,
			outputTokens: 150,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
		});
	});

	it('does not attach absoluteUsage when attachesAbsoluteUsage is false, but preserves an incoming one untouched', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		const incomingAbsolute = {
			inputTokens: 42,
			outputTokens: 7,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
		};
		const second = acc.normalize(
			usage({ inputTokens: 800, outputTokens: 150, absoluteUsage: incomingAbsolute })
		);

		// This provider doesn't get a computed absoluteUsage, but the one its
		// own parser already attached (e.g. Claude Code's last-call snapshot)
		// must survive the delta computation unmodified.
		expect(second.absoluteUsage).toEqual(incomingAbsolute);
	});

	it('detects a non-cumulative (already per-turn) stream and passes every event through unmodified', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

		// A decrease means this provider reports per-turn, not cumulative.
		const second = usage({ inputTokens: 300, outputTokens: 80 });
		expect(acc.normalize(second)).toEqual(second);

		// Once flagged non-cumulative, every subsequent event passes through
		// verbatim too, even one that would otherwise look monotonic.
		const third = usage({ inputTokens: 900, outputTokens: 200 });
		expect(acc.normalize(third)).toEqual(third);
	});

	it('defaults reasoningTokens to 0 when absent and includes it in the delta', () => {
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
		acc.normalize(usage({ inputTokens: 100, reasoningTokens: 10 }));

		const second = acc.normalize(usage({ inputTokens: 200, reasoningTokens: 25 }));

		expect(second.reasoningTokens).toBe(15);
	});

	it('keeps separate instances fully independent (matches one-accumulator-per-process scoping)', () => {
		const accA = new UsageAccumulator({ attachesAbsoluteUsage: false });
		const accB = new UsageAccumulator({ attachesAbsoluteUsage: false });

		accA.normalize(usage({ inputTokens: 1000, outputTokens: 500 }));
		// B has seen nothing yet, so its first event is still verbatim even
		// though A has already established a baseline.
		const firstForB = usage({ inputTokens: 10, outputTokens: 5 });
		expect(accB.normalize(firstForB)).toEqual(firstForB);
	});

	describe('lastTotals / isCumulative getters', () => {
		it('start undefined before any event is seen', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			expect(acc.lastTotals).toBeUndefined();
			expect(acc.isCumulative).toBeUndefined();
		});

		it('expose the raw totals and cumulative flag after a monotonic second event, for a caller mirroring state externally (e.g. ManagedProcess.lastUsageTotals / usageIsCumulative)', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));
			acc.normalize(usage({ inputTokens: 800, outputTokens: 150 }));

			expect(acc.isCumulative).toBe(true);
			expect(acc.lastTotals).toEqual({
				inputTokens: 800,
				outputTokens: 150,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			});
		});

		it('returns a defensive copy from lastTotals - mutating the getter result does not affect internal state', () => {
			const acc = new UsageAccumulator({ attachesAbsoluteUsage: false });
			acc.normalize(usage({ inputTokens: 500, outputTokens: 100 }));

			const snapshot = acc.lastTotals;
			expect(snapshot).toBeDefined();
			if (snapshot) {
				snapshot.inputTokens = 999999;
			}

			expect(acc.lastTotals?.inputTokens).toBe(500);
		});
	});
});

// The accumulator is scoped per PROCESS, so it can only be right about a resumed
// Codex turn if the parser hands it totals that start at this process: Codex's
// `total_token_usage` is a running SESSION total, and a resumed run's first
// token_count already carries every earlier turn.
describe('UsageAccumulator over a resumed Codex process', () => {
	function tokenCount(total: Record<string, number>, last: Record<string, number>): string {
		return JSON.stringify({
			type: 'event_msg',
			payload: {
				type: 'token_count',
				info: { total_token_usage: total, last_token_usage: last },
			},
		});
	}

	function runProcess(lines: string[]): UsageStats {
		const parser = new CodexOutputParser();
		const acc = new UsageAccumulator({ attachesAbsoluteUsage: true });
		const summed = usage();
		for (const line of lines) {
			const parsed = parser.parseJsonLine(line)?.usage;
			if (!parsed) continue;
			const step = acc.normalize(
				usage({
					inputTokens: parsed.inputTokens,
					outputTokens: parsed.outputTokens,
					cacheReadInputTokens: parsed.cacheReadTokens ?? 0,
					reasoningTokens: parsed.reasoningTokens,
				})
			);
			summed.inputTokens += step.inputTokens;
			summed.outputTokens += step.outputTokens;
			summed.cacheReadInputTokens += step.cacheReadInputTokens;
		}
		return summed;
	}

	it('sums a resumed turn to what that turn spent, not the conversation so far', () => {
		// Turn 1 (an earlier process) spent 12000 in / 550 out. This process makes
		// two API calls: 13000 in / 120 out, then 13500 in / 60 out.
		const turn2 = runProcess([
			tokenCount(
				{
					input_tokens: 25000,
					cached_input_tokens: 21000,
					output_tokens: 490,
					reasoning_output_tokens: 180,
				},
				{
					input_tokens: 13000,
					cached_input_tokens: 12000,
					output_tokens: 90,
					reasoning_output_tokens: 30,
				}
			),
			tokenCount(
				{
					input_tokens: 38500,
					cached_input_tokens: 34000,
					output_tokens: 550,
					reasoning_output_tokens: 180,
				},
				{
					input_tokens: 13500,
					cached_input_tokens: 13000,
					output_tokens: 60,
					reasoning_output_tokens: 0,
				}
			),
		]);

		expect(turn2.inputTokens).toBe(26500);
		expect(turn2.outputTokens).toBe(180);
		expect(turn2.cacheReadInputTokens).toBe(25000);
	});
});
