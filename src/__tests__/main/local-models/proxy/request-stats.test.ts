/**
 * @file request-stats.test.ts
 *
 * What the token proxy writes to `proxy_requests` for one request, and that
 * the write can never fail the request: which requests are recorded at all,
 * how a server log entry maps to a row, the `statsCollectionEnabled` gate, and
 * a database that is not ready or throws.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({ logger }));

const sentry = vi.hoisted(() => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(async () => {}),
}));
vi.mock('../../../../main/utils/sentry', () => sentry);

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (key: string) => settings.values[key] }),
}));

const statsDb = vi.hoisted(() => ({
	isReady: vi.fn(() => true),
	recordProxyRequest: vi.fn(() => 'row-id'),
	getProxyRequestUsage: vi.fn(),
	getRecentProxyCompressions: vi.fn(),
}));
vi.mock('../../../../main/stats/singleton', () => ({ getStatsDB: () => statsDb }));

import {
	proxyRequestFromLog,
	readTokenProxyUsage,
	recordTokenProxyRequest,
	TOKEN_PROXY_RECENT_COMPRESSIONS,
	TOKEN_PROXY_USAGE_RANGE,
} from '../../../../main/local-models/proxy/request-stats';
import type { CompressRequestStats } from '../../../../main/local-models/proxy/compress';
import type { TokenProxyRequestLog } from '../../../../main/local-models/proxy/server';
import {
	proxyBlockCountsProblem,
	TOKEN_PROXY_MODES,
	TOKEN_PROXY_SKIP_REASONS,
} from '../../../../shared/local-models/token-proxy';
import { stringPaths } from '../../../helpers/proxyTelemetryFixtures';

function logEntry(overrides: Partial<TokenProxyRequestLog> = {}): TokenProxyRequestLog {
	return {
		route: 'anthropic',
		kind: 'anthropic-messages',
		agentId: 'agent-1',
		mode: 'passthrough',
		startedAt: 1_000,
		method: 'POST',
		path: '/v1/messages',
		status: 200,
		requestBytes: 4_000,
		sentBytes: 4_000,
		responseBytes: 600,
		durationMs: 250,
		outcome: 'completed',
		...overrides,
	};
}

const freshBlock = {
	hash: 'a'.repeat(64),
	originalTokens: 2_000,
	compressedTokens: 250,
	compressors: ['logs' as const],
	cached: false,
};
const cachedBlock = { ...freshBlock, hash: 'b'.repeat(64), cached: true };

function compressedEntry(): TokenProxyRequestLog {
	return logEntry({
		mode: 'compress',
		sentBytes: 2_600,
		compression: {
			changed: true,
			addedLatencyMs: 12,
			originalTokens: 1_000,
			sentTokens: 650,
			blocks: [freshBlock, cachedBlock],
			stats: {
				protected: 1,
				candidates: 3,
				belowThreshold: 1,
				compressed: 2,
				kept: 0,
				cacheHits: 1,
				originalTokens: 4_000,
				compressedTokens: 500,
				compressors: {
					json: 0,
					logs: 2,
					'long-lines': 0,
					model: 0,
					'git-status': 0,
					'git-log': 0,
					search: 0,
					'test-output': 0,
					'build-output': 0,
					'lint-output': 0,
					'json-table': 0,
				},
				modelFailures: 0,
				storeFailures: 0,
			},
		},
	});
}

/**
 * The request {@link compressedEntry} stands for, run in `mode` with the
 * compressor's counts changed as asked. Its default counts obey the contract.
 */
function entryWith(
	mode: TokenProxyRequestLog['mode'],
	stats: Partial<CompressRequestStats> = {},
	compression: Partial<NonNullable<TokenProxyRequestLog['compression']>> = {}
): TokenProxyRequestLog {
	const base = compressedEntry();
	return {
		...base,
		mode,
		compression: {
			...base.compression!,
			...compression,
			stats: { ...base.compression!.stats!, ...stats },
		},
	};
}

/** An entry that throws when its compression is read: a fault the mapping must contain. */
function faultyEntry(): TokenProxyRequestLog {
	const entry = logEntry({ mode: 'compress' });
	Object.defineProperty(entry, 'compression', {
		get() {
			throw new Error('bad entry');
		},
	});
	return entry;
}

