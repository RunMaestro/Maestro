/**
 * Tests for the History IPC handlers
 *
 * These tests verify the per-session history persistence operations
 * using the HistoryManager for scalable session-based storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { ipcMain } from 'electron';
import { registerHistoryHandlers } from '../../../../main/ipc/handlers/history';
import {
	HistoryBucketCache,
	setHistoryBucketCacheForTest,
} from '../../../../main/utils/history-bucket-cache';

/** Temp dir the graph bucket cache writes to. Hoisted for the electron mock. */
const GRAPH_CACHE_DIR = path.join(os.tmpdir(), `maestro-history-handler-test-${process.pid}`);
import * as historyManagerModule from '../../../../main/history-manager';
import * as sharedHistoryModule from '../../../../main/shared-history-manager';
import type { HistoryManager } from '../../../../main/history-manager';
import type { CueHistoryGroup, HistoryEntry } from '../../../../shared/types';
import { runAsActingUser } from '../../../../main/web-server/auth/acting-user';
import { noteTurnActor, resetTurnActors } from '../../../../main/web-server/auth/turn-attribution';

// Mock electron's ipcMain. `app.getPath` is here for the activity-graph
// bucket cache, which resolves its directory in the constructor.
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	app: {
		getPath: vi.fn(() => GRAPH_CACHE_DIR),
	},
}));

// Mock the history-manager module
vi.mock('../../../../main/history-manager', () => ({
	getHistoryManager: vi.fn(),
}));

