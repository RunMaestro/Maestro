import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryManager, getHistoryManager } from '../../main/history-manager';
import {
	HISTORY_VERSION,
	MAX_ENTRIES_PER_SESSION,
	sanitizeSessionId,
	type HistoryFileData,
	type MigrationMarker,
} from '../../shared/history';
import type { HistoryEntry } from '../../shared/types';

const mocks = vi.hoisted(() => ({
	userDataDir: '',
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
	captureException: vi.fn(),
}));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => mocks.userDataDir),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: mocks.logger,
}));

vi.mock('../../main/utils/sentry', () => ({
	captureException: mocks.captureException,
}));

function createEntry(
	id: string,
	sessionId: string,
	overrides: Partial<HistoryEntry> = {}
): HistoryEntry {
	return {
		id,
		type: 'USER',
		timestamp: 1_700_000_000_000,
		summary: `Summary for ${id}`,
		projectPath: '/repo/alpha',
		sessionId,
		...overrides,
	};
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

describe('HistoryManager integration', () => {
	let tempRoot: string;
	let activeManagers: HistoryManager[];

	function createManager() {
		const manager = new HistoryManager();
		activeManagers.push(manager);
		return manager;
	}

	function historyFilePath(sessionId: string) {
		return path.join(mocks.userDataDir, 'history', `${sanitizeSessionId(sessionId)}.json`);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-history-manager-integration-'));
		mocks.userDataDir = path.join(tempRoot, 'user-data');
		fs.mkdirSync(mocks.userDataDir, { recursive: true });
		activeManagers = [];
	});

	afterEach(() => {
		for (const manager of activeManagers) {
			manager.stopWatching();
		}
		vi.restoreAllMocks();
		fs.rmSync(tempRoot, { recursive: true, force: true });
		vi.useRealTimers();
	});

	it('migrates legacy global history into isolated session files and paginates queries', async () => {
		const manager = createManager();
		expect(manager.listSessionsWithHistory()).toEqual([]);
		expect(manager.getHistoryDir()).toBe(path.join(mocks.userDataDir, 'history'));
		expect(manager.getLegacyFilePath()).toBe(path.join(mocks.userDataDir, 'maestro-history.json'));

		const orphanedEntry: HistoryEntry = {
			id: 'orphaned',
			type: 'USER',
			timestamp: 4_000,
			summary: 'No session id',
			projectPath: '/repo/orphaned',
		};
		const legacyEntries = [
			createEntry('alpha-new', 'session/alpha', {
				timestamp: 3_000,
				summary: 'Newest alpha entry',
			}),
			createEntry('beta-old', 'session-beta', {
				timestamp: 1_000,
				projectPath: '/repo/beta',
			}),
			createEntry('alpha-old', 'session/alpha', {
				timestamp: 2_000,
			}),
			orphanedEntry,
		];
		fs.writeFileSync(
			path.join(mocks.userDataDir, 'maestro-history.json'),
			JSON.stringify({ entries: legacyEntries }),
			'utf-8'
		);

		await manager.initialize();

		expect(manager.hasMigrated()).toBe(true);
		expect(manager.listSessionsWithHistory().sort()).toEqual(['session-beta', 'session_alpha']);
		expect(manager.getEntries('session/alpha').map((entry) => entry.id)).toEqual([
			'alpha-new',
			'alpha-old',
		]);
		expect(manager.getEntries('missing-session')).toEqual([]);
		expect(readJson<HistoryFileData>(historyFilePath('session/alpha'))).toMatchObject({
			version: HISTORY_VERSION,
			sessionId: 'session/alpha',
			projectPath: '/repo/alpha',
		});
		expect(
			readJson<MigrationMarker>(path.join(mocks.userDataDir, 'history-migrated.json'))
		).toEqual(
			expect.objectContaining({
				version: HISTORY_VERSION,
				legacyEntryCount: 4,
				sessionsMigrated: 2,
			})
		);
		expect(manager.getAllEntries(2).map((entry) => entry.id)).toEqual(['alpha-new', 'alpha-old']);
		expect(
			manager.getEntriesByProjectPathPaginated('/repo/alpha', { limit: 1, offset: 1 })
		).toMatchObject({
			entries: [expect.objectContaining({ id: 'alpha-old' })],
			total: 2,
			limit: 1,
			offset: 1,
			hasMore: false,
		});
		expect(manager.getEntriesPaginated('session-beta')).toMatchObject({
			entries: [expect.objectContaining({ id: 'beta-old' })],
			total: 1,
		});

		await manager.initialize();
		expect(mocks.logger.info).toHaveBeenCalledWith(
			expect.stringContaining('History migration complete'),
			'[HistoryManager]'
		);
	});

	it('persists session history, trims old entries, updates names, and clears matching files', async () => {
		const manager = createManager();
		await manager.initialize();

		const first = createEntry('first', 'session:crud', {
			timestamp: 100,
			agentSessionId: 'agent-1',
			sessionName: 'Old name',
		});
		const second = createEntry('second', 'session:crud', {
			timestamp: 200,
			agentSessionId: 'agent-2',
		});
		manager.addEntry('session:crud', '/repo/alpha', first);
		manager.addEntry('session:crud', '/repo/alpha', second);

		expect(manager.getHistoryFilePath('session:crud')).toBe(historyFilePath('session:crud'));
		expect(manager.getEntries('session:crud').map((entry) => entry.id)).toEqual([
			'second',
			'first',
		]);
		expect(
			manager.updateEntry('session:crud', 'first', { summary: 'Updated', validated: true })
		).toBe(true);
		expect(manager.updateEntry('session:crud', 'missing', { summary: 'Nope' })).toBe(false);
		expect(manager.deleteEntry('session:crud', 'second')).toBe(true);
		expect(manager.deleteEntry('session:crud', 'missing')).toBe(false);

		manager.addEntry(
			'other-session',
			'/repo/beta',
			createEntry('other', 'other-session', {
				projectPath: '/repo/beta',
				agentSessionId: 'agent-1',
				sessionName: 'Old name',
			})
		);
		expect(manager.updateSessionNameByClaudeSessionId('agent-1', 'Renamed')).toBe(2);
		expect(manager.updateSessionNameByClaudeSessionId('missing-agent', 'No change')).toBe(0);
		expect(manager.getEntries('session:crud')[0]).toMatchObject({
			id: 'first',
			summary: 'Updated',
			sessionName: 'Renamed',
			validated: true,
		});

		const overflowEntries = Array.from({ length: MAX_ENTRIES_PER_SESSION }, (_, index) =>
			createEntry(`overflow-${index}`, 'overflow-session', {
				timestamp: index,
				projectPath: '/repo/overflow',
			})
		);
		fs.writeFileSync(
			historyFilePath('overflow-session'),
			JSON.stringify({
				version: HISTORY_VERSION,
				sessionId: 'overflow-session',
				projectPath: '/repo/overflow',
				entries: overflowEntries,
			}),
			'utf-8'
		);
		manager.addEntry(
			'overflow-session',
			'/repo/overflow',
			createEntry('overflow-new', 'overflow-session', {
				projectPath: '/repo/overflow',
			})
		);
		expect(manager.getEntries('overflow-session')).toHaveLength(MAX_ENTRIES_PER_SESSION);
		expect(manager.getEntries('overflow-session')[0].id).toBe('overflow-new');

		manager.clearByProjectPath('/repo/beta');
		expect(manager.getEntries('other-session')).toEqual([]);
		expect(manager.getEntriesByProjectPath('/repo/alpha').map((entry) => entry.id)).toEqual([
			'first',
		]);

		manager.clearAll();
		expect(manager.listSessionsWithHistory()).toEqual([]);
		expect(manager.getHistoryFilePath('session:crud')).toBeNull();
	});

	it('recovers from corrupt files and records filesystem failures without crashing', async () => {
		const manager = createManager();
		await manager.initialize();

		fs.writeFileSync(historyFilePath('broken-session'), '{not json', 'utf-8');
		expect(manager.getEntries('broken-session')).toEqual([]);
		expect(manager.updateEntry('broken-session', 'entry', { summary: 'Updated' })).toBe(false);
		expect(manager.deleteEntry('broken-session', 'entry')).toBe(false);

		const blockedPath = historyFilePath('blocked-session');
		fs.mkdirSync(blockedPath, { recursive: true });
		manager.addEntry(
			'blocked-session',
			'/repo/blocked',
			createEntry('blocked', 'blocked-session', {
				projectPath: '/repo/blocked',
			})
		);
		manager.clearSession('blocked-session');
		expect(manager.updateSessionNameByClaudeSessionId('agent-404', 'Never written')).toBe(0);

		manager.addEntry(
			'readonly-session',
			'/repo/readonly',
			createEntry('readonly-entry', 'readonly-session', {
				projectPath: '/repo/readonly',
			})
		);
		fs.chmodSync(historyFilePath('readonly-session'), 0o444);
		expect(
			manager.updateEntry('readonly-session', 'readonly-entry', { summary: 'Cannot write' })
		).toBe(false);
		expect(manager.deleteEntry('readonly-session', 'readonly-entry')).toBe(false);
		fs.chmodSync(historyFilePath('readonly-session'), 0o644);

		expect(mocks.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'history:read', sessionId: 'broken-session' })
		);
		expect(mocks.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'history:write', sessionId: 'blocked-session' })
		);
		expect(mocks.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'history:clear', sessionId: 'blocked-session' })
		);
		expect(mocks.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'history:updateSessionName' })
		);
		expect(mocks.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				operation: 'history:updateWrite',
				sessionId: 'readonly-session',
				entryId: 'readonly-entry',
			})
		);
		expect(mocks.captureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({
				operation: 'history:deleteWrite',
				sessionId: 'readonly-session',
				entryId: 'readonly-entry',
			})
		);
	});

	it('watches session file changes and logs watcher errors without crashing', () => {
		const manager = createManager();
		const changedSessions: string[] = [];

		manager.startWatching((sessionId) => {
			changedSessions.push(sessionId);
		});
		manager.startWatching((sessionId) => changedSessions.push(`duplicate:${sessionId}`));

		const watcher = (manager as unknown as { watcher: { emit: Function } | null }).watcher;
		watcher?.emit('change', 'change', 'watch-session.json');
		watcher?.emit('change', 'rename', 'ignored.txt');
		watcher?.emit('change', 'change', null);

		expect(changedSessions).toEqual(['watch-session']);
		expect(changedSessions.some((sessionId) => sessionId.startsWith('duplicate:'))).toBe(false);

		watcher?.emit('error', new Error('disk unavailable'));
		expect(mocks.logger.warn).toHaveBeenCalledWith(
			'History watcher error: disk unavailable',
			'[HistoryManager]'
		);

		manager.stopWatching();
		manager.stopWatching();
		expect((manager as unknown as { watcher: unknown | null }).watcher).toBeNull();
	});

	it('surfaces migration write failures and exposes the singleton manager', async () => {
		const manager = createManager();
		fs.mkdirSync(path.join(mocks.userDataDir, 'history', 'blocked-migration.json'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(mocks.userDataDir, 'maestro-history.json'),
			JSON.stringify({
				entries: [createEntry('blocked-migration-entry', 'blocked-migration')],
			}),
			'utf-8'
		);

		await expect(manager.initialize()).rejects.toThrow();
		expect(mocks.logger.error).toHaveBeenCalledWith(
			expect.stringContaining('History migration failed'),
			'[HistoryManager]'
		);

		const singleton = getHistoryManager();
		expect(singleton).toBe(getHistoryManager());
		expect(singleton).toBeInstanceOf(HistoryManager);
	});
});