beforeEach(() => {
	vi.clearAllMocks();
	settings.values = {};
	statsDb.isReady.mockReturnValue(true);
});

describe('proxyRequestFromLog', () => {
	it('records a passthrough request in bytes, with no tokens', () => {
		expect(proxyRequestFromLog(logEntry())).toEqual({
			agentId: 'agent-1',
			route: 'anthropic',
			kind: 'anthropic-messages',
			mode: 'passthrough',
			// The mode in force is stated for a request that was only counted too; the
			// counts are not, because nothing was read.
			effectiveMode: 'passthrough',
			startedAt: 1_000,
			durationMs: 250,
			status: 200,
			outcome: 'completed',
			requestBytes: 4_000,
			sentBytes: 4_000,
			responseBytes: 600,
			blocksCompressed: 0,
			cacheHits: 0,
		});
	});

	it('records an early request as compress: the table says whether the body was shortened', () => {
		expect(proxyRequestFromLog({ ...compressedEntry(), mode: 'compress-early' })).toMatchObject({
			mode: 'compress',
			blocksCompressed: 2,
		});
	});

	it('records what compress mode read, sent and newly shortened', () => {
		expect(proxyRequestFromLog(compressedEntry())).toMatchObject({
			mode: 'compress',
			requestBytes: 4_000,
			sentBytes: 2_600,
			originalTokens: 1_000,
			sentTokens: 650,
			addedLatencyMs: 12,
			blocksCompressed: 2,
			cacheHits: 1,
			compressorCounts: { json: 0, logs: 2, 'long-lines': 0, model: 0 },
			// A block that came from the cache was listed by the request that
			// first shortened it. Listing it again would repeat it on every turn.
			newBlocks: [
				{
					hash: freshBlock.hash,
					originalTokens: 2_000,
					compressedTokens: 250,
					compressors: ['logs'],
				},
			],
		});
	});

	it.each([
		'git-status',
		'git-log',
		'search',
		'test-output',
		'build-output',
		'lint-output',
		'json-table',
	] as const)(
		'carries %s counts and new-block attribution through the existing request ledger',
		(compressor) => {
			const entry = compressedEntry();
			const compression = entry.compression!;
			if (!compression.stats || !compression.blocks) throw new Error('Missing compression fixture');
			compression.stats.compressors = {
				...compression.stats.compressors,
				logs: 0,
				[compressor]: 2,
			};
			compression.blocks = compression.blocks.map((block) => ({
				...block,
				compressors: [compressor],
			}));
			const row = proxyRequestFromLog(entry);
			expect(row?.compressorCounts).toEqual(compression.stats.compressors);
			expect(row?.newBlocks).toEqual([
				{
					hash: freshBlock.hash,
					originalTokens: 2000,
					compressedTokens: 250,
					compressors: [compressor],
				},
			]);
		}
	);

	it('records the target of a routed request, and nothing for one that stayed', () => {
		const routed = proxyRequestFromLog(
			logEntry({
				sentBytes: 3_980,
				background: { routedTo: 'maestro-server:qwen3.5-4b', addedLatencyMs: 40 },
			})
		);
		expect(routed).toMatchObject({
			mode: 'passthrough',
			sentBytes: 3_980,
			routedTo: 'maestro-server:qwen3.5-4b',
		});

		// A turn of the same agent: read for routing, sent to the provider.
		const stayed = proxyRequestFromLog(
			logEntry({ background: { skipped: 'tool-result', addedLatencyMs: 1 } })
		);
		expect(stayed).not.toHaveProperty('routedTo');
	});

	it('keeps the target on a routed request whose target failed', () => {
		expect(
			proxyRequestFromLog(
				logEntry({
					status: 502,
					sentBytes: 0,
					outcome: 'upstream-failed',
					background: { routedTo: 'ep-ollama:qwen3:4b', addedLatencyMs: 3 },
				})
			)
		).toMatchObject({ outcome: 'upstream-failed', routedTo: 'ep-ollama:qwen3:4b' });
	});

	it("records the provider's own counts when its answer named them", () => {
		const row = proxyRequestFromLog(
			logEntry({
				providerUsage: {
					inputTokens: 7,
					cacheReadTokens: 900,
					cacheWriteTokens: 40,
					outputTokens: 55,
				},
			})
		);
		expect(row).toMatchObject({
			providerInputTokens: 7,
			providerCacheReadTokens: 900,
			providerCacheWriteTokens: 40,
			providerOutputTokens: 55,
		});
		expect(proxyRequestFromLog(logEntry())).not.toHaveProperty('providerInputTokens');
	});

	it('leaves the agent out of a request that named none', () => {
		const row = proxyRequestFromLog(logEntry({ agentId: null }));
		expect(row).not.toBeNull();
		expect(row).not.toHaveProperty('agentId');
	});

	it('records why a compress mode request was forwarded unread, with no tokens', () => {
		const row = proxyRequestFromLog(
			logEntry({
				mode: 'compress',
				compression: { skipped: 'encoding', changed: false, addedLatencyMs: 1 },
			})
		);
		expect(row).toMatchObject({ mode: 'compress', skipReason: 'encoding', blocksCompressed: 0 });
		expect(row).not.toHaveProperty('originalTokens');
		expect(row).not.toHaveProperty('addedLatencyMs');
	});

	it('does not record a request with no message list, or one that named no route', () => {
		expect(proxyRequestFromLog(logEntry({ kind: 'other' }))).toBeNull();
		expect(proxyRequestFromLog(logEntry({ route: null, kind: 'other' }))).toBeNull();
	});
});

