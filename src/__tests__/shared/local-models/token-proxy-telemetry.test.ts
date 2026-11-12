/**
 * @file token-proxy-telemetry.test.ts
 *
 * The token proxy's telemetry contract: what a stored request row may say, how
 * sure each figure is (measured, an estimate, an opportunity, or unknown), and
 * that figures of different kinds cannot be totalled into one savings number.
 * The producer side of the block arithmetic is pinned in
 * `main/local-models/proxy/compress.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
	addProxyFigures,
	asTokenProxySkipReason,
	isCompressingTokenProxyMode,
	proxyBlockCountsProblem,
	proxyFigure,
	proxyProviderClassHasValue,
	proxyProviderClassReading,
	TOKEN_PROXY_EVIDENCE_LABELS,
	TOKEN_PROXY_EVIDENCE_NOTES,
	TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE,
	TOKEN_PROXY_PROVIDER_CLASS_LABELS,
	TOKEN_PROXY_SKIP_LABELS,
	TOKEN_PROXY_SKIP_REASONS,
	TOKEN_PROXY_UNKNOWN_LABELS,
	unknownProxyFigure,
} from '../../../shared/local-models/token-proxy';
import {
	PROXY_EVIDENCE_KINDS,
	PROXY_PROVIDER_USAGE_CLASSES,
	PROXY_UNKNOWN_REASONS,
	type ProxyCoverage,
	type ProxyFigure,
	type ProxyProviderReportedness,
} from '../../../shared/stats-types';
import {
	CONSISTENT_BLOCK_COUNTS,
	currentProxyRow,
	legacyProxyRow,
	passthroughProxyRow,
	skippedProxyRow,
	stringPaths,
} from '../../helpers/proxyTelemetryFixtures';

const RANGE: ProxyCoverage = { scope: 'range', counted: 40, of: 130 };
const LIFETIME: ProxyCoverage = { scope: 'process-lifetime', since: 1_700_000_000_000 };

describe('evidence kinds', () => {
	it('names three kinds of figure and says what each is', () => {
		expect([...PROXY_EVIDENCE_KINDS]).toEqual(['measured', 'estimate', 'opportunity']);
		expect(Object.keys(TOKEN_PROXY_EVIDENCE_LABELS).sort()).toEqual(
			[...PROXY_EVIDENCE_KINDS].sort()
		);
		expect(Object.keys(TOKEN_PROXY_EVIDENCE_NOTES).sort()).toEqual(
			[...PROXY_EVIDENCE_KINDS].sort()
		);
		expect(TOKEN_PROXY_EVIDENCE_NOTES.estimate).toContain('Not a count a provider billed');
		expect(TOKEN_PROXY_EVIDENCE_NOTES.opportunity).toContain('nothing was saved');
		expect(TOKEN_PROXY_EVIDENCE_LABELS.opportunity).toContain('not applied');
	});

	it('says in one place that the kinds are never added into one savings number', () => {
		expect(TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE).toContain(
			'Measured counts, estimates and opportunities are different kinds of figure'
		);
		expect(TOKEN_PROXY_EVIDENCE_SEPARATION_NOTE).toContain('never added into one savings number');
	});

	it('gives every reason a figure can be unknown a label', () => {
		expect(Object.keys(TOKEN_PROXY_UNKNOWN_LABELS).sort()).toEqual(
			[...PROXY_UNKNOWN_REASONS].sort()
		);
		expect(new Set(PROXY_UNKNOWN_REASONS).size).toBe(PROXY_UNKNOWN_REASONS.length);
		for (const label of Object.values(TOKEN_PROXY_UNKNOWN_LABELS)) {
			expect(label.length).toBeGreaterThan(0);
		}
	});
});

describe('proxyFigure', () => {
	it('keeps the kind, unit, value and coverage of a figure that has a value', () => {
		expect(proxyFigure('estimate', 'tokens', 10_000, RANGE, 'not-read')).toEqual({
			kind: 'estimate',
			unit: 'tokens',
			value: 10_000,
			coverage: RANGE,
		});
	});

	it('is unknown, for the reason given, when no request supplied the value', () => {
		expect(
			proxyFigure('estimate', 'tokens', 0, { scope: 'range', counted: 0, of: 130 }, 'not-read')
		).toEqual({ kind: 'estimate', unit: 'tokens', value: null, unknown: 'not-read' });
		// A range with no request at all leaves no division by zero to the caller.
		expect(
			proxyFigure(
				'measured',
				'ms',
				0,
				{ scope: 'range', counted: 0, of: 0 },
				'insufficient-samples'
			)
		).toMatchObject({ value: null, unknown: 'insufficient-samples' });
	});

	it('keeps a zero that was counted', () => {
		expect(proxyFigure('measured', 'blocks', 0, RANGE, 'not-read')).toMatchObject({
			value: 0,
			coverage: RANGE,
		});
	});

	it('keeps a figure for the process lifetime, which has no request denominator', () => {
		expect(proxyFigure('measured', 'requests', 0, LIFETIME, 'not-observed')).toEqual({
			kind: 'measured',
			unit: 'requests',
			value: 0,
			coverage: LIFETIME,
		});
	});

	it('refuses a value or a coverage that is a bug in the caller', () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => proxyFigure('estimate', 'tokens', value, RANGE, 'not-read')).toThrow(RangeError);
		}
		const impossible: ProxyCoverage[] = [
			{ scope: 'range', counted: 5, of: 4 },
			{ scope: 'range', counted: -1, of: 4 },
			{ scope: 'range', counted: 1.5, of: 4 },
			{ scope: 'range', counted: Number.NaN, of: 4 },
		];
		for (const coverage of impossible) {
			expect(() => proxyFigure('measured', 'requests', 1, coverage, 'not-read')).toThrow(
				RangeError
			);
		}
	});

	it('does not make figures of different kinds equal, whatever their number', () => {
		const estimate = proxyFigure('estimate', 'tokens', 4_500, RANGE, 'not-read');
		const opportunity = proxyFigure('opportunity', 'tokens', 4_500, RANGE, 'not-read');
		expect(estimate).not.toEqual(opportunity);
		// The kind survives a round trip through the IPC and the CLI's JSON.
		expect(JSON.parse(JSON.stringify(opportunity))).toMatchObject({ kind: 'opportunity' });
	});
});

describe('unknownProxyFigure', () => {
	it('has a kind, a unit and a reason, and no value', () => {
		for (const kind of PROXY_EVIDENCE_KINDS) {
			expect(unknownProxyFigure(kind, 'tokens', 'on-demand-only')).toEqual({
				kind,
				unit: 'tokens',
				value: null,
				unknown: 'on-demand-only',
			});
		}
	});
});

describe('addProxyFigures', () => {
	it('adds figures of one kind and unit, and their coverage with them', () => {
		const a = proxyFigure(
			'estimate',
			'tokens',
			6_000,
			{ scope: 'range', counted: 30, of: 100 },
			'not-read'
		);
		const b = proxyFigure(
			'estimate',
			'tokens',
			4_000,
			{ scope: 'range', counted: 10, of: 30 },
			'not-read'
		);
		expect(addProxyFigures(a, b)).toEqual({
			kind: 'estimate',
			unit: 'tokens',
			value: 10_000,
			coverage: { scope: 'range', counted: 40, of: 130 },
		});
	});

	it('refuses to total an estimate, an opportunity and a measured count into one number', () => {
		const estimate: ProxyFigure = proxyFigure('estimate', 'tokens', 10_000, RANGE, 'not-read');
		const opportunity: ProxyFigure = proxyFigure(
			'opportunity',
			'tokens',
			4_500,
			LIFETIME,
			'not-observed'
		);
		const measured: ProxyFigure = proxyFigure('measured', 'tokens', 120_000, RANGE, 'not-observed');
		expect(() => addProxyFigures(estimate, opportunity)).toThrow(
			'Figures of different kinds cannot be added: estimate and opportunity.'
		);
		expect(() => addProxyFigures(measured, estimate)).toThrow(
			'Figures of different kinds cannot be added: measured and estimate.'
		);
		expect(() => addProxyFigures(opportunity, measured)).toThrow(TypeError);
	});

	it('refuses to add figures that count different things', () => {
		const bytes = proxyFigure('measured', 'bytes', 4_000, RANGE, 'not-read');
		const tokens = proxyFigure('measured', 'tokens', 1_000, RANGE, 'not-read');
		expect(() => addProxyFigures(bytes, tokens)).toThrow(
			'Figures in different units cannot be added: bytes and tokens.'
		);
	});

	it('makes the sum unknown when either figure is, whichever side it is on', () => {
		const known = proxyFigure('measured', 'requests', 5, RANGE, 'not-read');
		const unknown = unknownProxyFigure('measured', 'requests', 'not-recorded');
		expect(addProxyFigures(known, unknown)).toBe(unknown);
		expect(addProxyFigures(unknown, known)).toBe(unknown);
	});

	it('adds figures for the process lifetime from the earlier start, or from none', () => {
		const first = proxyFigure(
			'measured',
			'requests',
			2,
			{ scope: 'process-lifetime', since: 2_000 },
			'not-observed'
		);
		const second = proxyFigure(
			'measured',
			'requests',
			3,
			{ scope: 'process-lifetime', since: 1_000 },
			'not-observed'
		);
		const undated = proxyFigure(
			'measured',
			'requests',
			4,
			{ scope: 'process-lifetime' },
			'not-observed'
		);
		expect(addProxyFigures(first, second)).toMatchObject({
			value: 5,
			coverage: { scope: 'process-lifetime', since: 1_000 },
		});
		// A start that is unknown on either side leaves the sum's start unknown.
		const unknownStart = addProxyFigures(first, undated);
		expect(unknownStart).toMatchObject({ value: 6, coverage: { scope: 'process-lifetime' } });
		expect(unknownStart).not.toHaveProperty('coverage.since');
	});

	it('does not add a range to the process lifetime', () => {
		const range = proxyFigure('measured', 'requests', 5, RANGE, 'not-read');
		const lifetime = proxyFigure('measured', 'requests', 5, LIFETIME, 'not-observed');
		expect(() => addProxyFigures(range, lifetime)).toThrow(
			'A figure for a range cannot be added to one for the process lifetime.'
		);
	});
});

describe('skip reasons', () => {
	it('names the reasons compress mode forwards a body unread, each with a label', () => {
		expect([...TOKEN_PROXY_SKIP_REASONS]).toEqual(['encoding', 'not-text', 'too-large', 'failed']);
		expect(Object.keys(TOKEN_PROXY_SKIP_LABELS).sort()).toEqual(
			[...TOKEN_PROXY_SKIP_REASONS].sort()
		);
	});

	it('reads a stored string as a reason, or as none', () => {
		for (const reason of TOKEN_PROXY_SKIP_REASONS) {
			expect(asTokenProxySkipReason(reason)).toBe(reason);
		}
		expect(asTokenProxySkipReason('from-a-newer-build')).toBeNull();
		expect(asTokenProxySkipReason(undefined)).toBeNull();
		expect(asTokenProxySkipReason(3)).toBeNull();
	});
});

describe('proxyBlockCountsProblem', () => {
	it('accepts counts that add up, in either compress mode', () => {
		expect(proxyBlockCountsProblem(currentProxyRow())).toBeNull();
		// Delayed mode protects recent results. Early mode lifts that rule.
		expect(
			proxyBlockCountsProblem(
				currentProxyRow({
					effectiveMode: 'compress',
					blockCounts: { ...CONSISTENT_BLOCK_COUNTS, protected: 4 },
				})
			)
		).toBeNull();
	});

	it('has nothing to check where the counts are unknown', () => {
		for (const row of [legacyProxyRow(), passthroughProxyRow(), skippedProxyRow('too-large')]) {
			expect(row.blockCounts).toBeUndefined();
			expect(proxyBlockCountsProblem(row)).toBeNull();
		}
	});

	it('names the first rule that counts break', () => {
		const withCounts = (counts: Partial<typeof CONSISTENT_BLOCK_COUNTS>, rest = {}) =>
			proxyBlockCountsProblem(
				currentProxyRow({ blockCounts: { ...CONSISTENT_BLOCK_COUNTS, ...counts }, ...rest })
			);
		// 9 candidates are 3 + 1 + 2 + 3 shortened: change any part and they stop adding up.
		expect(withCounts({ candidates: 8 })).toBe(
			'candidates must equal belowThreshold + storeFailed + kept + blocksCompressed.'
		);
		expect(withCounts({ kept: 3 })).toMatch(/^candidates must equal/);
		expect(withCounts({}, { blocksCompressed: 2 })).toMatch(/^candidates must equal/);
		// 5 blocks were decided (2 kept, 3 shortened), so no more than 5 can be reused or failed.
		expect(withCounts({}, { cacheHits: 6 })).toBe(
			'cacheHits cannot exceed kept + blocksCompressed.'
		);
		expect(withCounts({ modelFailed: 6 })).toBe(
			'modelFailed cannot exceed kept + blocksCompressed.'
		);
		// A count that is not a count is refused before any rule reads it.
		for (const counts of [
			{ protected: -1 },
			{ kept: 1.5 },
			{ belowThreshold: Number.NaN },
			{ vetoed: { failed: Number.POSITIVE_INFINITY, recovery: 0, retrieval: 0 } },
		]) {
			expect(withCounts(counts)).toBe('Every count must be a non-negative integer.');
		}
	});
});

describe('a stored proxy row', () => {
	it('still reads without the new facts: a legacy row has no effective mode, counts or reportedness', () => {
		const row = legacyProxyRow();
		expect(row.mode).toBe('compress');
		// Unknown. Not 'compress', and not the agent's mode today.
		expect(row.effectiveMode).toBeUndefined();
		expect(row.blockCounts).toBeUndefined();
		expect(row.providerUsageReportedness).toBeUndefined();
		expect(row).toMatchObject({
			originalTokens: 10_000,
			sentTokens: 7_500,
			addedLatencyMs: 12,
			blocksCompressed: 3,
			cacheHits: 2,
			providerCacheReadTokens: 120_000,
		});
	});

	it('says which compress mode carried a request, which the stored mode cannot', () => {
		const early = currentProxyRow({ effectiveMode: 'compress-early' });
		const delayed = currentProxyRow({ effectiveMode: 'compress' });
		expect(early.mode).toBe(delayed.mode);
		expect(early.effectiveMode).not.toBe(delayed.effectiveMode);
	});

	it('pairs every effective mode with the stored mode that records whether the body was read', () => {
		const rows = [
			passthroughProxyRow(),
			currentProxyRow({ effectiveMode: 'compress' }),
			currentProxyRow(),
			skippedProxyRow('failed'),
		];
		for (const row of rows) {
			expect(row.effectiveMode).toBeDefined();
			expect(row.mode).toBe(
				isCompressingTokenProxyMode(row.effectiveMode!) ? 'compress' : 'passthrough'
			);
		}
	});

	it('keeps the mode in force on a request whose body was never read', () => {
		const row = skippedProxyRow('too-large');
		expect(row.effectiveMode).toBe('compress-early');
		expect(row.originalTokens).toBeUndefined();
		expect(row.addedLatencyMs).toBeUndefined();
		expect(row.blockCounts).toBeUndefined();
		expect(asTokenProxySkipReason(row.skipReason)).toBe('too-large');
	});

	it('holds no free text: its strings are a closed set of names, ids and hashes', () => {
		const row = currentProxyRow({ routedTo: 'server:qwen3-coder', skipReason: 'failed' });
		expect(stringPaths(row).sort()).toEqual(
			[
				'agentId',
				'route',
				'kind',
				'outcome',
				'mode',
				'effectiveMode',
				'skipReason',
				'routedTo',
				'newBlocks[].hash',
				'newBlocks[].compressors[]',
				'providerUsageReportedness.input',
				'providerUsageReportedness.cacheRead',
				'providerUsageReportedness.cacheWrite',
				'providerUsageReportedness.output',
			].sort()
		);
	});
});

describe('proxyProviderClassReading', () => {
	const readings = (row: Parameters<typeof proxyProviderClassReading>[0]) =>
		PROXY_PROVIDER_USAGE_CLASSES.map((usageClass) => proxyProviderClassReading(row, usageClass));
	const hasValue = (row: Parameters<typeof proxyProviderClassReading>[0]) =>
		readings(row).map(proxyProviderClassHasValue);
	/** A row for an answer, with the four numbers a row always stores and how each got its number. */
	const answered = (
		numbers: [input: number, cacheRead: number, cacheWrite: number, output: number],
		providerUsageReportedness?: ProxyProviderReportedness
	) =>
		legacyProxyRow({
			providerInputTokens: numbers[0],
			providerCacheReadTokens: numbers[1],
			providerCacheWriteTokens: numbers[2],
			providerOutputTokens: numbers[3],
			providerUsageReportedness,
		});

	it('reads a row with no provider usage as absent in every class', () => {
		expect(readings(passthroughProxyRow())).toEqual(['absent', 'absent', 'absent', 'absent']);
		expect(hasValue(passthroughProxyRow())).toEqual([false, false, false, false]);
	});

	it('reads a row written before reportedness was tracked as legacy, never as reported', () => {
		// Its zero cache writes may be a class the answer never named.
		const row = legacyProxyRow();
		expect(row.providerCacheWriteTokens).toBe(0);
		expect(readings(row)).toEqual(['legacy', 'legacy', 'legacy', 'legacy']);
		expect(hasValue(row)).toEqual([false, false, false, false]);
	});

	it('reads a class the stored record leaves out as legacy', () => {
		const partial = { output: 'reported' } as unknown as ProxyProviderReportedness;
		expect(readings(answered([0, 0, 0, 7], partial))).toEqual([
			'legacy',
			'legacy',
			'legacy',
			'reported',
		]);
	});

	it('keeps an output-only answer from becoming a known zero input', () => {
		const row = answered([0, 0, 0, 7], {
			input: 'unreported',
			cacheRead: 'unreported',
			cacheWrite: 'unreported',
			output: 'reported',
		});
		expect(readings(row)).toEqual(['unreported', 'unreported', 'unreported', 'reported']);
		expect(hasValue(row)).toEqual([false, false, false, true]);
	});

	it('keeps an input-only answer from becoming a known zero output', () => {
		const row = answered([5, 0, 0, 0], {
			input: 'reported',
			cacheRead: 'unreported',
			cacheWrite: 'unreported',
			output: 'unreported',
		});
		expect(readings(row)).toEqual(['reported', 'unreported', 'unreported', 'unreported']);
		expect(hasValue(row)).toEqual([true, false, false, false]);
	});

	it('does not take an OpenAI prompt total with no cache detail for an uncached split', () => {
		const row = answered([0, 0, 0, 3], {
			input: 'unreported',
			cacheRead: 'unreported',
			cacheWrite: 'not-applicable',
			output: 'reported',
		});
		expect(readings(row)).toEqual(['unreported', 'unreported', 'not-applicable', 'reported']);
		// Cache writes are zero by definition there; the uncached split is not known.
		expect(hasValue(row)).toEqual([false, false, true, true]);
	});

	it('tells a derived class, a class the provider lacks and a reported zero apart', () => {
		const row = answered([20, 0, 0, 3], {
			input: 'derived',
			cacheRead: 'reported',
			cacheWrite: 'not-applicable',
			output: 'reported',
		});
		// A cached count of 0 was named by the provider: that zero is known.
		expect(readings(row)).toEqual(['derived', 'reported', 'not-applicable', 'reported']);
		expect(hasValue(row)).toEqual([true, true, true, true]);
	});

	it('reads a current row as reported in every class', () => {
		expect(readings(currentProxyRow())).toEqual(['reported', 'reported', 'reported', 'reported']);
	});

	it('labels every reading, the stored statuses and the two a reader adds', () => {
		expect(Object.keys(TOKEN_PROXY_PROVIDER_CLASS_LABELS).sort()).toEqual(
			['absent', 'derived', 'legacy', 'not-applicable', 'reported', 'unreported'].sort()
		);
		for (const label of Object.values(TOKEN_PROXY_PROVIDER_CLASS_LABELS)) {
			expect(label.length).toBeGreaterThan(0);
		}
		expect(TOKEN_PROXY_PROVIDER_CLASS_LABELS.unreported).toContain('unknown, not zero');
		expect(TOKEN_PROXY_PROVIDER_CLASS_LABELS.legacy).toContain('unknown');
	});
});
