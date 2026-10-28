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

const sentry = vi.hoisted(() => ({ captureException: vi.fn(async () => {}) }));
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
import type { TokenProxyRequestLog } from '../../../../main/local-models/proxy/server';

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
				candidates: 3,
				belowThreshold: 1,
				compressed: 2,
				kept: 0,
				cacheHits: 1,
				originalTokens: 4_000,
				compressedTokens: 500,
				compressors: { json: 0, logs: 2, 'long-lines': 0, model: 0 },
				modelFailures: 0,
				storeFailures: 0,
			},
		},
	});
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
