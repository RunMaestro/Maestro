import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// In-memory filesystem double. `existingDirs` is the set of paths that exist
// AND are directories; everything else is treated as missing.
const fsState: {
	existingDirs: Set<string>;
	renames: Array<{ from: string; to: string }>;
	copies: Array<{ from: string; to: string }>;
	removes: string[];
	mkdirs: string[];
} = {
	existingDirs: new Set(),
	renames: [],
	copies: [],
	removes: [],
	mkdirs: [],
};

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

import {
	migratePlaybooksFolder,
	PLAYBOOKS_FOLDER_MIGRATION_MARKER,
} from '../../../../main/stores/migrations/playbooks-folder';
import { getSessionsStore } from '../../../../main/stores/getters';

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
			sessions: [{ id: 'a', name: 'Legacy', projectRoot: '/proj/a', autoRunFolderPath: legacyDir }],
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
			sessions: [{ id: 'a', name: 'Legacy', projectRoot: '/proj/a', autoRunFolderPath: legacyDir }],
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
