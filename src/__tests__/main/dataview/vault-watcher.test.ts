/**
 * Tests for the local Dataview watcher (src/main/dataview/vault-watcher.ts): which paths it reports, the
 * root-relative ignore rule, and that a burst of chokidar events becomes ONE debounced batch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();
const mockClose = vi.fn(async () => {});
const fakeWatcher = {
	on: vi.fn((event: string, handler: Handler) => {
		handlers.set(event, handler);
		return fakeWatcher;
	}),
	once: vi.fn((event: string, handler: Handler) => {
		handlers.set(event, handler);
		return fakeWatcher;
	}),
	close: mockClose,
};
vi.mock('chokidar', () => ({ watch: vi.fn(() => fakeWatcher) }));

const invalidateVaultRootCache = vi.fn();
vi.mock('../../../main/dataview/vault-root', () => ({
	VAULT_MARKER_DIR: '.obsidian',
	invalidateVaultRootCache: (...args: unknown[]) => invalidateVaultRootCache(...args),
}));
vi.mock('../../../main/utils/remote-fs', () => ({
	listFilesWithStatsRemote: vi.fn(),
	readFileRemote: vi.fn(),
}));

import * as chokidar from 'chokidar';
import {
	DATAVIEW_WATCH_DEBOUNCE_MS,
	createVaultWatcher,
	isWatchedVaultPath,
	toVaultRelativePath,
	vaultWatchIgnored,
} from '../../../main/dataview/vault-watcher';
import { VAULT_MAX_DEPTH } from '../../../main/dataview/vault-fs';

// Built with path.join so the cases hold on Windows too.
const ROOT = path.join(path.sep, 'Users', 'me', 'Vault');
const inRoot = (...segments: string[]) => path.join(ROOT, ...segments);

describe('isWatchedVaultPath', () => {
	it('reports indexed paths and skips dot folders, node_modules, and system files', () => {
		expect(isWatchedVaultPath('')).toBe(true);
		expect(isWatchedVaultPath('People/Pedram Amini.md')).toBe(true);
		expect(isWatchedVaultPath('data/people.csv')).toBe(true);
		expect(isWatchedVaultPath('.trash/Deleted.md')).toBe(false);
		expect(isWatchedVaultPath('.git/HEAD')).toBe(false);
		expect(isWatchedVaultPath('app/node_modules/x/README.md')).toBe(false);
		expect(isWatchedVaultPath('pagefile.sys')).toBe(false);
	});

	it('reports a .obsidian folder itself and the root bookmarks file, but nothing else inside it', () => {
		expect(isWatchedVaultPath('.obsidian')).toBe(true);
		expect(isWatchedVaultPath('Sub/Vault/.obsidian')).toBe(true);
		expect(isWatchedVaultPath('.obsidian/bookmarks.json')).toBe(true);
		expect(isWatchedVaultPath('.obsidian/workspace.json')).toBe(false);
		expect(isWatchedVaultPath('Sub/.obsidian/bookmarks.json')).toBe(false);
		expect(isWatchedVaultPath('.trash/Old/.obsidian')).toBe(false);
	});
});

describe('vaultWatchIgnored', () => {
	it('decides on the path under the root only, so a root inside a dot folder still works', () => {
		const dotRoot = path.join(path.sep, 'repo', '.maestro', 'vault');
		const ignored = vaultWatchIgnored(dotRoot);
		expect(ignored(dotRoot)).toBe(false);
		expect(ignored(path.join(dotRoot, 'Note.md'))).toBe(false);
		expect(ignored(path.join(dotRoot, '.obsidian'))).toBe(false);
		expect(ignored(path.join(dotRoot, '.obsidian', 'app.json'))).toBe(true);
		expect(ignored(path.join(dotRoot, 'node_modules'))).toBe(true);
	});

	it('ignores anything outside the root', () => {
		expect(vaultWatchIgnored(ROOT)(path.join(path.sep, 'Users', 'me', 'Other.md'))).toBe(true);
	});

	it('maps absolute paths to vault-relative POSIX paths', () => {
		expect(toVaultRelativePath(ROOT, ROOT)).toBe('');
		expect(toVaultRelativePath(ROOT, inRoot('People', 'A.md'))).toBe('People/A.md');
		expect(toVaultRelativePath(ROOT, path.join(ROOT, '..', 'B.md'))).toBeNull();
	});

	it('maps a remote root with POSIX paths whatever this machine runs', () => {
		const remote = '/home/me/vault';
		expect(toVaultRelativePath(remote, '/home/me/vault/People/A.md', path.posix)).toBe(
			'People/A.md'
		);
		expect(toVaultRelativePath(remote, remote, path.posix)).toBe('');
		expect(toVaultRelativePath(remote, '/home/me/other/A.md', path.posix)).toBeNull();
	});
});

describe('createVaultWatcher', () => {
	beforeEach(() => {
		handlers.clear();
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('watches the whole root with chokidar, the vault ignore rule, and no initial events', () => {
		createVaultWatcher({ root: ROOT, onChange: vi.fn() });

		expect(chokidar.watch).toHaveBeenCalledWith(
			ROOT,
			expect.objectContaining({ ignoreInitial: true, persistent: true, depth: VAULT_MAX_DEPTH })
		);
		const options = vi.mocked(chokidar.watch).mock.calls[0][1]!;
		expect((options.ignored as (p: string) => boolean)(inRoot('.git', 'HEAD'))).toBe(true);
		for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir', 'error'])
			expect(handlers.has(event)).toBe(true);
	});

	it(`debounces a burst into one batch ${DATAVIEW_WATCH_DEBOUNCE_MS} ms after the last event`, () => {
		const onChange = vi.fn();
		createVaultWatcher({ root: ROOT, onChange });

		handlers.get('add')!(inRoot('A.md'));
		vi.advanceTimersByTime(DATAVIEW_WATCH_DEBOUNCE_MS - 50);
		handlers.get('change')!(inRoot('A.md'));
		handlers.get('unlink')!(inRoot('Old', 'B.md'));
		handlers.get('unlinkDir')!(inRoot('Old'));
		vi.advanceTimersByTime(DATAVIEW_WATCH_DEBOUNCE_MS - 1);
		expect(onChange).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(['A.md', 'Old/B.md', 'Old']);

		handlers.get('change')!(inRoot('A.md'));
		vi.advanceTimersByTime(DATAVIEW_WATCH_DEBOUNCE_MS);
		expect(onChange).toHaveBeenCalledTimes(2);
		expect(onChange).toHaveBeenLastCalledWith(['A.md']);
	});

	it('drops events for the root itself and for paths outside it', () => {
		const onChange = vi.fn();
		createVaultWatcher({ root: ROOT, onChange });

		handlers.get('addDir')!(ROOT);
		handlers.get('add')!(path.join(ROOT, '..', 'Escaped.md'));
		vi.advanceTimersByTime(DATAVIEW_WATCH_DEBOUNCE_MS);

		expect(onChange).not.toHaveBeenCalled();
	});

	it('invalidates cached vault roots when a .obsidian folder appears or vanishes', () => {
		const onChange = vi.fn();
		createVaultWatcher({ root: ROOT, onChange });

		handlers.get('addDir')!(inRoot('Sub', '.obsidian'));
		handlers.get('unlinkDir')!(inRoot('.obsidian'));
		handlers.get('addDir')!(inRoot('Sub', 'Notes'));

		expect(invalidateVaultRootCache.mock.calls).toEqual([
			[inRoot('Sub', '.obsidian')],
			[inRoot('.obsidian')],
		]);
		vi.advanceTimersByTime(DATAVIEW_WATCH_DEBOUNCE_MS);
		expect(onChange).toHaveBeenCalledWith(['Sub/.obsidian', '.obsidian', 'Sub/Notes']);
	});

	it('reports errors, resolves ready, and drops a pending batch on close', async () => {
		const onChange = vi.fn();
		const onError = vi.fn();
		const watcher = createVaultWatcher({ root: ROOT, onChange, onError });

		handlers.get('error')!(new Error('EMFILE'));
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EMFILE' }));

		handlers.get('ready')!();
		await expect(watcher.ready).resolves.toBeUndefined();

		handlers.get('add')!(inRoot('A.md'));
		await watcher.close();
		vi.advanceTimersByTime(DATAVIEW_WATCH_DEBOUNCE_MS);
		expect(onChange).not.toHaveBeenCalled();
		expect(mockClose).toHaveBeenCalledTimes(1);
	});
});
