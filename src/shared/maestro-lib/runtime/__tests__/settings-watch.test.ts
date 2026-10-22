import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changedTopLevelKeys, watchSettingsFile, type WatchDirectory } from '../settings-watch';

describe('changedTopLevelKeys', () => {
	it('lists added, removed, and changed keys, comparing values deeply', () => {
		expect(
			changedTopLevelKeys(
				{ keep: { a: [1, 2] }, change: 1, gone: true },
				{ keep: { a: [1, 2] }, change: 2, added: 'x' }
			).sort()
		).toEqual(['added', 'change', 'gone']);
	});

	it('is empty for equal documents', () => {
		expect(changedTopLevelKeys({ a: { b: 1 } }, { a: { b: 1 } })).toEqual([]);
	});
});

describe('watchSettingsFile', () => {
	let values: Record<string, unknown> | undefined;
	let listener: (event: string, name: string | null) => void;
	let closed: boolean;
	let changes: string[][];
	let watchedDir: string | undefined;

	const watch: WatchDirectory = (dir, next) => {
		watchedDir = dir;
		listener = next;
		return {
			close: () => {
				closed = true;
			},
		};
	};

	const start = (extra: Partial<Parameters<typeof watchSettingsFile>[0]> = {}) =>
		watchSettingsFile({
			file: '/data/maestro-settings.json',
			onChange: (keys) => changes.push(keys),
			read: () => values,
			watch,
			debounceMs: 250,
			...extra,
		});

	beforeEach(() => {
		vi.useFakeTimers();
		values = { theme: 'dark', defaultShell: 'zsh' };
		closed = false;
		changes = [];
		watchedDir = undefined;
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('watches the directory, not the file, which is replaced by rename', () => {
		start();
		expect(watchedDir).toBe('/data');
	});

	it('reports nothing for the initial read', () => {
		start();
		vi.advanceTimersByTime(1000);
		expect(changes).toEqual([]);
	});

	it('reports the changed keys once the writes settle', () => {
		start();
		values = { theme: 'light', defaultShell: 'zsh', extra: 1 };
		listener('rename', 'maestro-settings.json');
		listener('change', 'maestro-settings.json');
		vi.advanceTimersByTime(249);
		expect(changes).toEqual([]);
		vi.advanceTimersByTime(2);
		expect(changes).toEqual([['theme', 'extra']]);
	});

	it('ignores other files in the directory', () => {
		start();
		values = { theme: 'light' };
		listener('change', 'maestro-sessions.json');
		vi.advanceTimersByTime(1000);
		expect(changes).toEqual([]);
	});

	it('treats an event with no file name as possibly ours', () => {
		start();
		values = { theme: 'light', defaultShell: 'zsh' };
		listener('change', null);
		vi.advanceTimersByTime(300);
		expect(changes).toEqual([['theme']]);
	});

	it('stays quiet when the file was rewritten with the same content', () => {
		start();
		listener('change', 'maestro-settings.json');
		vi.advanceTimersByTime(300);
		expect(changes).toEqual([]);
	});

	it('keeps the last good copy through an unreadable read and diffs against it later', () => {
		start();
		values = undefined;
		listener('change', 'maestro-settings.json');
		vi.advanceTimersByTime(300);
		expect(changes).toEqual([]);
		values = { theme: 'light', defaultShell: 'zsh' };
		listener('change', 'maestro-settings.json');
		vi.advanceTimersByTime(300);
		expect(changes).toEqual([['theme']]);
	});

	it('does not report after close, and closes the watcher', () => {
		const watcher = start();
		values = { theme: 'light' };
		listener('change', 'maestro-settings.json');
		watcher.close();
		vi.advanceTimersByTime(1000);
		expect(changes).toEqual([]);
		expect(closed).toBe(true);
	});

	it('survives a directory that cannot be watched', () => {
		const watcher = start({
			watch: () => {
				throw new Error('ENOENT');
			},
		});
		expect(() => watcher.close()).not.toThrow();
	});
});
