/**
 * Tests for token proxy request recording (`proxy_requests`).
 *
 * better-sqlite3 is compiled for Electron's Node, so these drive the module
 * against a fake `Database` and assert on the bound parameters and the row
 * mapping, the two places a request can be silently corrupted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
	recordProxyRequest,
	getProxyRequestUsage,
	getRecentProxyCompressions,
	clearProxyRequestsCache,
} from '../../../main/stats/proxy-requests';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/stats/utils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/stats/utils')>()),
	generateId: () => 'request-id',
}));

const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(),
	all: vi.fn(() => [] as unknown[]),
};

const mockDb = {
	prepare: vi.fn(() => mockStatement),
} as unknown as Database.Database;

const block = {
	hash: 'a'.repeat(64),
	originalTokens: 2400,
	compressedTokens: 300,
	compressors: ['logs'],
};

describe('proxy-requests', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearProxyRequestsCache();
		mockStatement.all.mockReturnValue([]);
	});

	describe('recordProxyRequest', () => {
		it('binds a compressed request in schema order and returns the generated id', () => {
			const id = recordProxyRequest(mockDb, {
				agentId: 'agent-1',
				route: 'anthropic',
				kind: 'anthropic-messages',
				mode: 'compress',
				startedAt: 1_000,
				durationMs: 812.6,
				status: 200,
				outcome: 'completed',
				requestBytes: 40_000,
				sentBytes: 31_000,
				responseBytes: 900,
				originalTokens: 10_000,
				sentTokens: 7_750,
				addedLatencyMs: 11.4,
				blocksCompressed: 2,
				cacheHits: 1,
				compressorCounts: { json: 0, logs: 2, 'long-lines': 0, model: 0 },
				newBlocks: [block],
				effectiveMode: 'compress-early',
				blockCounts: {
					protected: 0,
					vetoed: { failed: 1, recovery: 2, retrieval: 3 },
					candidates: 7,
					belowThreshold: 3,
					kept: 1,
					storeFailed: 1,
					modelFailed: 1,
				},
			});

			expect(id).toBe('request-id');
			expect(mockStatement.run).toHaveBeenCalledWith(
				'request-id',
				'agent-1',
				'anthropic',
				'anthropic-messages',
				'compress',
				1_000,
				813,
				200,
				'completed',
				40_000,
				31_000,
				900,
				10_000,
				7_750,
				11,
				2,
				1,
				JSON.stringify({ json: 0, logs: 2, 'long-lines': 0, model: 0 }),
				JSON.stringify([block]),
				null,
				// It went to the provider.
				null,
				// The provider's own counts were not given.
				null,
				null,
				null,
				null,
				// The mode in force, which `mode` cannot say for the two compress modes.
				'compress-early',
				// The nine block counts: protected, the three vetoes, then the partition of
				// the candidates. A counted zero is 0.
				0,
				1,
				2,
				3,
				7,
				3,
				1,
				1,
				1,
				// No record of how the provider's counts were given: there are none.
				null,
				null,
				null,
				null
			);
		});

		it('stores NULL for everything a passthrough request does not have', () => {
			recordProxyRequest(mockDb, {
				route: 'openai',
				kind: 'openai-responses',
				mode: 'passthrough',
				startedAt: 2_000,
				durationMs: 50,
				status: 200,
				outcome: 'completed',
				requestBytes: 500,
				sentBytes: 500,
				responseBytes: 70,
				blocksCompressed: 0,
				cacheHits: 0,
			});

			expect(mockStatement.run).toHaveBeenCalledWith(
				'request-id',
				// No agent, no tokens, no latency: the body was never read.
				null,
				'openai',
				'openai-responses',
				'passthrough',
				2_000,
				50,
				200,
				'completed',
				500,
				500,
				70,
				null,
				null,
				null,
				0,
				0,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				// A request that states none of the telemetry stores all fourteen as unknown.
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null,
				null
			);
		});

		it('binds the provider counts and how each got its number, in schema order', () => {
			recordProxyRequest(mockDb, {
				route: 'anthropic',
				kind: 'anthropic-messages',
				mode: 'passthrough',
				effectiveMode: 'passthrough',
				startedAt: 3_000,
				durationMs: 20,
				status: 200,
				outcome: 'completed',
				requestBytes: 100,
				sentBytes: 100,
				responseBytes: 40,
				blocksCompressed: 0,
				cacheHits: 0,
				providerInputTokens: 0,
				providerCacheReadTokens: 900,
				providerCacheWriteTokens: 0,
				providerOutputTokens: 55,
				providerUsageReportedness: {
					input: 'unreported',
					cacheRead: 'derived',
					cacheWrite: 'not-applicable',
					output: 'reported',
				},
			});

			const bound = mockStatement.run.mock.calls[0] as unknown[];
			// The four provider counts, then the mode in force, nine unknown counts, and one
			// reportedness per class in the same order as the counts.
			expect(bound.slice(21)).toEqual([
				0,
				900,
				0,
				55,
				'passthrough',
				...Array<null>(9).fill(null),
				'unreported',
				'derived',
				'not-applicable',
				'reported',
			]);
		});

		it('stores the blocks of a request that found none as zeros, apart from a request that has no counts', () => {
			const counted = {
				protected: 0,
				vetoed: { failed: 0, recovery: 0, retrieval: 0 },
				candidates: 0,
				belowThreshold: 0,
				kept: 0,
				storeFailed: 0,
				modelFailed: 0,
			};
			const base = {
				route: 'anthropic',
				kind: 'anthropic-messages',
				mode: 'compress' as const,
				effectiveMode: 'compress' as const,
				startedAt: 4_000,
				durationMs: 20,
				status: 200,
				outcome: 'completed',
				requestBytes: 100,
				sentBytes: 100,
				responseBytes: 40,
				blocksCompressed: 0,
				cacheHits: 0,
			};

			recordProxyRequest(mockDb, { ...base, blockCounts: counted });
			recordProxyRequest(mockDb, base);

			const [withCounts, without] = (mockStatement.run.mock.calls as unknown[][]).map((call) =>
				call.slice(26, 35)
			);
			expect(withCounts).toEqual(Array<number>(9).fill(0));
			expect(without).toEqual(Array<null>(9).fill(null));
		});

		it('fills every column of the table with one placeholder each', () => {
			recordProxyRequest(mockDb, {
				route: 'anthropic',
				kind: 'anthropic-messages',
				mode: 'passthrough',
				startedAt: 5_000,
				durationMs: 20,
				status: 200,
				outcome: 'completed',
				requestBytes: 100,
				sentBytes: 100,
				responseBytes: 40,
				blocksCompressed: 0,
				cacheHits: 0,
			});

			const sql = String(vi.mocked(mockDb.prepare).mock.calls[0][0]);
			const columns = /\(([^)]*)\)\s*VALUES/
				.exec(sql)![1]
				.split(',')
				.map((column) => column.trim());
			const placeholders = /VALUES\s*\(([^)]*)\)/.exec(sql)![1].split(',');

			expect(columns).toHaveLength(39);
			expect(new Set(columns).size).toBe(39);
			expect(placeholders).toHaveLength(39);
			expect(mockStatement.run.mock.calls[0]).toHaveLength(39);
			for (const column of ['id', 'blocks_compressed', 'effective_mode', 'blocks_model_failed']) {
				expect(columns).toContain(column);
			}
			expect(columns.slice(-4)).toEqual([
				'provider_input_reportedness',
				'provider_cache_read_reportedness',
				'provider_cache_write_reportedness',
				'provider_output_reportedness',
			]);
		});

		it('stores the target of a request that was routed, in its own column', () => {
			recordProxyRequest(mockDb, {
				agentId: 'agent-1',
				route: 'anthropic',
				kind: 'anthropic-messages',
				mode: 'passthrough',
				startedAt: 4_000,
				durationMs: 300,
				status: 200,
				outcome: 'completed',
				requestBytes: 900,
				sentBytes: 880,
				responseBytes: 120,
				blocksCompressed: 0,
				cacheHits: 0,
				routedTo: 'maestro-server:qwen3.5-4b',
			});

			const sql = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
			// One placeholder per column, and the target bound where its column is.
			const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',');
			const names = columns.map((column) => column.trim());
			expect(sql.match(/\?/g)).toHaveLength(columns.length);
			const bound = mockStatement.run.mock.calls[0] as unknown[];
			expect(bound).toHaveLength(columns.length);
			expect(bound[names.indexOf('routed_to')]).toBe('maestro-server:qwen3.5-4b');
		});

		it("stores the provider's own counts where the answer named them", () => {
			recordProxyRequest(mockDb, {
				route: 'anthropic',
				kind: 'anthropic-messages',
				mode: 'passthrough',
				startedAt: 5_000,
				durationMs: 900,
				status: 200,
				outcome: 'completed',
				requestBytes: 900,
				sentBytes: 900,
				responseBytes: 4_000,
				blocksCompressed: 0,
				cacheHits: 0,
				providerInputTokens: 12,
				providerCacheReadTokens: 26_102,
				providerCacheWriteTokens: 1_750,
				providerOutputTokens: 214,
			});
			const sql = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
			const names = sql
				.slice(sql.indexOf('(') + 1, sql.indexOf(')'))
				.split(',')
				.map((column) => column.trim());
			const bound = mockStatement.run.mock.calls[0] as unknown[];
			expect(
				[
					'provider_input_tokens',
					'provider_cache_read_tokens',
					'provider_cache_write_tokens',
					'provider_output_tokens',
				].map((column) => bound[names.indexOf(column)])
			).toEqual([12, 26_102, 1_750, 214]);
		});

		it('stores no JSON for counts that are all zero or a block list that is empty', () => {
			recordProxyRequest(mockDb, {
				agentId: 'agent-1',
				route: 'anthropic',
				kind: 'anthropic-messages',
				mode: 'compress',
				startedAt: 3_000,
				durationMs: 9,
				status: 200,
				outcome: 'completed',
				requestBytes: 100,
				sentBytes: 100,
				responseBytes: 10,
				originalTokens: 25,
				sentTokens: 25,
				addedLatencyMs: 0,
				blocksCompressed: 0,
				cacheHits: 0,
				compressorCounts: { json: 0, logs: 0, 'long-lines': 0, model: 0 },
				newBlocks: [],
				skipReason: 'encoding',
			});

			const bound = mockStatement.run.mock.calls[0] as unknown[];
			// A zero is a measurement and is kept; an empty summary is not stored.
			expect(bound.slice(12, 15)).toEqual([25, 25, 0]);
			expect(bound.slice(17, 21)).toEqual([null, null, 'encoding', null]);
		});
	});

	describe('getProxyRequestUsage', () => {
		it('sums per agent and in total, counting tokens only where the body was read', () => {
			mockStatement.all.mockReturnValue([
				{
					agent_id: 'agent-1',
					requests: 10,
					compress_requests: 4,
					original_tokens: 40_000,
					sent_tokens: 30_000,
					added_latency_ms: 50,
					provider_requests: 9,
					provider_input_tokens: 120,
					provider_cache_read_tokens: 90_000,
					provider_cache_write_tokens: 8_000,
					provider_output_tokens: 2_000,
				},
				{
					agent_id: null,
					requests: 3,
					compress_requests: 0,
					original_tokens: 0,
					sent_tokens: 0,
					added_latency_ms: 0,
					provider_requests: 0,
					provider_input_tokens: 0,
					provider_cache_read_tokens: 0,
					provider_cache_write_tokens: 0,
					provider_output_tokens: 0,
				},
			]);
			const none = {
				requests: 0,
				inputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 0,
			};
			const agentOne = {
				requests: 9,
				inputTokens: 120,
				cacheReadTokens: 90_000,
				cacheWriteTokens: 8_000,
				outputTokens: 2_000,
			};

			const usage = getProxyRequestUsage(mockDb, 'month');

			expect(usage.range).toBe('month');
			expect(usage.byAgent).toEqual([
				{
					agentId: 'agent-1',
					requests: 10,
					compressRequests: 4,
					originalTokens: 40_000,
					sentTokens: 30_000,
					tokensSaved: 10_000,
					// 50 ms over the 4 requests that were held, not over all 10.
					avgAddedLatencyMs: 13,
					provider: agentOne,
				},
				{
					agentId: null,
					requests: 3,
					compressRequests: 0,
					originalTokens: 0,
					sentTokens: 0,
					tokensSaved: 0,
					avgAddedLatencyMs: 0,
					provider: none,
				},
			]);
			expect(usage.totals).toEqual({
				requests: 13,
				compressRequests: 4,
				originalTokens: 40_000,
				sentTokens: 30_000,
				tokensSaved: 10_000,
				avgAddedLatencyMs: 13,
				provider: agentOne,
			});
		});

		it('answers zeros for a range with no requests', () => {
			const usage = getProxyRequestUsage(mockDb, 'day');

			expect(usage.byAgent).toEqual([]);
			expect(usage.totals).toEqual({
				requests: 0,
				compressRequests: 0,
				originalTokens: 0,
				sentTokens: 0,
				tokensSaved: 0,
				avgAddedLatencyMs: 0,
				provider: {
					requests: 0,
					inputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					outputTokens: 0,
				},
			});
		});

		it('reads from the start of the range', () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
			try {
				getProxyRequestUsage(mockDb, 'day');
				// "Today" is the local calendar day (getTimeRangeStart), not a rolling 24 hours.
				const midnight = new Date(Date.now());
				midnight.setHours(0, 0, 0, 0);
				expect(mockStatement.all).toHaveBeenCalledWith(midnight.getTime());
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('getRecentProxyCompressions', () => {
		const second = { ...block, hash: 'b'.repeat(64), compressors: ['json', 'long-lines'] };
		const third = { ...block, hash: 'c'.repeat(64) };

		it('flattens the newest rows into one entry per block, newest first', () => {
			mockStatement.all.mockReturnValue([
				{ agent_id: 'agent-1', started_at: 900, new_blocks: JSON.stringify([block, second]) },
				{ agent_id: null, started_at: 500, new_blocks: JSON.stringify([third]) },
			]);

			expect(getRecentProxyCompressions(mockDb, 10)).toEqual([
				{ ...block, agentId: 'agent-1', at: 900 },
				{ ...second, agentId: 'agent-1', at: 900 },
				{ ...third, agentId: null, at: 500 },
			]);
			expect(mockStatement.all).toHaveBeenCalledWith(10);
		});

		it('stops at the limit, inside a row', () => {
			mockStatement.all.mockReturnValue([
				{ agent_id: 'agent-1', started_at: 900, new_blocks: JSON.stringify([block, second]) },
				{ agent_id: 'agent-1', started_at: 500, new_blocks: JSON.stringify([third]) },
			]);

			expect(getRecentProxyCompressions(mockDb, 1)).toEqual([
				{ ...block, agentId: 'agent-1', at: 900 },
			]);
		});

		it('reads a column that does not parse, or holds something else, as no blocks', () => {
			mockStatement.all.mockReturnValue([
				{ agent_id: 'agent-1', started_at: 900, new_blocks: '{not json' },
				{ agent_id: 'agent-1', started_at: 800, new_blocks: '{"hash":"x"}' },
				{
					agent_id: 'agent-1',
					started_at: 700,
					new_blocks: JSON.stringify([{ hash: 'x' }, third]),
				},
			]);

			expect(getRecentProxyCompressions(mockDb, 10)).toEqual([
				{ ...third, agentId: 'agent-1', at: 700 },
			]);
		});

		it('does not query for a limit of zero', () => {
			expect(getRecentProxyCompressions(mockDb, 0)).toEqual([]);
			expect(mockStatement.all).not.toHaveBeenCalled();
		});
	});
});