describe('proxyRequestFromLog: the mode in force and the block counts', () => {
	/** Counts that obey every rule, for a request that found nothing to count. */
	const NOTHING_COUNTED: Partial<CompressRequestStats> = {
		protected: 0,
		candidates: 0,
		belowThreshold: 0,
		compressed: 0,
		kept: 0,
		cacheHits: 0,
	};

	it('has a pairing below for every mode a request can be carried in', () => {
		// `off` is the setting of an agent that is not pointed at the proxy: no request carries it.
		expect(TOKEN_PROXY_MODES.filter((mode) => mode !== 'off').sort()).toEqual([
			'compress',
			'compress-early',
			'passthrough',
		]);
	});

	it.each([
		['passthrough', 'passthrough'],
		['compress', 'compress'],
		['compress-early', 'compress'],
	] as const)('states %s as the mode in force, and stores %s as the mode', (effective, stored) => {
		const entry =
			effective === 'passthrough' ? logEntry({ mode: effective }) : entryWith(effective);
		expect(proxyRequestFromLog(entry)).toMatchObject({ effectiveMode: effective, mode: stored });
	});

	it('states what the compressor counted, with a veto it never applied as zero', () => {
		const row = proxyRequestFromLog(entryWith('compress'));

		expect(row?.blockCounts).toEqual({
			protected: 1,
			vetoed: { failed: 0, recovery: 0, retrieval: 0 },
			candidates: 3,
			belowThreshold: 1,
			kept: 0,
			storeFailed: 0,
			modelFailed: 0,
		});
		// The blocks shortened are the row's own count and are not repeated in the block counts.
		expect(row).toMatchObject({ blocksCompressed: 2, cacheHits: 1 });
	});

	it('carries every veto the compressor applied, and its store and model failures', () => {
		const row = proxyRequestFromLog(
			entryWith('compress', {
				protected: 4,
				candidates: 6,
				belowThreshold: 2,
				compressed: 2,
				kept: 1,
				cacheHits: 2,
				storeFailures: 1,
				modelFailures: 1,
				eligibilityVetoes: { failed: 2, recovery: 1, retrieval: 3 },
			})
		);

		expect(row?.blockCounts).toEqual({
			protected: 4,
			vetoed: { failed: 2, recovery: 1, retrieval: 3 },
			candidates: 6,
			belowThreshold: 2,
			kept: 1,
			storeFailed: 1,
			modelFailed: 1,
		});
	});

	it('reads a veto list that never named the retrieval veto as zero retrievals', () => {
		const row = proxyRequestFromLog(
			entryWith('compress', { eligibilityVetoes: { failed: 1, recovery: 0 } })
		);
		expect(row?.blockCounts?.vetoed).toEqual({ failed: 1, recovery: 0, retrieval: 0 });
	});

	it('states the zero protected blocks of an early request as a count', () => {
		const row = proxyRequestFromLog(entryWith('compress-early', { protected: 0 }));
		expect(row).toMatchObject({ effectiveMode: 'compress-early', blockCounts: { protected: 0 } });
	});

	it('keeps a count of zero apart from an unknown', () => {
		// The compressor ran and found nothing: every count is a real 0.
		expect(proxyRequestFromLog(entryWith('compress', NOTHING_COUNTED))?.blockCounts).toEqual({
			protected: 0,
			vetoed: { failed: 0, recovery: 0, retrieval: 0 },
			candidates: 0,
			belowThreshold: 0,
			kept: 0,
			storeFailed: 0,
			modelFailed: 0,
		});
		// Nobody read the body of a passthrough request: there is nothing to count.
		expect(proxyRequestFromLog(logEntry())).not.toHaveProperty('blockCounts');
	});

	describe.each(['compress', 'compress-early'] as const)(
		'a %s request forwarded as it arrived',
		(mode) => {
			it.each(TOKEN_PROXY_SKIP_REASONS)(
				'keeps the mode and states no counts: skipped as %s',
				(reason) => {
					const row = proxyRequestFromLog(
						logEntry({
							mode,
							compression: { skipped: reason, changed: false, addedLatencyMs: 2 },
						})
					);

					expect(row).toMatchObject({
						mode: 'compress',
						effectiveMode: mode,
						skipReason: reason,
						blocksCompressed: 0,
					});
					expect(row).not.toHaveProperty('blockCounts');
					expect(row).not.toHaveProperty('originalTokens');
				}
			);
		}
	);

	describe('a request forwarded as it arrived after its compressor had returned', () => {
		// The attempt shortened two blocks, then a failure sent the original: nothing the
		// attempt counted describes what went out.
		it.each(TOKEN_PROXY_SKIP_REASONS)(
			'credits no reduction when it was skipped as %s, whatever the attempt counted',
			(reason) => {
				const row = proxyRequestFromLog(
					entryWith('compress', {}, { skipped: reason, error: 'late failure', changed: false })
				)!;

				expect(row).toMatchObject({
					mode: 'compress',
					effectiveMode: 'compress',
					skipReason: reason,
					blocksCompressed: 0,
					cacheHits: 0,
					// Nothing was removed: the same estimate before and after.
					originalTokens: 1_000,
					sentTokens: 1_000,
					// How long the request was held is still true.
					addedLatencyMs: 12,
				});
				for (const field of ['blockCounts', 'newBlocks', 'compressorCounts']) {
					expect(row).not.toHaveProperty(field);
				}
			}
		);

		it('still credits the same attempt when its body is the one that went out', () => {
			// The positive control: only the skip takes the credit away.
			const row = proxyRequestFromLog(entryWith('compress'))!;

			expect(row).toMatchObject({ blocksCompressed: 2, cacheHits: 1, sentTokens: 650 });
			expect(row.newBlocks).toHaveLength(1);
			expect(row.blockCounts).toBeDefined();
		});

		it('leaves the estimates out when the compressor never returned them', () => {
			const row = proxyRequestFromLog(
				logEntry({
					mode: 'compress',
					compression: { skipped: 'failed', error: 'boom', changed: false, addedLatencyMs: 3 },
				})
			)!;

			expect(row).toMatchObject({ effectiveMode: 'compress', skipReason: 'failed' });
			expect(row).not.toHaveProperty('originalTokens');
			expect(row).not.toHaveProperty('sentTokens');
			expect(row).not.toHaveProperty('addedLatencyMs');
		});
	});

	it('states the mode and no counts for a compress request a background target answered', () => {
		const row = proxyRequestFromLog(
			logEntry({
				mode: 'compress',
				background: { routedTo: 'maestro-server:qwen3.5-4b', addedLatencyMs: 40 },
			})
		);

		expect(row).toMatchObject({
			mode: 'compress',
			effectiveMode: 'compress',
			routedTo: 'maestro-server:qwen3.5-4b',
		});
		expect(row).not.toHaveProperty('blockCounts');
	});

	it.each([
		['candidates that are not their parts', { candidates: 4 }, /candidates must equal/],
		['more cache hits than blocks decided', { cacheHits: 3 }, /cacheHits cannot exceed/],
		['more model failures than blocks decided', { modelFailures: 3 }, /modelFailed cannot exceed/],
		['a negative count', { protected: -1 }, /non-negative integer/],
		['a fractional count', { belowThreshold: 1.5 }, /non-negative integer/],
		['a count that is not a number', { kept: Number.NaN }, /non-negative integer/],
	] as const)('stores no counts that break a rule, and reports it: %s', (_name, broken, rule) => {
		const row = proxyRequestFromLog(entryWith('compress', broken));

		// Counts that disagree are worse than none, and the rest of the row is unharmed.
		expect(row).not.toHaveProperty('blockCounts');
		expect(row).toMatchObject({
			effectiveMode: 'compress',
			originalTokens: 1_000,
			sentTokens: 650,
			addedLatencyMs: 12,
		});
		expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(rule), '[TokenProxy]');
		expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
		expect(sentry.captureMessage).toHaveBeenCalledWith(
			'Token proxy block counts break the telemetry contract',
			'warning',
			{
				problem: expect.stringMatching(rule),
				route: 'anthropic',
				kind: 'anthropic-messages',
				mode: 'compress',
			}
		);
	});

	it('reports nothing for counts that hold', () => {
		proxyRequestFromLog(entryWith('compress'));
		proxyRequestFromLog(entryWith('compress-early', { protected: 0 }));
		proxyRequestFromLog(entryWith('compress', NOTHING_COUNTED));

		expect(logger.warn).not.toHaveBeenCalled();
		expect(sentry.captureMessage).not.toHaveBeenCalled();
	});

	it('emits only counts the contract accepts', () => {
		for (const entry of [
			entryWith('compress'),
			entryWith('compress-early', { protected: 0 }),
			entryWith('compress', NOTHING_COUNTED),
			entryWith('compress', {
				candidates: 6,
				belowThreshold: 2,
				compressed: 2,
				kept: 1,
				storeFailures: 1,
				cacheHits: 2,
				eligibilityVetoes: { failed: 2, recovery: 1, retrieval: 3 },
			}),
		]) {
			const row = proxyRequestFromLog(entry);
			expect(row?.blockCounts).toBeDefined();
			expect(proxyBlockCountsProblem(row!)).toBeNull();
		}
	});

	it('does not share the compressor’s objects with the row', () => {
		const entry = entryWith('compress', {
			eligibilityVetoes: { failed: 1, recovery: 0, retrieval: 0 },
		});
		const row = proxyRequestFromLog(entry)!;

		entry.compression!.stats!.eligibilityVetoes!.failed = 99;
		entry.compression!.stats!.protected = 99;

		expect(row.blockCounts?.vetoed.failed).toBe(1);
		expect(row.blockCounts?.protected).toBe(1);
	});

	it('holds no text of the request: its strings are the closed set the contract allows', () => {
		const paths = stringPaths(proxyRequestFromLog(entryWith('compress-early')));

		expect([...paths].sort()).toEqual(
			[
				'agentId',
				'route',
				'kind',
				'mode',
				'effectiveMode',
				'outcome',
				'newBlocks[].hash',
				'newBlocks[].compressors[]',
			].sort()
		);
	});
});

