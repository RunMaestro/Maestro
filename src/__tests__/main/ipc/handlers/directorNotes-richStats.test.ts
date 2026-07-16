/**
 * Tests for the deterministic Director's Notes Rich Mode stats engine
 * (`director-notes:getRichOverviewStats`).
 *
 * Every number the Rich widgets render is computed in the main process over the
 * raw history entries, never inferred from the AI synopsis. These tests pin that
 * aggregation: type tallies, success/failure counting (missing `success` counts
 * as neither), per-agent grouping and sort order, elapsed-time summing and
 * averaging, timeline bucketing, lookback-cutoff filtering, and the
 * empty-history case.
 *
 * The mock harness mirrors the adjacent director-notes.test.ts (the repo
 * convention: each handler test stands up its own ipcMain + dependency mocks)
 * rather than introducing a new factory. The history-manager methods are async,
 * so the mocks resolve their values via mockResolvedValue.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerDirectorNotesHandlers } from '../../../../main/ipc/handlers/director-notes';
import * as historyManagerModule from '../../../../main/history-manager';
import type { HistoryManager } from '../../../../main/history-manager';
import type { HistoryEntry } from '../../../../shared/types';

// Mock electron's ipcMain so handler registration is captured, not wired to IPC.
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the history-manager module - the sole data source for the stats engine.
vi.mock('../../../../main/history-manager', () => ({
	getHistoryManager: vi.fn(),
}));

// Mock the stores module - resolves Maestro session names for perAgent rollups.
const mockGetSessionsStore = vi.fn().mockReturnValue({
	get: vi.fn().mockReturnValue([]),
});
vi.mock('../../../../main/stores', () => ({
	getSessionsStore: (...args: any[]) => mockGetSessionsStore(...args),
}));

// Mock the logger to keep the suite quiet.
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock the synopsis-only dependencies so importing the handler module is cheap.
// getRichOverviewStats never touches these, but registerDirectorNotesHandlers
// registers every handler, and director-notes.ts imports them at module top.
vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
}));
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `mock prompt for ${id}`),
}));

describe('director-notes:getRichOverviewStats', () => {
	let handlers: Map<string, Function>;
	// History-manager mock: each method is a bare Mock so test bodies can
	// override return values without re-deriving the (async) real signatures.
	let mockHistoryManager: {
		getEntries: Mock;
		listSessionsWithHistory: Mock;
		getHistoryFilePath: Mock;
	};

	// Mirror of the adjacent test's entry factory. AUTO type and a fresh
	// timestamp by default; every field is overridable per case.
	const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
		id: 'entry-1',
		type: 'AUTO',
		sessionId: 'session-1',
		projectPath: '/test/project',
		timestamp: Date.now(),
		summary: 'Test entry',
		...overrides,
	});

	// Resolve and invoke the registered handler with the standard (event, args)
	// signature. Throws loudly if registration ever drops the channel.
	const runHandler = (options: { lookbackDays: number; bucketCount?: number }) => {
		const handler = handlers.get('director-notes:getRichOverviewStats');
		if (!handler) throw new Error('getRichOverviewStats handler not registered');
		return handler({} as any, options);
	};

	beforeEach(() => {
		vi.clearAllMocks();

		mockHistoryManager = {
			getEntries: vi.fn().mockResolvedValue([]),
			listSessionsWithHistory: vi.fn().mockResolvedValue([]),
			getHistoryFilePath: vi.fn().mockResolvedValue(null),
		};
		vi.mocked(historyManagerModule.getHistoryManager).mockReturnValue(
			mockHistoryManager as unknown as HistoryManager
		);

		// Default: no Maestro session names - perAgent falls back to the id.
		mockGetSessionsStore.mockReturnValue({
			get: vi.fn().mockReturnValue([]),
		});

		// Capture every registered handler keyed by channel.
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		registerDirectorNotesHandlers({
			getProcessManager: () => null,
			getAgentDetector: () => null,
			agentConfigsStore: { get: vi.fn(() => ({})) } as any,
			getMainWindow: () => null,
		});
	});

	afterEach(() => {
		handlers.clear();
	});

	it('registers the getRichOverviewStats handler', () => {
		expect(handlers.has('director-notes:getRichOverviewStats')).toBe(true);
	});

	it('computes totals, agent/session counts from entries in the window', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1', 'session-2']);
		mockHistoryManager.getEntries
			.mockResolvedValueOnce([
				createMockEntry({ id: 'e1', type: 'AUTO', timestamp: now - 1000, agentSessionId: 'as-1' }),
				createMockEntry({ id: 'e2', type: 'USER', timestamp: now - 2000, agentSessionId: 'as-1' }),
				createMockEntry({ id: 'e3', type: 'CUE', timestamp: now - 3000, agentSessionId: 'as-2' }),
			])
			.mockResolvedValueOnce([
				createMockEntry({ id: 'e4', type: 'USER', timestamp: now - 4000, agentSessionId: 'as-3' }),
			]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.totalEntries).toBe(4);
		expect(result.agentCount).toBe(2); // session-1, session-2
		expect(result.sessionCount).toBe(3); // as-1, as-2, as-3
		expect(result.lookbackDays).toBe(7);
		expect(result.generatedAt).toBeTypeOf('number');
		expect(result.generatedAt).toBeLessThanOrEqual(Date.now());
	});

	it('tallies AUTO / USER / CUE entries independently', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'a1', type: 'AUTO', timestamp: now - 1000 }),
			createMockEntry({ id: 'a2', type: 'AUTO', timestamp: now - 2000 }),
			createMockEntry({ id: 'u1', type: 'USER', timestamp: now - 3000 }),
			createMockEntry({ id: 'c1', type: 'CUE', timestamp: now - 4000 }),
			createMockEntry({ id: 'c2', type: 'CUE', timestamp: now - 5000 }),
			createMockEntry({ id: 'c3', type: 'CUE', timestamp: now - 6000 }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.autoCount).toBe(2);
		expect(result.userCount).toBe(1);
		expect(result.cueCount).toBe(3);
		expect(result.totalEntries).toBe(6);
	});

	it('counts success/failure and guards divide-by-zero in successRate', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'e1', timestamp: now - 1000, success: true }),
			createMockEntry({ id: 'e2', timestamp: now - 2000, success: true }),
			createMockEntry({ id: 'e3', timestamp: now - 3000, success: true }),
			createMockEntry({ id: 'e4', timestamp: now - 4000, success: false }),
			// Missing success is neither success nor failure.
			createMockEntry({ id: 'e5', timestamp: now - 5000 }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.successCount).toBe(3);
		expect(result.failureCount).toBe(1);
		// 3 / (3 + 1) = 0.75
		expect(result.successRate).toBeCloseTo(0.75);
		expect(result.totalEntries).toBe(5);
	});

	it('returns successRate 0 when there are no success/failure outcomes', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'e1', timestamp: now - 1000 }),
			createMockEntry({ id: 'e2', timestamp: now - 2000 }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.successCount).toBe(0);
		expect(result.failureCount).toBe(0);
		expect(result.successRate).toBe(0);
	});

	it('sums elapsed time and averages only over entries with timing', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'e1', timestamp: now - 1000, elapsedTimeMs: 1000 }),
			createMockEntry({ id: 'e2', timestamp: now - 2000, elapsedTimeMs: 3000 }),
			// No elapsedTimeMs - excluded from the average divisor.
			createMockEntry({ id: 'e3', timestamp: now - 3000 }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.totalElapsedMs).toBe(4000);
		// 4000 / 2 entries with timing = 2000
		expect(result.avgElapsedMs).toBe(2000);
	});

	it('treats an explicit elapsedTimeMs of 0 as a timing sample', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'e1', timestamp: now - 1000, elapsedTimeMs: 0 }),
			createMockEntry({ id: 'e2', timestamp: now - 2000, elapsedTimeMs: 4000 }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.totalElapsedMs).toBe(4000);
		// 0 is a real sample, so the divisor is 2 -> 2000, not 4000.
		expect(result.avgElapsedMs).toBe(2000);
	});

	it('returns avgElapsedMs 0 when no entries have timing', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'e1', timestamp: now - 1000 }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.totalElapsedMs).toBe(0);
		expect(result.avgElapsedMs).toBe(0);
	});

	it('builds perAgent rollups sorted by entryCount desc with names resolved', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1', 'session-2']);
		mockHistoryManager.getEntries
			.mockResolvedValueOnce([createMockEntry({ id: 'e1', timestamp: now - 1000, success: true })])
			.mockResolvedValueOnce([
				createMockEntry({ id: 'e2', timestamp: now - 2000, success: true }),
				createMockEntry({ id: 'e3', timestamp: now - 3000, success: false }),
				// Missing success contributes to entryCount but neither outcome counter.
				createMockEntry({ id: 'e4', timestamp: now - 4000 }),
			]);

		mockGetSessionsStore.mockReturnValue({
			get: vi.fn().mockReturnValue([
				{ id: 'session-1', name: 'alpha', toolType: 'claude-code', cwd: '/t', projectRoot: '/t' },
				{ id: 'session-2', name: 'beta', toolType: 'claude-code', cwd: '/t', projectRoot: '/t' },
			]),
		});

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.perAgent).toHaveLength(2);
		// session-2 has 3 entries, session-1 has 1 -> session-2 first.
		expect(result.perAgent[0].sessionId).toBe('session-2');
		expect(result.perAgent[0].agentName).toBe('beta');
		expect(result.perAgent[0].entryCount).toBe(3);
		expect(result.perAgent[0].successCount).toBe(1);
		expect(result.perAgent[0].failureCount).toBe(1);
		expect(result.perAgent[1].sessionId).toBe('session-1');
		expect(result.perAgent[1].agentName).toBe('alpha');
		expect(result.perAgent[1].entryCount).toBe(1);
	});

	it('falls back to the session id when no Maestro name is available', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['unnamed-session']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'e1', timestamp: now - 1000 }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.perAgent[0].agentName).toBe('unnamed-session');
	});

	it('produces bucketCount timeline buckets that sum to totalEntries, each with a startTime', async () => {
		const now = Date.now();
		const oneHourAgo = now - 60 * 60 * 1000;
		const twoHoursAgo = now - 2 * 60 * 60 * 1000;
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'e1', type: 'AUTO', timestamp: oneHourAgo }),
			createMockEntry({ id: 'e2', type: 'USER', timestamp: oneHourAgo }),
			createMockEntry({ id: 'e3', type: 'CUE', timestamp: twoHoursAgo }),
		]);

		const result = await runHandler({ lookbackDays: 1, bucketCount: 12 });

		expect(result.timelineBuckets).toHaveLength(12);
		const totalInBuckets = result.timelineBuckets.reduce(
			(sum: number, b: RichBucketShape) => sum + b.auto + b.user + b.cue,
			0
		);
		expect(totalInBuckets).toBe(3);
		// Per-type sums across the timeline must match the top-level tallies.
		const sumType = (key: 'auto' | 'user' | 'cue') =>
			result.timelineBuckets.reduce((s: number, b: RichBucketShape) => s + b[key], 0);
		expect(sumType('auto')).toBe(result.autoCount);
		expect(sumType('user')).toBe(result.userCount);
		expect(sumType('cue')).toBe(result.cueCount);
		// Buckets are ordered oldest -> newest with ascending startTimes.
		for (let i = 1; i < result.timelineBuckets.length; i++) {
			expect(result.timelineBuckets[i].startTime).toBeGreaterThanOrEqual(
				result.timelineBuckets[i - 1].startTime
			);
		}
	});

	it('defaults to 24 timeline buckets when bucketCount is omitted', async () => {
		const now = Date.now();
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'e1', timestamp: now - 1000 }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.timelineBuckets).toHaveLength(24);
	});

	it('respects the lookback cutoff (drops out-of-window entries)', async () => {
		const now = Date.now();
		const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
		const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'recent', timestamp: twoDaysAgo }),
			createMockEntry({ id: 'old', timestamp: tenDaysAgo }),
		]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.totalEntries).toBe(1);
	});

	it('includes all entries for all-time mode (lookbackDays=0)', async () => {
		const now = Date.now();
		const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;
		const yearAgo = now - 365 * 24 * 60 * 60 * 1000;
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue(['session-1']);
		mockHistoryManager.getEntries.mockResolvedValue([
			createMockEntry({ id: 'recent', timestamp: twoDaysAgo }),
			createMockEntry({ id: 'ancient', timestamp: yearAgo }),
		]);

		const result = await runHandler({ lookbackDays: 0 });

		expect(result.totalEntries).toBe(2);
	});

	it('returns zeroed stats when no sessions have history', async () => {
		mockHistoryManager.listSessionsWithHistory.mockResolvedValue([]);

		const result = await runHandler({ lookbackDays: 7 });

		expect(result.totalEntries).toBe(0);
		expect(result.agentCount).toBe(0);
		expect(result.sessionCount).toBe(0);
		expect(result.autoCount).toBe(0);
		expect(result.userCount).toBe(0);
		expect(result.cueCount).toBe(0);
		expect(result.successCount).toBe(0);
		expect(result.failureCount).toBe(0);
		expect(result.successRate).toBe(0);
		expect(result.totalElapsedMs).toBe(0);
		expect(result.avgElapsedMs).toBe(0);
		expect(result.perAgent).toEqual([]);
	});
});

/** Local shape for reducing over timeline buckets in assertions. */
interface RichBucketShape {
	auto: number;
	user: number;
	cue: number;
}
