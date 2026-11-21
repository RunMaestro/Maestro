// Source: src/__tests__/main/stores/migrations/playbooks-folder.test.ts
// Source: src/__tests__/main/stores/migrations/claude-session-names-backfill.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import * as path from 'path';
import { migratePlaybooksFolder } from '../../../../main/stores/migrations/playbooks-folder';
import { PLAYBOOKS_FOLDER_MIGRATION_MARKER } from '../../../../main/stores/migrations/playbooks-folder';
import { getSessionsStore } from '../../../../main/stores/getters';
import { migrateClaudeSessionNamesFromHistory } from '../../../../main/stores/migrations/claude-session-names-backfill';
import { CLAUDE_SESSION_NAMES_BACKFILL_MARKER } from '../../../../main/stores/migrations/claude-session-names-backfill';
// Only the playbook migration uses this in-memory filesystem.
const fsState = vi.hoisted(() => ({
	existingDirs: new Set<string>(),
	renames: [] as Array<{ from: string; to: string }>,
	copies: [] as Array<{ from: string; to: string }>,
	removes: [] as string[],
	mkdirs: [] as string[],
}));
vi.mock('fs', () => ({
	statSync: vi.fn((p: string) => {
		if (fsState.existingDirs.has(p)) {
			return { isDirectory: () => true } as any;
		}
		throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
	}),
	existsSync: vi.fn((p: string) => fsState.existingDirs.has(p)),
	mkdirSync: vi.fn((p: string) => {
		fsState.mkdirs.push(p);
	}),
	renameSync: vi.fn((from: string, to: string) => {
		fsState.renames.push({ from, to });
		fsState.existingDirs.delete(from);
		fsState.existingDirs.add(to);
	}),
	cpSync: vi.fn((from: string, to: string) => {
		fsState.copies.push({ from, to });
	}),
	rmSync: vi.fn((p: string) => {
		fsState.removes.push(p);
		fsState.existingDirs.delete(p);
	}),
}));
vi.mock('../../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
describe('playbooks-folder', () => {
	const mockedGetSessionsStore = vi.mocked(getSessionsStore);

	const CANONICAL = path.join('.maestro', 'playbooks');
	const LEGACY = 'Auto Run Docs';

	/** Minimal in-memory electron-store double backed by a plain record. */
	function makeStore(initial: Record<string, any> = {}) {
		const data: Record<string, any> = { ...initial };
		return {
			data,
			get: vi.fn((key: string, fallback?: any) => (key in data ? data[key] : fallback)),
			set: vi.fn((key: string, value: any) => {
				data[key] = value;
			}),
		};
	}

	describe('migratePlaybooksFolder', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			fsState.existingDirs = new Set();
			fsState.renames = [];
			fsState.copies = [];
			fsState.removes = [];
			fsState.mkdirs = [];
		});

		it('moves a legacy folder (rename) and repoints the agent, leaving custom and canonical agents alone', () => {
			const legacyDir = path.join('/proj/a', LEGACY);
			fsState.existingDirs.add(legacyDir); // canonical absent -> rename path

			const sessionsStore = makeStore({
				sessions: [
					{ id: 'a', name: 'Legacy', projectRoot: '/proj/a', autoRunFolderPath: legacyDir },
					{
						id: 'b',
						name: 'Custom',
						projectRoot: '/proj/b',
						autoRunFolderPath: '/proj/b/custom-docs',
					},
					{
						id: 'c',
						name: 'Canonical',
						projectRoot: '/proj/c',
						autoRunFolderPath: path.join('/proj/c', CANONICAL),
					},
				],
			});
			mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
			const settingsStore = makeStore();

			migratePlaybooksFolder(settingsStore as any);

			// Folder moved via rename into the canonical location.
			expect(fsState.renames).toEqual([{ from: legacyDir, to: path.join('/proj/a', CANONICAL) }]);

			// Only agent 'a' was repointed; 'b' (custom) and 'c' (canonical) untouched.
			const written = sessionsStore.set.mock.calls[0][1];
			expect(written[0].autoRunFolderPath).toBe(path.join('/proj/a', CANONICAL));
			expect(written[1].autoRunFolderPath).toBe('/proj/b/custom-docs');
			expect(written[2].autoRunFolderPath).toBe(path.join('/proj/c', CANONICAL));
			expect(settingsStore.data[PLAYBOOKS_FOLDER_MIGRATION_MARKER]).toBe(true);
		});

		it('merges into an existing canonical folder without clobbering it', () => {
			const legacyDir = path.join('/proj/a', LEGACY);
			const canonicalDir = path.join('/proj/a', CANONICAL);
			fsState.existingDirs.add(legacyDir);
			fsState.existingDirs.add(canonicalDir); // canonical present -> merge path

			const sessionsStore = makeStore({
				sessions: [
					{ id: 'a', name: 'Legacy', projectRoot: '/proj/a', autoRunFolderPath: legacyDir },
				],
			});
			mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
			const settingsStore = makeStore();

			migratePlaybooksFolder(settingsStore as any);

			expect(fsState.renames).toEqual([]);
			expect(fsState.copies).toEqual([{ from: legacyDir, to: canonicalDir }]);
			expect(fsState.removes).toEqual([legacyDir]);
			expect(settingsStore.data[PLAYBOOKS_FOLDER_MIGRATION_MARKER]).toBe(true);
		});

		it('repoints a legacy path even when the folder is already gone from disk', () => {
			const legacyDir = path.join('/proj/a', LEGACY);
			// Nothing added to existingDirs -> no folder on disk.
			const sessionsStore = makeStore({
				sessions: [
					{ id: 'a', name: 'Legacy', projectRoot: '/proj/a', autoRunFolderPath: legacyDir },
				],
			});
			mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
			const settingsStore = makeStore();

			migratePlaybooksFolder(settingsStore as any);

			expect(fsState.renames).toEqual([]);
			expect(fsState.copies).toEqual([]);
			const written = sessionsStore.set.mock.calls[0][1];
			expect(written[0].autoRunFolderPath).toBe(path.join('/proj/a', CANONICAL));
		});

		it('sets the marker without writing sessions when nothing needs updating', () => {
			const sessionsStore = makeStore({
				sessions: [
					{
						id: 'c',
						name: 'Canonical',
						projectRoot: '/proj/c',
						autoRunFolderPath: path.join('/proj/c', CANONICAL),
					},
				],
			});
			mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
			const settingsStore = makeStore();

			migratePlaybooksFolder(settingsStore as any);

			expect(sessionsStore.set).not.toHaveBeenCalled();
			expect(settingsStore.data[PLAYBOOKS_FOLDER_MIGRATION_MARKER]).toBe(true);
		});

		it('is idempotent - does nothing once the marker is set', () => {
			const sessionsStore = makeStore({
				sessions: [
					{
						id: 'a',
						name: 'Legacy',
						projectRoot: '/proj/a',
						autoRunFolderPath: path.join('/proj/a', LEGACY),
					},
				],
			});
			mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
			const settingsStore = makeStore({ [PLAYBOOKS_FOLDER_MIGRATION_MARKER]: true });

			migratePlaybooksFolder(settingsStore as any);

			expect(mockedGetSessionsStore).not.toHaveBeenCalled();
			expect(sessionsStore.set).not.toHaveBeenCalled();
		});
	});
});
describe('claude-session-names-backfill', () => {
	/** Minimal in-memory electron-store double backed by a plain record. */
	function makeStore(initial: Record<string, any> = {}) {
		const data: Record<string, any> = { ...initial };
		return {
			data,
			get: vi.fn((key: string, fallback?: any) => (key in data ? data[key] : fallback)),
			set: vi.fn((key: string, value: any) => {
				data[key] = value;
			}),
		};
	}

	function makeHistory(bySession: Record<string, Array<Record<string, unknown>>>) {
		return {
			listSessionsWithHistory: vi.fn(async () => Object.keys(bySession)),
			getEntries: vi.fn(async (sessionId: string) => bySession[sessionId] ?? []),
		};
	}

	describe('migrateClaudeSessionNamesFromHistory', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('restores lost names from every agent history file and sets the marker', async () => {
			const settings = makeStore();
			const origins = makeStore({ origins: { '/vault': { 'sess-1': 'user' } } });
			const history = makeHistory({
				agentA: [{ agentSessionId: 'sess-1', sessionName: 'TypeSafe.ai JEV Skill', timestamp: 5 }],
				agentB: [],
			});

			await migrateClaudeSessionNamesFromHistory(settings as any, origins as any, history as any);

			expect(origins.data.origins).toEqual({
				'/vault': { 'sess-1': { origin: 'user', sessionName: 'TypeSafe.ai JEV Skill' } },
			});
			expect(settings.data[CLAUDE_SESSION_NAMES_BACKFILL_MARKER]).toBe(true);
		});

		it('does nothing once the marker is set', async () => {
			const settings = makeStore({ [CLAUDE_SESSION_NAMES_BACKFILL_MARKER]: true });
			const origins = makeStore({ origins: { '/vault': { 'sess-1': 'user' } } });
			const history = makeHistory({
				agentA: [{ agentSessionId: 'sess-1', sessionName: 'Named', timestamp: 5 }],
			});

			await migrateClaudeSessionNamesFromHistory(settings as any, origins as any, history as any);

			expect(history.listSessionsWithHistory).not.toHaveBeenCalled();
			expect(origins.set).not.toHaveBeenCalled();
		});
	});
});