describe('recordTokenProxyRequest', () => {
	it('writes one row for a request that holds a message list', () => {
		recordTokenProxyRequest(compressedEntry());

		expect(statsDb.recordProxyRequest).toHaveBeenCalledTimes(1);
		expect(statsDb.recordProxyRequest).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: 'agent-1', mode: 'compress', sentTokens: 650 })
		);
	});

	it('writes nothing for a request that is not recorded', () => {
		recordTokenProxyRequest(logEntry({ kind: 'other' }));
		expect(statsDb.recordProxyRequest).not.toHaveBeenCalled();
	});

	it('writes nothing when usage statistics are off', () => {
		settings.values = { statsCollectionEnabled: false };
		recordTokenProxyRequest(logEntry());
		expect(statsDb.recordProxyRequest).not.toHaveBeenCalled();
	});

	it('writes nothing while the database is not ready', () => {
		statsDb.isReady.mockReturnValue(false);
		recordTokenProxyRequest(logEntry());
		expect(statsDb.recordProxyRequest).not.toHaveBeenCalled();
	});

	it('swallows a failed write and reports it, so the request is not failed by it', () => {
		statsDb.recordProxyRequest.mockImplementationOnce(() => {
			throw new Error('disk full');
		});

		expect(() => recordTokenProxyRequest(logEntry())).not.toThrow();

		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk full'), '[TokenProxy]');
		expect(sentry.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'stats:recordProxyRequest' })
		);
	});

	it('writes the mode in force and the block counts of a request it read', () => {
		recordTokenProxyRequest(entryWith('compress-early', { protected: 0 }));

		expect(statsDb.recordProxyRequest).toHaveBeenCalledTimes(1);
		expect(statsDb.recordProxyRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: 'compress',
				effectiveMode: 'compress-early',
				blockCounts: expect.objectContaining({ protected: 0, candidates: 3 }),
			})
		);
	});

	it('contains a fault of the mapping itself: it runs in the server’s close handler', () => {
		expect(() => recordTokenProxyRequest(faultyEntry())).not.toThrow();

		expect(statsDb.recordProxyRequest).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad entry'), '[TokenProxy]');
		expect(sentry.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'stats:recordProxyRequest', route: 'anthropic' })
		);
	});

	it('maps nothing, and reads nothing of the entry, while usage statistics are off', () => {
		settings.values = { statsCollectionEnabled: false };

		expect(() => recordTokenProxyRequest(faultyEntry())).not.toThrow();

		expect(statsDb.recordProxyRequest).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		expect(sentry.captureException).not.toHaveBeenCalled();
		expect(sentry.captureMessage).not.toHaveBeenCalled();
	});

	it('maps nothing while the database is not ready', () => {
		statsDb.isReady.mockReturnValue(false);

		expect(() => recordTokenProxyRequest(faultyEntry())).not.toThrow();

		expect(statsDb.recordProxyRequest).not.toHaveBeenCalled();
		expect(sentry.captureException).not.toHaveBeenCalled();
	});

	it('reports counts that break a rule once, and still writes the request without them', () => {
		recordTokenProxyRequest(entryWith('compress', { candidates: 9 }));

		expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
		expect(statsDb.recordProxyRequest).toHaveBeenCalledTimes(1);
		const written = (statsDb.recordProxyRequest.mock.calls as unknown[][])[0][0];
		expect(written).toMatchObject({ effectiveMode: 'compress', originalTokens: 1_000 });
		expect(written).not.toHaveProperty('blockCounts');
	});
});

describe('readTokenProxyUsage', () => {
	it('reads the totals and the recent compressions', () => {
		const usage = { range: 'month', totals: {}, byAgent: [] };
		const recent = [{ hash: 'a'.repeat(64) }];
		statsDb.getProxyRequestUsage.mockReturnValue(usage);
		statsDb.getRecentProxyCompressions.mockReturnValue(recent);

		expect(readTokenProxyUsage()).toEqual({ usage, recentCompressions: recent });
		expect(statsDb.getProxyRequestUsage).toHaveBeenCalledWith(TOKEN_PROXY_USAGE_RANGE);
		expect(statsDb.getRecentProxyCompressions).toHaveBeenCalledWith(
			TOKEN_PROXY_RECENT_COMPRESSIONS
		);
	});

	it('answers no usage, never a throw, when the database is not ready or fails', () => {
		statsDb.isReady.mockReturnValue(false);
		expect(readTokenProxyUsage()).toEqual({ usage: null, recentCompressions: [] });

		statsDb.isReady.mockReturnValue(true);
		statsDb.getProxyRequestUsage.mockImplementationOnce(() => {
			throw new Error('locked');
		});
		expect(readTokenProxyUsage()).toEqual({ usage: null, recentCompressions: [] });
	});
});