// Mock the shared-history-manager module
vi.mock('../../../../main/shared-history-manager', () => ({
	writeEntryRemote: vi.fn(() => Promise.resolve()),
	writeEntryLocal: vi.fn(),
	readRemoteEntriesSsh: vi.fn(() => Promise.resolve([])),
	readRemoteEntriesLocal: vi.fn(() => []),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('history IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockHistoryManager: Partial<HistoryManager>;
	let mockSafeSend: ReturnType<typeof vi.fn>;

	// Sample history entries for testing
	const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
		id: 'entry-1',
		type: 'ai_message',
		sessionId: 'session-1',
		projectPath: '/test/project',
		timestamp: Date.now(),
		summary: 'Test entry',
		...overrides,
	});

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();

		mockSafeSend = vi.fn();

		// Create mock history manager
		mockHistoryManager = {
			getEntries: vi.fn().mockReturnValue([]),
			getEntriesByProjectPath: vi.fn().mockReturnValue([]),
			getAllEntries: vi.fn().mockReturnValue([]),
			getEntriesPaginated: vi.fn().mockReturnValue({
				entries: [],
				total: 0,
				limit: 100,
				offset: 0,
				hasMore: false,
			}),
			getEntriesByProjectPathPaginated: vi.fn().mockReturnValue({
				entries: [],
				total: 0,
				limit: 100,
				offset: 0,
				hasMore: false,
			}),
			getAllEntriesPaginated: vi.fn().mockReturnValue({
				entries: [],
				total: 0,
				limit: 100,
				offset: 0,
				hasMore: false,
			}),
			addEntry: vi.fn(),
			clearSession: vi.fn(),
			clearByProjectPath: vi.fn(),
			clearAll: vi.fn(),
			deleteEntry: vi.fn().mockReturnValue(false),
			updateEntry: vi.fn().mockReturnValue(false),
			updateSessionNameByClaudeSessionId: vi.fn().mockReturnValue(0),
			getHistoryFilePath: vi.fn().mockReturnValue(null),
			listSessionsWithHistory: vi.fn().mockReturnValue([]),
		};

		vi.mocked(historyManagerModule.getHistoryManager).mockReturnValue(
			mockHistoryManager as unknown as HistoryManager
		);

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers with mock safeSend
		registerHistoryHandlers({ safeSend: mockSafeSend });
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all history handlers', () => {
			const expectedChannels = [
				'history:getAll',
				'history:getAllPaginated',
				'history:reload',
				'history:add',
				'history:clear',
				'history:delete',
				'history:update',
				'history:updateSessionName',
				'history:getFilePath',
				'history:listSessions',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('history:getAll', () => {
		it('should return all entries for a specific session', async () => {
			const mockEntries = [
				createMockEntry({ id: 'entry-1', timestamp: 2000 }),
				createMockEntry({ id: 'entry-2', timestamp: 1000 }),
			];
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(mockEntries);

			const handler = handlers.get('history:getAll');
			const result = await handler!({} as any, undefined, 'session-1');

			expect(mockHistoryManager.getEntries).toHaveBeenCalledWith('session-1');
			expect(result).toEqual([
				mockEntries[0], // Higher timestamp first
				mockEntries[1],
			]);
		});

		it('should return entries filtered by project path', async () => {
			const mockEntries = [createMockEntry()];
			vi.mocked(mockHistoryManager.getEntriesByProjectPath).mockReturnValue(mockEntries);

			const handler = handlers.get('history:getAll');
			const result = await handler!({} as any, '/test/project');

			expect(mockHistoryManager.getEntriesByProjectPath).toHaveBeenCalledWith('/test/project');
			expect(result).toEqual(mockEntries);
		});

		it('should return all entries when no filters provided', async () => {
			const mockEntries = [createMockEntry()];
			vi.mocked(mockHistoryManager.getAllEntries).mockReturnValue(mockEntries);

			const handler = handlers.get('history:getAll');
			const result = await handler!({} as any);

			expect(mockHistoryManager.getAllEntries).toHaveBeenCalled();
			expect(result).toEqual(mockEntries);
		});

		it('should return empty array when session has no history', async () => {
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);

			const handler = handlers.get('history:getAll');
			const result = await handler!({} as any, undefined, 'session-1');

			expect(result).toEqual([]);
		});

		it('should NOT read SSH shared history for local agents (no sharedContext)', async () => {
			const mockEntries = [createMockEntry()];
			vi.mocked(mockHistoryManager.getEntriesByProjectPath).mockReturnValue(mockEntries);

			const handler = handlers.get('history:getAll');
			const result = await handler!({} as any, '/test/project');

			expect(sharedHistoryModule.readRemoteEntriesSsh).not.toHaveBeenCalled();
			// Local agents still read .maestro/history/ from the project dir
			expect(sharedHistoryModule.readRemoteEntriesLocal).toHaveBeenCalledWith(
				'/test/project',
				undefined
			);
			expect(result).toEqual(mockEntries);
		});

		it('should merge local .maestro/history/ entries for local agents', async () => {
			const localEntries = [createMockEntry({ id: 'local-1' })];
			const sharedLocalEntries = [
				createMockEntry({ id: 'remote-operator-1', hostname: 'ssh-client' }),
			];
			vi.mocked(mockHistoryManager.getEntriesByProjectPath).mockReturnValue(localEntries);
			vi.mocked(sharedHistoryModule.readRemoteEntriesLocal).mockReturnValue(sharedLocalEntries);

			const handler = handlers.get('history:getAll');
			const result = await handler!({} as any, '/test/project');

			expect(sharedHistoryModule.readRemoteEntriesLocal).toHaveBeenCalledWith(
				'/test/project',
				undefined
			);
			expect(result).toHaveLength(2);
		});

		it('should read shared history from remote when sharedContext is provided', async () => {
			const localEntries = [createMockEntry({ id: 'local-1' })];
			const remoteEntries = [createMockEntry({ id: 'remote-1', hostname: 'dev-server' })];
			const mockSshRemote = { id: 'remote-1', host: 'dev-server', user: 'user' };

			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(localEntries);
			vi.mocked(sharedHistoryModule.readRemoteEntriesSsh).mockResolvedValue(remoteEntries);

			// Re-register with getSshRemoteById
			registerHistoryHandlers({
				safeSend: mockSafeSend,
				getSshRemoteById: () => mockSshRemote as any,
			});
			const getAllCalls = (ipcMain.handle as any).mock.calls.filter(
				([ch]: [string, Function]) => ch === 'history:getAll'
			);
			const getAllHandler = getAllCalls[getAllCalls.length - 1][1];

			const sharedContext = { sshRemoteId: 'remote-1', remoteCwd: '/remote/project' };
			const result = await getAllHandler({} as any, undefined, 'session-1', sharedContext);

			expect(sharedHistoryModule.readRemoteEntriesSsh).toHaveBeenCalledWith(
				'/remote/project',
				mockSshRemote,
				undefined
			);
			expect(result).toHaveLength(2);
		});
	});

	describe('history:getAllPaginated', () => {
		it('should return paginated entries for a specific session', async () => {
			// Handler now reads entries directly via `getEntries` so it can
			// merge shared history + apply lookback before paginating.
			const entries = [
				createMockEntry({ id: 'e1', timestamp: 1000 }),
				createMockEntry({ id: 'e2', timestamp: 2000 }),
				createMockEntry({ id: 'e3', timestamp: 3000 }),
			];
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(entries);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				pagination: { limit: 2, offset: 0 },
			});

			expect(mockHistoryManager.getEntries).toHaveBeenCalledWith('session-1');
			// Sorted newest-first, then sliced to `limit: 2`.
			expect(result.entries.map((e: { id: string }) => e.id)).toEqual(['e3', 'e2']);
			expect(result.total).toBe(3);
			expect(result.hasMore).toBe(true);
		});

		it('should return paginated entries filtered by project path', async () => {
			// Handler delegates the per-project read through
			// `getEntriesByProjectPathPaginated(undefined)`, then re-paginates
			// after applying lookback. With no lookback, the slice matches
			// the underlying call.
			const mockResult = {
				entries: [createMockEntry()],
				total: 30,
				limit: 20,
				offset: 0,
				hasMore: true,
			};
			vi.mocked(mockHistoryManager.getEntriesByProjectPathPaginated).mockReturnValue(mockResult);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, {
				projectPath: '/test/project',
				pagination: { limit: 20 },
			});

			expect(mockHistoryManager.getEntriesByProjectPathPaginated).toHaveBeenCalledWith(
				'/test/project',
				undefined
			);
			expect(result.entries).toHaveLength(1);
			expect(result.total).toBe(1);
		});

		it('should return all paginated entries when no filters provided', async () => {
			const mockResult = {
				entries: [createMockEntry()],
				total: 100,
				limit: 100,
				offset: 0,
				hasMore: false,
			};
			vi.mocked(mockHistoryManager.getAllEntriesPaginated).mockReturnValue(mockResult);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, {});

			// Handler asks the manager for the unbounded entries, then
			// applies its own lookback filter + pagination on top.
			expect(mockHistoryManager.getAllEntriesPaginated).toHaveBeenCalledWith(undefined);
			expect(result.entries).toHaveLength(1);
			expect(result.total).toBe(1);
			expect(result.hasMore).toBe(false);
		});

		it('should apply lookbackHours filter before pagination', async () => {
			const now = Date.now();
			const entries = [
				createMockEntry({ id: 'recent', timestamp: now - 60 * 1000 }),
				createMockEntry({ id: 'old', timestamp: now - 100 * 60 * 60 * 1000 }),
			];
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(entries);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				pagination: { limit: 100, offset: 0 },
				lookbackHours: 24,
			});

			// Old entry (100h ago) drops out; only the recent one survives
			// the server-side lookback filter.
			expect(result.entries.map((e: { id: string }) => e.id)).toEqual(['recent']);
			expect(result.total).toBe(1);
		});

		it('should apply the types filter before pagination', async () => {
			// Regression: a Cue-heavy agent floods the newest entries with CUE,
			// so a type-blind window leaves no room for older USER/AUTO entries.
			// The server-side type filter must drop CUE before slicing so the
			// window holds the newest USER/AUTO entries.
			const entries = [
				createMockEntry({ id: 'cue1', type: 'CUE', timestamp: 5000 }),
				createMockEntry({ id: 'cue2', type: 'CUE', timestamp: 4000 }),
				createMockEntry({ id: 'user1', type: 'USER', timestamp: 3000 }),
				createMockEntry({ id: 'auto1', type: 'AUTO', timestamp: 2000 }),
			];
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(entries);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				pagination: { limit: 100, offset: 0 },
				types: ['USER', 'AUTO'],
			});

			// CUE entries drop out even though they're newest; total reflects
			// the filtered set, not the full on-disk count.
			expect(result.entries.map((e: { id: string }) => e.id)).toEqual(['user1', 'auto1']);
			expect(result.total).toBe(2);
		});

		it('should return no entries when the types filter is empty', async () => {
			const entries = [
				createMockEntry({ id: 'u', type: 'USER', timestamp: 2000 }),
				createMockEntry({ id: 'c', type: 'CUE', timestamp: 1000 }),
			];
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(entries);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				pagination: { limit: 100, offset: 0 },
				types: [],
			});

			expect(result.entries).toEqual([]);
			expect(result.total).toBe(0);
		});

		it('should apply the host filter before pagination', async () => {
			// Regression: the picker count comes from the full-source graph
			// aggregate, so selecting a host whose entries fall outside the
			// loaded page used to show nothing despite "(N)". The host filter
			// must run server-side (like types) so the window holds the newest
			// N entries OF THE SELECTED HOST.
			const entries = [
				createMockEntry({ id: 'remote1', hostname: 'dev-box', timestamp: 5000 }),
				createMockEntry({ id: 'local1', timestamp: 4000 }),
				createMockEntry({ id: 'remote2', hostname: 'dev-box', timestamp: 3000 }),
			];
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(entries);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				pagination: { limit: 100, offset: 0 },
				hostKey: 'dev-box',
			});

			expect(result.entries.map((e: { id: string }) => e.id)).toEqual(['remote1', 'remote2']);
			expect(result.total).toBe(2);
		});

		it('should match local (no-hostname) entries via the synthetic __local__ host key', async () => {
			const entries = [
				createMockEntry({ id: 'remote1', hostname: 'dev-box', timestamp: 5000 }),
				createMockEntry({ id: 'local1', timestamp: 4000 }),
			];
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(entries);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, {
				sessionId: 'session-1',
				pagination: { limit: 100, offset: 0 },
				hostKey: '__local__',
			});

			expect(result.entries.map((e: { id: string }) => e.id)).toEqual(['local1']);
			expect(result.total).toBe(1);
		});

		it('should handle undefined options', async () => {
			const mockResult = {
				entries: [],
				total: 0,
				limit: 100,
				offset: 0,
				hasMore: false,
			};
			vi.mocked(mockHistoryManager.getAllEntriesPaginated).mockReturnValue(mockResult);

			const handler = handlers.get('history:getAllPaginated');
			const result = await handler!({} as any, undefined);

			expect(mockHistoryManager.getAllEntriesPaginated).toHaveBeenCalledWith(undefined);
			expect(result).toEqual(mockResult);
		});
	});

	// Cue runs live in the `cue_events` table, not in the agent's JSONL file
	// (CUE-HISTORY-02). The read path merges the two sources, so these tests
	// drive the injected `getCueHistoryEntries` the way the real query behaves:
	// newest-first rows for one agent, already shaped as HistoryEntry.
	describe('Cue entries merged from the database', () => {
		const cueRow = (overrides: Partial<HistoryEntry> = {}): HistoryEntry =>
			createMockEntry({
				id: 'cue-row',
				type: 'CUE',
				summary: 'Reviewed 3 PRs',
				cueTriggerName: 'PR-Sweep',
				cueEventType: 'time.heartbeat',
				success: true,
				elapsedTimeMs: 0,
				...overrides,
			});

		/** Register a fresh handler set and return a getter for its channels. */
		const registerWith = (overrides: Record<string, unknown>): ((channel: string) => Function) => {
			registerHistoryHandlers({ safeSend: mockSafeSend, ...overrides } as any);
			return (channel: string) => {
				const calls = (ipcMain.handle as any).mock.calls.filter(
					([ch]: [string, Function]) => ch === channel
				);
				return calls[calls.length - 1][1];
			};
		};

		it('interleaves JSONL and Cue entries in timestamp order (getAll)', async () => {
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'user-new', type: 'USER', timestamp: 4000 }),
				createMockEntry({ id: 'user-old', type: 'USER', timestamp: 2000 }),
			]);
			const getCueHistoryEntries = vi.fn(() => [
				cueRow({ id: 'cue-new', timestamp: 3000 }),
				cueRow({ id: 'cue-old', timestamp: 1000 }),
			]);

			const handler = registerWith({ getCueHistoryEntries })('history:getAll');
			const result = await handler({} as any, undefined, 'session-1');

			expect(result.map((e: HistoryEntry) => e.id)).toEqual([
				'user-new',
				'cue-new',
				'user-old',
				'cue-old',
			]);
		});

		it('interleaves JSONL and Cue entries in timestamp order (getAllPaginated)', async () => {
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'user-new', type: 'USER', timestamp: 4000 }),
				createMockEntry({ id: 'user-old', type: 'USER', timestamp: 2000 }),
			]);
			const getCueHistoryEntries = vi.fn(() => [
				cueRow({ id: 'cue-new', timestamp: 3000 }),
				cueRow({ id: 'cue-old', timestamp: 1000 }),
			]);

			const handler = registerWith({ getCueHistoryEntries })('history:getAllPaginated');
			const result = await handler({} as any, {
				sessionId: 'session-1',
				pagination: { offset: 0, limit: 10 },
			});

			expect(result.entries.map((e: HistoryEntry) => e.id)).toEqual([
				'user-new',
				'cue-new',
				'user-old',
				'cue-old',
			]);
			expect(result.total).toBe(4);
		});

		it('paginates across the merged list rather than the JSONL half', async () => {
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'user-new', type: 'USER', timestamp: 4000 }),
				createMockEntry({ id: 'user-old', type: 'USER', timestamp: 2000 }),
			]);
			const getCueHistoryEntries = vi.fn(() => [
				cueRow({ id: 'cue-new', timestamp: 3000 }),
				cueRow({ id: 'cue-old', timestamp: 1000 }),
			]);

			const handler = registerWith({ getCueHistoryEntries })('history:getAllPaginated');
			const page = await handler({} as any, {
				sessionId: 'session-1',
				pagination: { offset: 0, limit: 2 },
			});

			expect(page.entries.map((e: HistoryEntry) => e.id)).toEqual(['user-new', 'cue-new']);
			expect(page.hasMore).toBe(true);
		});

		it('passes the agent name, directory, lookback and entry cap to the query', async () => {
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);
			const getCueHistoryEntries = vi.fn(() => []);
			const now = 1_000_000_000_000;
			vi.useFakeTimers();
			vi.setSystemTime(now);

			const handler = registerWith({
				getCueHistoryEntries,
				getMaxEntries: () => 500,
				getSessionById: () => ({ id: 'session-1', name: 'rc', projectRoot: '/repo/rc' }),
			})('history:getAllPaginated');
			await handler({} as any, { sessionId: 'session-1', lookbackHours: 24 });

			expect(getCueHistoryEntries).toHaveBeenCalledWith({
				sessionId: 'session-1',
				sessionName: 'rc',
				projectPath: '/repo/rc',
				since: now - 24 * 60 * 60 * 1000,
				limit: 500,
			});
			vi.useRealTimers();
		});

		it('skips the query when the CUE filter pill is off', async () => {
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'user-1', type: 'USER', timestamp: 4000 }),
			]);
			const getCueHistoryEntries = vi.fn(() => [cueRow({ id: 'cue-1', timestamp: 3000 })]);

			const handler = registerWith({ getCueHistoryEntries })('history:getAllPaginated');
			const result = await handler({} as any, {
				sessionId: 'session-1',
				types: ['USER', 'AUTO'],
			});

			expect(getCueHistoryEntries).not.toHaveBeenCalled();
			expect(result.entries.map((e: HistoryEntry) => e.id)).toEqual(['user-1']);
		});

		it('skips the query when a foreign host is selected', async () => {
			// Cue rows carry no hostname, so they can only ever belong to the
			// synthetic local bucket - querying for another host is wasted work.
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);
			const getCueHistoryEntries = vi.fn(() => []);

			const handler = registerWith({ getCueHistoryEntries })('history:getAllPaginated');
			await handler({} as any, { sessionId: 'session-1', hostKey: 'dev-server' });
			expect(getCueHistoryEntries).not.toHaveBeenCalled();

			await handler({} as any, { sessionId: 'session-1', hostKey: '__local__' });
			expect(getCueHistoryEntries).toHaveBeenCalledTimes(1);
		});

		it('hides a Cue row the JSONL file already carries', async () => {
			// Both writers were live before the JSONL Cue writes were removed, and
			// those entries stay on disk afterwards. The JSONL entry is stamped at
			// completion; the DB row at dispatch.
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				cueRow({ id: 'jsonl-copy', timestamp: 3200, sessionId: 'session-1' }),
			]);
			const getCueHistoryEntries = vi.fn(() => [
				cueRow({
					id: 'db-copy',
					timestamp: 3000,
					elapsedTimeMs: 200,
					sessionId: 'session-1',
				}),
			]);

			const handler = registerWith({ getCueHistoryEntries })('history:getAll');
			const result = await handler({} as any, undefined, 'session-1');

			expect(result.map((e: HistoryEntry) => e.id)).toEqual(['jsonl-copy']);
		});

		it('keeps repeat runs that happen to print the same thing', async () => {
			// A heartbeat saying "No changes." every few minutes must not collapse:
			// one JSONL entry suppresses exactly one database row.
			const hour = 60 * 60 * 1000;
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				cueRow({ id: 'jsonl-run-2', timestamp: 2 * hour, sessionId: 'session-1' }),
			]);
			const getCueHistoryEntries = vi.fn(() => [
				cueRow({ id: 'db-run-2', timestamp: 2 * hour, sessionId: 'session-1' }),
				cueRow({ id: 'db-run-1', timestamp: hour, sessionId: 'session-1' }),
			]);

			const handler = registerWith({ getCueHistoryEntries })('history:getAll');
			const result = await handler({} as any, undefined, 'session-1');

			expect(result.map((e: HistoryEntry) => e.id)).toEqual(['jsonl-run-2', 'db-run-1']);
		});

		it('still serves JSONL history when the Cue database throws', async () => {
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'user-1', type: 'USER', timestamp: 4000 }),
			]);
			const getCueHistoryEntries = vi.fn(() => {
				throw new Error('database is locked');
			});

			const handler = registerWith({ getCueHistoryEntries })('history:getAll');
			const result = await handler({} as any, undefined, 'session-1');

			expect(result.map((e: HistoryEntry) => e.id)).toEqual(['user-1']);
		});

		it('covers every agent in the project for a project-wide read', async () => {
			vi.mocked(mockHistoryManager.getEntriesByProjectPath).mockReturnValue([]);
			vi.mocked(sharedHistoryModule.readRemoteEntriesLocal).mockReturnValue([]);
			const getCueHistoryEntries = vi.fn(({ sessionId }: { sessionId: string }) => [
				cueRow({ id: `cue-${sessionId}`, timestamp: 1000, sessionId }),
			]);

			const handler = registerWith({
				getCueHistoryEntries,
				getAllSessions: () => [
					{ id: 'agent-a', name: 'A', projectRoot: '/repo' },
					{ id: 'agent-b', name: 'B', cwd: '/repo' },
					{ id: 'agent-elsewhere', name: 'C', projectRoot: '/other' },
				],
			})('history:getAll');
			const result = await handler({} as any, '/repo');

			expect(result.map((e: HistoryEntry) => e.id).sort()).toEqual(['cue-agent-a', 'cue-agent-b']);
		});

		// `groupCue` (the user's `groupCueEntries` setting) swaps the ungrouped
		// read for the SQL rollup: one row per pipeline-level trigger, carrying
		// the count the row exists to report. CUE-HISTORY-03 task #3.
		describe('grouped Cue rows', () => {
			const group = (overrides: Partial<CueHistoryGroup> = {}): CueHistoryGroup => ({
				key: 'PR-Sweep',
				label: 'PR-Sweep',
				runCount: 1382,
				failureCount: 3,
				lastRunAtMs: 3000,
				latestEntry: cueRow({ id: 'cue-newest', timestamp: 3000 }),
				...overrides,
			});

			it('serves one row per trigger, carrying the run and failure counts', async () => {
				vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
					createMockEntry({ id: 'user-new', type: 'USER', timestamp: 4000 }),
				]);
				const getCueHistoryGroups = vi.fn(() => [group()]);

				const handler = registerWith({ getCueHistoryGroups })('history:getAllPaginated');
				const result = await handler({} as any, { sessionId: 'session-1', groupCue: true });

				expect(result.entries.map((e: HistoryEntry) => e.id)).toEqual(['user-new', 'cue-newest']);
				expect(result.entries[1].cueGroup).toEqual({
					key: 'PR-Sweep',
					label: 'PR-Sweep',
					runCount: 1382,
					failureCount: 3,
				});
			});

			it('passes a group of ONE through as an ordinary row', async () => {
				// "PR-Sweep - 1 run" is a worse row than the run's own summary, and
				// it would put an expander on a row with nothing behind it.
				vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);
				const getCueHistoryGroups = vi.fn(() => [group({ runCount: 1, failureCount: 0 })]);

				const handler = registerWith({ getCueHistoryGroups })('history:getAllPaginated');
				const result = await handler({} as any, { sessionId: 'session-1', groupCue: true });

				expect(result.entries).toHaveLength(1);
				expect(result.entries[0].id).toBe('cue-newest');
				expect(result.entries[0].cueGroup).toBeUndefined();
			});

			it('uses the ungrouped query when the setting is off', async () => {
				vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);
				const getCueHistoryEntries = vi.fn(() => [cueRow({ id: 'cue-1', timestamp: 3000 })]);
				const getCueHistoryGroups = vi.fn(() => [group()]);

				const handler = registerWith({ getCueHistoryEntries, getCueHistoryGroups })(
					'history:getAllPaginated'
				);
				const result = await handler({} as any, { sessionId: 'session-1', groupCue: false });

				expect(getCueHistoryGroups).not.toHaveBeenCalled();
				expect(getCueHistoryEntries).toHaveBeenCalledTimes(1);
				expect(result.entries.map((e: HistoryEntry) => e.id)).toEqual(['cue-1']);
			});

			it('never runs the ungrouped query alongside the rollup', async () => {
				// The whole point of grouping in SQL is that the thousands of rows
				// are never materialized. Reading both would give that back.
				vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);
				const getCueHistoryEntries = vi.fn(() => []);
				const getCueHistoryGroups = vi.fn(() => [group()]);

				const handler = registerWith({ getCueHistoryEntries, getCueHistoryGroups })(
					'history:getAllPaginated'
				);
				await handler({} as any, { sessionId: 'session-1', groupCue: true });

				expect(getCueHistoryEntries).not.toHaveBeenCalled();
			});

			it('passes the agent name, directory and lookback to the rollup', async () => {
				vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);
				const getCueHistoryGroups = vi.fn(() => []);
				const now = 1_000_000_000_000;
				vi.useFakeTimers();
				vi.setSystemTime(now);

				const handler = registerWith({
					getCueHistoryGroups,
					getMaxEntries: () => 500,
					getSessionById: () => ({ id: 'session-1', name: 'rc', projectRoot: '/repo/rc' }),
				})('history:getAllPaginated');
				await handler({} as any, { sessionId: 'session-1', lookbackHours: 24, groupCue: true });

				expect(getCueHistoryGroups).toHaveBeenCalledWith({
					sessionId: 'session-1',
					sessionName: 'rc',
					projectPath: '/repo/rc',
					since: now - 24 * 60 * 60 * 1000,
					limit: 500,
				});
				vi.useRealTimers();
			});

			it('skips the rollup when the CUE filter pill is off', async () => {
				vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
					createMockEntry({ id: 'user-1', type: 'USER', timestamp: 4000 }),
				]);
				const getCueHistoryGroups = vi.fn(() => [group()]);

				const handler = registerWith({ getCueHistoryGroups })('history:getAllPaginated');
				const result = await handler({} as any, {
					sessionId: 'session-1',
					types: ['USER', 'AUTO'],
					groupCue: true,
				});

				expect(getCueHistoryGroups).not.toHaveBeenCalled();
				expect(result.entries.map((e: HistoryEntry) => e.id)).toEqual(['user-1']);
			});

			it('still serves JSONL history when the rollup throws', async () => {
				vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
					createMockEntry({ id: 'user-1', type: 'USER', timestamp: 4000 }),
				]);
				const getCueHistoryGroups = vi.fn(() => {
					throw new Error('database is locked');
				});

				const handler = registerWith({ getCueHistoryGroups })('history:getAllPaginated');
				const result = await handler({} as any, { sessionId: 'session-1', groupCue: true });

				expect(result.entries.map((e: HistoryEntry) => e.id)).toEqual(['user-1']);
			});

			it('collapses every agent in a project-wide read', async () => {
				vi.mocked(mockHistoryManager.getEntriesByProjectPath).mockReturnValue([]);
				vi.mocked(mockHistoryManager.getEntriesByProjectPathPaginated).mockReturnValue({
					entries: [],
					total: 0,
					limit: 100,
					offset: 0,
					hasMore: false,
				});
				vi.mocked(sharedHistoryModule.readRemoteEntriesLocal).mockReturnValue([]);
				const getCueHistoryGroups = vi.fn(({ sessionId }: { sessionId: string }) => [
					group({
						key: sessionId,
						label: sessionId,
						latestEntry: cueRow({ id: `cue-${sessionId}`, timestamp: 1000, sessionId }),
					}),
				]);

				const handler = registerWith({
					getCueHistoryGroups,
					getAllSessions: () => [
						{ id: 'agent-a', name: 'A', projectRoot: '/repo' },
						{ id: 'agent-b', name: 'B', cwd: '/repo' },
						{ id: 'agent-elsewhere', name: 'C', projectRoot: '/other' },
					],
				})('history:getAllPaginated');
				const result = await handler({} as any, { projectPath: '/repo', groupCue: true });

				expect(result.entries.map((e: HistoryEntry) => e.id).sort()).toEqual([
					'cue-agent-a',
					'cue-agent-b',
				]);
			});
		});

		// The expander behind a collapsed row. A group that reported 1,382 runs
		// is only honest if those runs stay reachable, and this channel is how
		// the row reaches them. CUE-HISTORY-03 task #4.
		describe('history:getCueGroupRuns', () => {
			it('returns the runs behind one group, newest first', async () => {
				const getCueHistoryGroupRuns = vi.fn(() => [
					cueRow({ id: 'run-new', timestamp: 3000 }),
					cueRow({ id: 'run-old', timestamp: 1000 }),
				]);

				const handler = registerWith({ getCueHistoryGroupRuns })('history:getCueGroupRuns');
				const result = await handler({} as any, {
					sessionId: 'session-1',
					groupKey: 'PR-Sweep',
				});

				expect(result.map((e: HistoryEntry) => e.id)).toEqual(['run-new', 'run-old']);
			});

			it('scopes the query to the agent, the group and the same lookback', async () => {
				// A different window than the grouped read used would show a set
				// of runs that disagrees with the count on the row.
				const getCueHistoryGroupRuns = vi.fn(() => []);
				const now = 1_000_000_000_000;
				vi.useFakeTimers();
				vi.setSystemTime(now);

				const handler = registerWith({
					getCueHistoryGroupRuns,
					getMaxEntries: () => 500,
					getSessionById: () => ({ id: 'session-1', name: 'rc', projectRoot: '/repo/rc' }),
				})('history:getCueGroupRuns');
				await handler({} as any, {
					sessionId: 'session-1',
					groupKey: 'PR-Sweep',
					lookbackHours: 24,
					limit: 200,
				});

				expect(getCueHistoryGroupRuns).toHaveBeenCalledWith({
					sessionId: 'session-1',
					sessionName: 'rc',
					projectPath: '/repo/rc',
					groupKey: 'PR-Sweep',
					since: now - 24 * 60 * 60 * 1000,
					limit: 200,
				});
				vi.useRealTimers();
			});

			it('falls back to the history entry limit when no cap is given', async () => {
				const getCueHistoryGroupRuns = vi.fn(() => []);

				const handler = registerWith({ getCueHistoryGroupRuns, getMaxEntries: () => 500 })(
					'history:getCueGroupRuns'
				);
				await handler({} as any, { sessionId: 'session-1', groupKey: 'PR-Sweep' });

				expect(getCueHistoryGroupRuns).toHaveBeenCalledWith(
					expect.objectContaining({ limit: 500 })
				);
			});

			it('asks for nothing without both an agent and a group', async () => {
				const getCueHistoryGroupRuns = vi.fn(() => [cueRow()]);

				const handler = registerWith({ getCueHistoryGroupRuns })('history:getCueGroupRuns');

				expect(await handler({} as any, { sessionId: 'session-1' })).toEqual([]);
				expect(await handler({} as any, { groupKey: 'PR-Sweep' })).toEqual([]);
				expect(await handler({} as any, undefined)).toEqual([]);
				expect(getCueHistoryGroupRuns).not.toHaveBeenCalled();
			});

			it('degrades to no runs when the database throws', async () => {
				// The expander failing must not take the row - or the panel - down.
				const getCueHistoryGroupRuns = vi.fn(() => {
					throw new Error('database is locked');
				});

				const handler = registerWith({ getCueHistoryGroupRuns })('history:getCueGroupRuns');

				expect(await handler({} as any, { sessionId: 'session-1', groupKey: 'PR-Sweep' })).toEqual(
					[]
				);
			});

			it('returns nothing when no Cue query is wired at all', async () => {
				const handler = registerWith({})('history:getCueGroupRuns');

				expect(await handler({} as any, { sessionId: 'session-1', groupKey: 'PR-Sweep' })).toEqual(
					[]
				);
			});
		});

		it('counts Cue rows when resolving a graph-click offset', async () => {
			// The offset indexes the rendered list, which now includes rows that
			// are not in the JSONL file.
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'user-new', type: 'USER', timestamp: 4000 }),
				createMockEntry({ id: 'user-old', type: 'USER', timestamp: 2000 }),
			]);
			const getCueHistoryEntries = vi.fn(() => [cueRow({ id: 'cue-mid', timestamp: 3000 })]);

			const handler = registerWith({ getCueHistoryEntries })('history:getOffsetForTimestamp');
			// Merged newest-first: [user-new, cue-mid, user-old]
			expect(await handler({} as any, 'session-1', 2000, null)).toBe(2);
		});
	});

	describe('history:getGraphData Cue series', () => {
		/** Register a fresh handler set and return a getter for its channels. */
		const registerWith = (overrides: Record<string, unknown>): ((channel: string) => Function) => {
			registerHistoryHandlers({ safeSend: mockSafeSend, ...overrides } as any);
			return (channel: string) => {
				const calls = (ipcMain.handle as any).mock.calls.filter(
					([ch]: [string, Function]) => ch === channel
				);
				return calls[calls.length - 1][1];
			};
		};

		/**
		 * A cache in its own directory, plus a history file path so the handler
		 * takes the cached branch (which is also the branch that reads the JSONL
		 * entries - with no path it treats the agent as having none).
		 */
		const useFreshGraphCache = (): void => {
			setHistoryBucketCacheForTest(
				new HistoryBucketCache(path.join(GRAPH_CACHE_DIR, `run-${counter++}`))
			);
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/tmp/does-not-exist/session-1.jsonl' as any
			);
		};
		let counter = 0;

		afterEach(() => {
			setHistoryBucketCacheForTest(null);
		});

		it('draws CUE bars from the database, not from the JSONL file', async () => {
			useFreshGraphCache();
			const now = Date.now();
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'u1', type: 'USER', timestamp: now - 1000 }),
			]);
			const getCueHistoryBuckets = vi.fn(() => [
				{ timestamp: now - 1000, count: 4 },
				{ timestamp: now, count: 2 },
			]);

			const handler = registerWith({
				getCueHistoryBuckets,
				getCueHistoryFingerprint: () => 'fp',
			})('history:getGraphData');
			const result = await handler({} as any, 'session-1', 2, null);

			expect(result.cueCount).toBe(6);
			expect(result.userCount).toBe(1);
			expect(result.totalCount).toBe(7);
			expect(result.buckets.reduce((sum: number, b: any) => sum + b.cue, 0)).toBe(6);
		});

		it('asks for the lookback window, and for all time when there is none', async () => {
			const getCueHistoryBuckets = vi.fn(() => []);
			const handler = registerWith({
				getCueHistoryBuckets,
				getCueHistoryFingerprint: () => 'fp',
			})('history:getGraphData');

			await handler({} as any, 'session-1', 24, 24);
			const windowed = getCueHistoryBuckets.mock.calls[0][0] as any;
			expect(windowed.sessionId).toBe('session-1');
			expect(windowed.since).toBeGreaterThan(Date.now() - 25 * 60 * 60 * 1000);
			expect(windowed.since).toBeLessThanOrEqual(Date.now() - 23 * 60 * 60 * 1000);

			await handler({} as any, 'session-1', 24, null);
			expect((getCueHistoryBuckets.mock.calls[1][0] as any).since).toBeUndefined();
		});

		it('still returns the JSONL series when the Cue database throws', async () => {
			useFreshGraphCache();
			const now = Date.now();
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([
				createMockEntry({ id: 'u1', type: 'USER', timestamp: now }),
			]);
			const getCueHistoryBuckets = vi.fn(() => {
				throw new Error('database is locked');
			});

			const handler = registerWith({ getCueHistoryBuckets })('history:getGraphData');
			const result = await handler({} as any, 'session-1', 4, null);

			expect(result.userCount).toBe(1);
			expect(result.cueCount).toBe(0);
		});

		it('recomputes cached buckets when the Cue fingerprint moves', async () => {
			// The cache keys off the history file's mtime+size, which no longer
			// changes when a Cue run lands. Without the Cue half of the key the
			// graph would serve its first answer forever.
			useFreshGraphCache();
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue([]);

			const now = Date.now();
			let cueFingerprint = 'cue-1';
			let cueCount = 3;
			const handler = registerWith({
				getCueHistoryBuckets: () => [{ timestamp: now, count: cueCount }],
				getCueHistoryFingerprint: () => cueFingerprint,
			})('history:getGraphData');

			const first = await handler({} as any, 'session-1', 4, null);
			expect(first.cached).toBe(false);
			expect(first.cueCount).toBe(3);

			// Same fingerprint: the cached aggregate answers.
			cueCount = 99;
			const second = await handler({} as any, 'session-1', 4, null);
			expect(second.cached).toBe(true);
			expect(second.cueCount).toBe(3);

			// Fingerprint moved: recompute, and the new run shows up.
			cueFingerprint = 'cue-2';
			const third = await handler({} as any, 'session-1', 4, null);
			expect(third.cached).toBe(false);
			expect(third.cueCount).toBe(99);
		});
	});

	describe('history:getOffsetForTimestamp', () => {
		it('mirrors the list type filter so the offset lines up with rendered indices', async () => {
			// The activity-graph jump resolves an offset into the SAME type-filtered
			// list the panel renders. If the offset path ignored the filter, a newest
			// CUE entry would shift every offset by one and the jump would land on the
			// wrong row. Keep this in lockstep with getAllPaginated's type filter.
			const entries = [
				createMockEntry({ id: 'cue1', type: 'CUE', timestamp: 5000 }),
				createMockEntry({ id: 'user1', type: 'USER', timestamp: 3000 }),
				createMockEntry({ id: 'auto1', type: 'AUTO', timestamp: 2000 }),
			];
			vi.mocked(mockHistoryManager.getEntries).mockReturnValue(entries);

			const handler = handlers.get('history:getOffsetForTimestamp');

			// Filtered list (newest-first) is [user1, auto1]. Targeting auto1's
			// timestamp resolves to offset 1 within the filtered set.
			const filtered = await handler!({} as any, 'session-1', 2000, null, ['USER', 'AUTO']);
			expect(filtered).toBe(1);

			// Without the filter the leading CUE entry pushes the same target to
			// offset 2 - proving the filter is what aligns the offset.
			const unfiltered = await handler!({} as any, 'session-1', 2000, null);
			expect(unfiltered).toBe(2);
		});
	});

	describe('history:reload', () => {
		it('should return true (no-op for per-session storage)', async () => {
			const handler = handlers.get('history:reload');
			const result = await handler!({} as any);

			expect(result).toBe(true);
		});
	});

	describe('history:add', () => {
		it('should add entry to session history', async () => {
			const entry = createMockEntry({ sessionId: 'session-1', projectPath: '/test' });

			const handler = handlers.get('history:add');
			const result = await handler!({} as any, entry);

			expect(mockHistoryManager.addEntry).toHaveBeenCalledWith(
				'session-1',
				'/test',
				entry,
				undefined
			);
			expect(result).toBe(true);
		});

		it('should broadcast entry via safeSend after adding', async () => {
			const entry = createMockEntry({ sessionId: 'session-1', projectPath: '/test' });

			const handler = handlers.get('history:add');
			await handler!({} as any, entry);

			expect(mockSafeSend).toHaveBeenCalledWith('history:entryAdded', entry, 'session-1');
		});

		/**
		 * Web Login attribution.
		 *
		 * The entry is written by the DESKTOP renderer's exit listener even when
		 * a browser sent the turn, so there is no acting user in scope here and
		 * the account has to come from what the spawn noted, keyed by agent +
		 * tab. Reading `getActingUser()` at write time and expecting a browser
		 * account is the failure these pin.
		 */
		describe('Web Login attribution', () => {
			afterEach(() => {
				resetTurnActors();
			});

			it('stamps the account the spawn noted for this agent and tab', async () => {
				noteTurnActor('session-1', 'tab-3', {
					id: 'u1',
					username: 'pedram',
					displayName: 'Pedram A',
				});
				const entry = createMockEntry({
					sessionId: 'session-1',
					tabId: 'tab-3',
					projectPath: '/test',
				});

				const handler = handlers.get('history:add');
				await handler!({} as any, entry);

				expect(mockHistoryManager.addEntry).toHaveBeenCalledWith(
					'session-1',
					'/test',
					expect.objectContaining({ userName: 'pedram', userDisplayName: 'Pedram A' }),
					undefined
				);
				// The broadcast carries the same attributed copy, so a peer
				// client renders the sender pill without waiting for a reload.
				expect(mockSafeSend).toHaveBeenCalledWith(
					'history:entryAdded',
					expect.objectContaining({ userName: 'pedram' }),
					'session-1'
				);
			});

			it('leaves a desktop turn unattributed', async () => {
				const entry = createMockEntry({
					sessionId: 'session-1',
					tabId: 'tab-3',
					projectPath: '/test',
				});

				const handler = handlers.get('history:add');
				await handler!({} as any, entry);

				const written = vi.mocked(mockHistoryManager.addEntry).mock.calls[0][2] as HistoryEntry;
				expect(written.userName).toBeUndefined();
				expect(written.userDisplayName).toBeUndefined();
			});

			it('does not credit a turn from another tab of the same agent', async () => {
				noteTurnActor('session-1', 'tab-3', {
					id: 'u1',
					username: 'pedram',
					displayName: 'Pedram A',
				});
				const entry = createMockEntry({
					sessionId: 'session-1',
					tabId: 'tab-9',
					projectPath: '/test',
				});

				const handler = handlers.get('history:add');
				await handler!({} as any, entry);

				const written = vi.mocked(mockHistoryManager.addEntry).mock.calls[0][2] as HistoryEntry;
				expect(written.userName).toBeUndefined();
			});

			it('prefers a live acting user over the noted actor', async () => {
				noteTurnActor('session-1', 'tab-3', {
					id: 'u1',
					username: 'pedram',
					displayName: 'Pedram A',
				});
				const entry = createMockEntry({
					sessionId: 'session-1',
					tabId: 'tab-3',
					projectPath: '/test',
				});

				const handler = handlers.get('history:add');
				await runAsActingUser({ id: 'u2', username: 'raza', displayName: 'Raza' }, () =>
					handler!({} as any, entry)
				);

				const written = vi.mocked(mockHistoryManager.addEntry).mock.calls[0][2] as HistoryEntry;
				expect(written.userName).toBe('raza');
			});

			it('keeps a userName the caller supplied', async () => {
				noteTurnActor('session-1', 'tab-3', {
					id: 'u1',
					username: 'pedram',
					displayName: 'Pedram A',
				});
				const entry = createMockEntry({
					sessionId: 'session-1',
					tabId: 'tab-3',
					projectPath: '/test',
					userName: 'imported',
				});

				const handler = handlers.get('history:add');
				await handler!({} as any, entry);

				const written = vi.mocked(mockHistoryManager.addEntry).mock.calls[0][2] as HistoryEntry;
				expect(written.userName).toBe('imported');
			});
		});

		it('should use orphaned session ID when sessionId is missing', async () => {
			const entry = createMockEntry({ sessionId: undefined, projectPath: '/test' });

			const handler = handlers.get('history:add');
			const result = await handler!({} as any, entry);

			expect(mockHistoryManager.addEntry).toHaveBeenCalledWith(
				'_orphaned',
				'/test',
				entry,
				undefined
			);
			expect(result).toBe(true);
		});

		it('should handle entry with all fields', async () => {
			const entry = createMockEntry({
				id: 'unique-id',
				type: 'ai_message',
				sessionId: 'my-session',
				projectPath: '/project/path',
				timestamp: 1234567890,
				summary: 'Detailed summary',
				agentSessionId: 'agent-123',
				sessionName: 'My Session',
			});

			const handler = handlers.get('history:add');
			await handler!({} as any, entry);

			expect(mockHistoryManager.addEntry).toHaveBeenCalledWith(
				'my-session',
				'/project/path',
				entry,
				undefined
			);
		});

		it('should NOT write shared history for local agents (no sharedContext)', async () => {
			const entry = createMockEntry({ sessionId: 'session-1', projectPath: '/test' });

			const handler = handlers.get('history:add');
			await handler!({} as any, entry);

			expect(sharedHistoryModule.writeEntryRemote).not.toHaveBeenCalled();
		});

		it('should write shared history to remote when sharedContext is provided', async () => {
			const mockSshRemote = { id: 'remote-1', host: 'dev-server', user: 'user' };
			registerHistoryHandlers({
				safeSend: mockSafeSend,
				getSshRemoteById: () => mockSshRemote as any,
			});
			// Re-capture newly registered handlers
			const addCalls = (ipcMain.handle as any).mock.calls.filter(
				([ch]: [string, Function]) => ch === 'history:add'
			);
			const addHandler = addCalls[addCalls.length - 1][1];

			const entry = createMockEntry({ sessionId: 'session-1', projectPath: '/test' });
			const sharedContext = { sshRemoteId: 'remote-1', remoteCwd: '/remote/project' };

			await addHandler({} as any, entry, sharedContext);

			expect(sharedHistoryModule.writeEntryRemote).toHaveBeenCalledWith(
				'/remote/project',
				entry,
				mockSshRemote
			);
		});

		it('should NOT write local shared history when the session has no shareHistoryToProjectDir flag', async () => {
			registerHistoryHandlers({
				safeSend: mockSafeSend,
				getSessionById: () => ({
					id: 'session-1',
					sessionSshRemoteConfig: { enabled: false, remoteId: null },
				}),
			});
			const addCalls = (ipcMain.handle as any).mock.calls.filter(
				([ch]: [string, Function]) => ch === 'history:add'
			);
			const addHandler = addCalls[addCalls.length - 1][1];

			const entry = createMockEntry({ sessionId: 'session-1', projectPath: '/test/project' });
			await addHandler({} as any, entry);

			expect(sharedHistoryModule.writeEntryLocal).not.toHaveBeenCalled();
		});

		it('should mirror the entry to local .maestro/history/ when the session has shareHistoryToProjectDir on', async () => {
			registerHistoryHandlers({
				safeSend: mockSafeSend,
				getMaxEntries: () => 5000,
				getSessionById: () => ({
					id: 'session-1',
					sessionSshRemoteConfig: {
						enabled: false,
						remoteId: null,
						shareHistoryToProjectDir: true,
					},
				}),
			});
			const addCalls = (ipcMain.handle as any).mock.calls.filter(
				([ch]: [string, Function]) => ch === 'history:add'
			);
			const addHandler = addCalls[addCalls.length - 1][1];

			const entry = createMockEntry({ sessionId: 'session-1', projectPath: '/test/project' });
			await addHandler({} as any, entry);

			expect(sharedHistoryModule.writeEntryLocal).toHaveBeenCalledWith(
				'/test/project',
				entry,
				5000
			);
		});

		it('should still mirror when SSH is also enabled (local mirror is independent of SSH push)', async () => {
			registerHistoryHandlers({
				safeSend: mockSafeSend,
				getSessionById: () => ({
					id: 'session-1',
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'remote-1',
						syncHistory: true,
						shareHistoryToProjectDir: true,
					},
				}),
			});
			const addCalls = (ipcMain.handle as any).mock.calls.filter(
				([ch]: [string, Function]) => ch === 'history:add'
			);
			const addHandler = addCalls[addCalls.length - 1][1];

			const entry = createMockEntry({ sessionId: 'session-1', projectPath: '/test/project' });
			await addHandler({} as any, entry);

			expect(sharedHistoryModule.writeEntryLocal).toHaveBeenCalledWith(
				'/test/project',
				entry,
				undefined
			);
		});

		it('should skip local mirror when entry has no projectPath, even with the flag on', async () => {
			registerHistoryHandlers({
				safeSend: mockSafeSend,
				getSessionById: () => ({
					id: 'session-1',
					sessionSshRemoteConfig: {
						enabled: false,
						remoteId: null,
						shareHistoryToProjectDir: true,
					},
				}),
			});
			const addCalls = (ipcMain.handle as any).mock.calls.filter(
				([ch]: [string, Function]) => ch === 'history:add'
			);
			const addHandler = addCalls[addCalls.length - 1][1];

			const entry = createMockEntry({ sessionId: 'session-1', projectPath: '' });
			await addHandler({} as any, entry);

			expect(sharedHistoryModule.writeEntryLocal).not.toHaveBeenCalled();
		});

		describe('history.entryAdded plugin event (FC4)', () => {
			/** Register with an emit spy and return the freshly registered add handler. */
			function registerWithPluginEmit(): {
				emitPluginEvent: ReturnType<typeof vi.fn>;
				addHandler: Function;
			} {
				const emitPluginEvent = vi.fn();
				registerHistoryHandlers({ safeSend: mockSafeSend, emitPluginEvent });
				const addCalls = vi
					.mocked(ipcMain.handle)
					.mock.calls.filter(([channel]) => channel === 'history:add');
				const addHandler = addCalls[addCalls.length - 1][1];
				return { emitPluginEvent, addHandler };
			}

			it('emits ids/classification only at the ingestion point - never summary/fullResponse', async () => {
				const { emitPluginEvent, addHandler } = registerWithPluginEmit();
				const entry = createMockEntry({
					id: 'entry-42',
					type: 'USER',
					sessionId: 'session-1',
					projectPath: '/test/project',
					summary: 'SECRET user prompt text',
					fullResponse: 'SECRET agent output body',
				});

				await addHandler({}, entry);

				expect(emitPluginEvent).toHaveBeenCalledTimes(1);
				const event = emitPluginEvent.mock.calls[0][0];
				expect(event.topic).toBe('history.entryAdded');
				expect(typeof event.at).toBe('string');
				expect(event.payload).toEqual({
					entryId: 'entry-42',
					sessionId: 'session-1',
					projectPath: '/test/project',
					kind: 'USER',
					createdAt: entry.timestamp,
				});
				expect(JSON.stringify(event.payload)).not.toContain('SECRET');
			});

			it('omits sessionId when the entry has none (orphaned entries)', async () => {
				const { emitPluginEvent, addHandler } = registerWithPluginEmit();
				const entry = createMockEntry({ id: 'entry-9', sessionId: undefined });

				await addHandler({}, entry);

				const event = emitPluginEvent.mock.calls[0][0];
				expect(event.payload).not.toHaveProperty('sessionId');
				expect(event.payload.entryId).toBe('entry-9');
			});

			it('still adds the entry and notifies the renderer when no emitter is wired', async () => {
				// The default beforeEach registration passes no emitPluginEvent.
				const handler = handlers.get('history:add');
				const entry = createMockEntry({ sessionId: 'session-1' });

				const result = await handler!({}, entry);

				expect(result).toBe(true);
				expect(mockHistoryManager.addEntry).toHaveBeenCalled();
				expect(mockSafeSend).toHaveBeenCalledWith('history:entryAdded', entry, 'session-1');
			});
		});
	});

	describe('history:clear', () => {
		it('should clear history for specific session', async () => {
			const handler = handlers.get('history:clear');
			const result = await handler!({} as any, undefined, 'session-1');

			expect(mockHistoryManager.clearSession).toHaveBeenCalledWith('session-1');
			expect(result).toBe(true);
		});

		it('should clear history for project path', async () => {
			const handler = handlers.get('history:clear');
			const result = await handler!({} as any, '/test/project');

			expect(mockHistoryManager.clearByProjectPath).toHaveBeenCalledWith('/test/project');
			expect(result).toBe(true);
		});

		it('should clear all history when no filters provided', async () => {
			const handler = handlers.get('history:clear');
			const result = await handler!({} as any);

			expect(mockHistoryManager.clearAll).toHaveBeenCalled();
			expect(result).toBe(true);
		});
	});

	describe('history:delete', () => {
		it('should delete entry from specific session', async () => {
			vi.mocked(mockHistoryManager.deleteEntry).mockReturnValue(true);

			const handler = handlers.get('history:delete');
			const result = await handler!({} as any, 'entry-123', 'session-1');

			expect(mockHistoryManager.deleteEntry).toHaveBeenCalledWith('session-1', 'entry-123');
			expect(result).toBe(true);
		});

		it('should return false when entry not found in session', async () => {
			vi.mocked(mockHistoryManager.deleteEntry).mockReturnValue(false);

			const handler = handlers.get('history:delete');
			const result = await handler!({} as any, 'non-existent', 'session-1');

			expect(result).toBe(false);
		});

		it('should search all sessions when sessionId not provided', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
			]);
			vi.mocked(mockHistoryManager.deleteEntry)
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);

			const handler = handlers.get('history:delete');
			const result = await handler!({} as any, 'entry-123');

			expect(mockHistoryManager.listSessionsWithHistory).toHaveBeenCalled();
			expect(mockHistoryManager.deleteEntry).toHaveBeenCalledWith('session-1', 'entry-123');
			expect(mockHistoryManager.deleteEntry).toHaveBeenCalledWith('session-2', 'entry-123');
			expect(result).toBe(true);
		});

		it('should return false when entry not found in any session', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
			]);
			vi.mocked(mockHistoryManager.deleteEntry).mockReturnValue(false);

			const handler = handlers.get('history:delete');
			const result = await handler!({} as any, 'non-existent');

			expect(result).toBe(false);
		});
	});

	describe('history:update', () => {
		it('should update entry in specific session', async () => {
			vi.mocked(mockHistoryManager.updateEntry).mockReturnValue(true);

			const updates = { validated: true };
			const handler = handlers.get('history:update');
			const result = await handler!({} as any, 'entry-123', updates, 'session-1');

			expect(mockHistoryManager.updateEntry).toHaveBeenCalledWith(
				'session-1',
				'entry-123',
				updates
			);
			expect(result).toBe(true);
		});

		it('should return false when entry not found in session', async () => {
			vi.mocked(mockHistoryManager.updateEntry).mockReturnValue(false);

			const handler = handlers.get('history:update');
			const result = await handler!({} as any, 'non-existent', { validated: true }, 'session-1');

			expect(result).toBe(false);
		});

		it('should search all sessions when sessionId not provided', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
			]);
			vi.mocked(mockHistoryManager.updateEntry)
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(true);

			const updates = { summary: 'Updated summary' };
			const handler = handlers.get('history:update');
			const result = await handler!({} as any, 'entry-123', updates);

			expect(mockHistoryManager.updateEntry).toHaveBeenCalledWith(
				'session-1',
				'entry-123',
				updates
			);
			expect(mockHistoryManager.updateEntry).toHaveBeenCalledWith(
				'session-2',
				'entry-123',
				updates
			);
			expect(result).toBe(true);
		});

		it('should return false when entry not found in any session', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue(['session-1']);
			vi.mocked(mockHistoryManager.updateEntry).mockReturnValue(false);

			const handler = handlers.get('history:update');
			const result = await handler!({} as any, 'non-existent', { validated: true });

			expect(result).toBe(false);
		});
	});

	describe('history:updateSessionName', () => {
		it('should update session name for matching entries', async () => {
			vi.mocked(mockHistoryManager.updateSessionNameByClaudeSessionId).mockReturnValue(5);

			const handler = handlers.get('history:updateSessionName');
			const result = await handler!({} as any, 'agent-session-123', 'New Session Name');

			expect(mockHistoryManager.updateSessionNameByClaudeSessionId).toHaveBeenCalledWith(
				'agent-session-123',
				'New Session Name'
			);
			expect(result).toBe(5);
		});

		it('should return 0 when no matching entries found', async () => {
			vi.mocked(mockHistoryManager.updateSessionNameByClaudeSessionId).mockReturnValue(0);

			const handler = handlers.get('history:updateSessionName');
			const result = await handler!({} as any, 'non-existent-agent', 'Name');

			expect(result).toBe(0);
		});
	});

	describe('history:getFilePath', () => {
		it('should return file path for existing session', async () => {
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(
				'/path/to/history/session-1.json'
			);

			const handler = handlers.get('history:getFilePath');
			const result = await handler!({} as any, 'session-1');

			expect(mockHistoryManager.getHistoryFilePath).toHaveBeenCalledWith('session-1');
			expect(result).toBe('/path/to/history/session-1.json');
		});

		it('should return null for non-existent session', async () => {
			vi.mocked(mockHistoryManager.getHistoryFilePath).mockReturnValue(null);

			const handler = handlers.get('history:getFilePath');
			const result = await handler!({} as any, 'non-existent');

			expect(result).toBe(null);
		});
	});

	describe('history:listSessions', () => {
		it('should return list of sessions with history', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([
				'session-1',
				'session-2',
				'session-3',
			]);

			const handler = handlers.get('history:listSessions');
			const result = await handler!({} as any);

			expect(mockHistoryManager.listSessionsWithHistory).toHaveBeenCalled();
			expect(result).toEqual(['session-1', 'session-2', 'session-3']);
		});

		it('should return empty array when no sessions have history', async () => {
			vi.mocked(mockHistoryManager.listSessionsWithHistory).mockReturnValue([]);

			const handler = handlers.get('history:listSessions');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});
	});
});
