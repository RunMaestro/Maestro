/**
 * Tests for the Cue file watcher provider.
 *
 * Tests cover:
 * - Chokidar watcher creation with correct options
 * - Per-file debouncing of change events
 * - CueEvent construction with correct payload
 * - Cleanup of timers and watcher
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock crypto.randomUUID
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

// Mock chokidar
const mockOn = vi.fn().mockReturnThis();
const mockClose = vi.fn();
vi.mock('chokidar', () => ({
	watch: vi.fn(() => ({
		on: mockOn,
		close: mockClose,
	})),
}));

import {
	createCueFileWatcher,
	CUE_POLLING_FALLBACK_INTERVAL_MS,
} from '../../../main/cue/cue-file-watcher';
import type { CueEvent } from '../../../main/cue/cue-types';
import * as chokidar from 'chokidar';

describe('cue-file-watcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('creates a chokidar watcher with correct options', () => {
		createCueFileWatcher({
			watchGlob: 'src/**/*.ts',
			projectRoot: '/projects/test',
			debounceMs: 5000,
			onEvent: vi.fn(),
			triggerName: 'test-trigger',
		});

		expect(chokidar.watch).toHaveBeenCalledWith('src/**/*.ts', {
			cwd: '/projects/test',
			ignoreInitial: true,
			persistent: true,
		});
	});

	it('registers change, add, and unlink handlers', () => {
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent: vi.fn(),
			triggerName: 'test',
		});

		const registeredEvents = mockOn.mock.calls.map((call) => call[0]);
		expect(registeredEvents).toContain('change');
		expect(registeredEvents).toContain('add');
		expect(registeredEvents).toContain('unlink');
		expect(registeredEvents).toContain('error');
	});

	it('debounces events per file', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent,
			triggerName: 'test',
		});

		const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
		expect(changeHandler).toBeDefined();

		// Rapid changes to the same file
		changeHandler('src/index.ts');
		changeHandler('src/index.ts');
		changeHandler('src/index.ts');

		vi.advanceTimersByTime(5000);
		expect(onEvent).toHaveBeenCalledTimes(1);
	});

	it('does not coalesce events from different files', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent,
			triggerName: 'test',
		});

		const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];

		changeHandler('src/a.ts');
		changeHandler('src/b.ts');

		vi.advanceTimersByTime(5000);
		expect(onEvent).toHaveBeenCalledTimes(2);
	});

	it('constructs a CueEvent with correct payload for change events', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 100,
			onEvent,
			triggerName: 'my-trigger',
		});

		const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
		changeHandler('src/index.ts');
		vi.advanceTimersByTime(100);

		expect(onEvent).toHaveBeenCalledTimes(1);
		const event: CueEvent = onEvent.mock.calls[0][0];
		expect(event.id).toBe('test-uuid-1234');
		expect(event.type).toBe('file.changed');
		expect(event.triggerName).toBe('my-trigger');
		expect(event.payload.filename).toBe('index.ts');
		expect(event.payload.extension).toBe('.ts');
		expect(event.payload.changeType).toBe('change');
	});

	it('reports correct changeType for add events', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 100,
			onEvent,
			triggerName: 'test',
		});

		const addHandler = mockOn.mock.calls.find((call) => call[0] === 'add')?.[1];
		addHandler('src/new.ts');
		vi.advanceTimersByTime(100);

		const event: CueEvent = onEvent.mock.calls[0][0];
		expect(event.payload.changeType).toBe('add');
	});

	it('reports correct changeType for unlink events', () => {
		const onEvent = vi.fn();
		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 100,
			onEvent,
			triggerName: 'test',
		});

		const unlinkHandler = mockOn.mock.calls.find((call) => call[0] === 'unlink')?.[1];
		unlinkHandler('src/deleted.ts');
		vi.advanceTimersByTime(100);

		const event: CueEvent = onEvent.mock.calls[0][0];
		expect(event.payload.changeType).toBe('unlink');
	});

	it('cleanup function clears timers and closes watcher', () => {
		const onEvent = vi.fn();
		const cleanup = createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent,
			triggerName: 'test',
		});

		// Trigger a change to create a pending timer
		const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
		changeHandler('src/index.ts');

		cleanup();

		// Advance past debounce - event should NOT fire since cleanup was called
		vi.advanceTimersByTime(5000);
		expect(onEvent).not.toHaveBeenCalled();
		expect(mockClose).toHaveBeenCalled();
	});

	it('handles watcher errors gracefully with console.error fallback', () => {
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent: vi.fn(),
			triggerName: 'test',
		});

		const errorHandler = mockOn.mock.calls.find((call) => call[0] === 'error')?.[1];
		expect(errorHandler).toBeDefined();

		// Should not throw
		errorHandler(new Error('Watch error'));
		expect(consoleSpy).toHaveBeenCalled();

		consoleSpy.mockRestore();
	});

	it('routes errors through onLog when provided', () => {
		const onLog = vi.fn();
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		createCueFileWatcher({
			watchGlob: '**/*.ts',
			projectRoot: '/test',
			debounceMs: 5000,
			onEvent: vi.fn(),
			triggerName: 'my-watcher',
			onLog,
		});

		const errorHandler = mockOn.mock.calls.find((call) => call[0] === 'error')?.[1];
		expect(errorHandler).toBeDefined();

		errorHandler(new Error('Watch error'));

		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('my-watcher'));
		expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('Watch error'));
		expect(consoleSpy).not.toHaveBeenCalled();

		consoleSpy.mockRestore();
	});

	// PR-B 1.4: visibility-aware pause
	describe('isActive gate', () => {
		it('drops the debounced event when isActive returns false', () => {
			const onEvent = vi.fn();
			let active = false;

			createCueFileWatcher({
				watchGlob: '**/*.ts',
				projectRoot: '/test',
				debounceMs: 5000,
				onEvent,
				triggerName: 'test',
				isActive: () => active,
			});

			const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
			changeHandler('src/index.ts');
			vi.advanceTimersByTime(5000);

			expect(onEvent).not.toHaveBeenCalled();
		});

		it('dispatches the next event after isActive flips to true', () => {
			const onEvent = vi.fn();
			let active = false;

			createCueFileWatcher({
				watchGlob: '**/*.ts',
				projectRoot: '/test',
				debounceMs: 5000,
				onEvent,
				triggerName: 'test',
				isActive: () => active,
			});

			const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
			changeHandler('src/inactive.ts');
			vi.advanceTimersByTime(5000);
			expect(onEvent).not.toHaveBeenCalled();

			active = true;
			changeHandler('src/active.ts');
			vi.advanceTimersByTime(5000);
			expect(onEvent).toHaveBeenCalledTimes(1);
		});

		it('still subscribes to chokidar even when isActive is false (no setup teardown)', () => {
			createCueFileWatcher({
				watchGlob: '**/*.ts',
				projectRoot: '/test',
				debounceMs: 5000,
				onEvent: vi.fn(),
				triggerName: 'test',
				isActive: () => false,
			});

			const registeredEvents = mockOn.mock.calls.map((call) => call[0]);
			expect(registeredEvents).toContain('change');
			expect(registeredEvents).toContain('add');
			expect(registeredEvents).toContain('unlink');
		});

		it('defaults to always-active when isActive is omitted', () => {
			const onEvent = vi.fn();
			createCueFileWatcher({
				watchGlob: '**/*.ts',
				projectRoot: '/test',
				debounceMs: 5000,
				onEvent,
				triggerName: 'test',
			});

			const changeHandler = mockOn.mock.calls.find((call) => call[0] === 'change')?.[1];
			changeHandler('src/index.ts');
			vi.advanceTimersByTime(5000);

			expect(onEvent).toHaveBeenCalledTimes(1);
		});
	});

	describe('OS file-watch limit fallback', () => {
		const limitError = (code: string) => Object.assign(new Error(`${code}: watch`), { code });
		// The latest registered handler for an event, i.e. the live watcher's.
		const latestHandler = (event: string) =>
			[...mockOn.mock.calls].reverse().find((call) => call[0] === event)?.[1];

		it.each(['EMFILE', 'ENOSPC'])(
			'restarts in polling mode when the OS refuses a native watch (%s)',
			(code) => {
				const onLog = vi.fn();
				const onEvent = vi.fn();
				createCueFileWatcher({
					watchGlob: '.maestro/slack-monitor/events/*.json',
					projectRoot: '/config/agent',
					debounceMs: 100,
					onEvent,
					triggerName: 'inbox-reply',
					onLog,
				});

				latestHandler('error')(limitError(code));

				expect(mockClose).toHaveBeenCalledTimes(1);
				expect(chokidar.watch).toHaveBeenCalledTimes(2);
				expect(chokidar.watch).toHaveBeenLastCalledWith('.maestro/slack-monitor/events/*.json', {
					cwd: '/config/agent',
					ignoreInitial: true,
					persistent: true,
					usePolling: true,
					interval: CUE_POLLING_FALLBACK_INTERVAL_MS,
					binaryInterval: CUE_POLLING_FALLBACK_INTERVAL_MS,
				});
				expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining(`${code}`));
				expect(onLog).toHaveBeenCalledWith(
					'warn',
					expect.stringContaining('fs.inotify.max_user_instances')
				);

				// The polling watcher delivers events like the native one.
				latestHandler('add')('.maestro/slack-monitor/events/evt_1.json');
				vi.advanceTimersByTime(100);
				expect(onEvent).toHaveBeenCalledTimes(1);
				// The watcher resolves with path.resolve, which adds a drive on Windows.
				expect((onEvent.mock.calls[0][0] as CueEvent).payload.path).toBe(
					path.resolve('/config/agent', '.maestro/slack-monitor/events/evt_1.json')
				);
			}
		);

		it('falls back only once; a later error while polling is logged, not retried', () => {
			const onLog = vi.fn();
			createCueFileWatcher({
				watchGlob: '*.json',
				projectRoot: '/test',
				debounceMs: 100,
				onEvent: vi.fn(),
				triggerName: 'once',
				onLog,
			});

			latestHandler('error')(limitError('EMFILE'));
			latestHandler('error')(limitError('EMFILE'));

			expect(chokidar.watch).toHaveBeenCalledTimes(2);
			expect(onLog).toHaveBeenLastCalledWith(
				'error',
				expect.stringContaining('File watcher error for "once"')
			);
		});

		it('does not restart on other watcher errors', () => {
			const onLog = vi.fn();
			createCueFileWatcher({
				watchGlob: '*.json',
				projectRoot: '/test',
				debounceMs: 100,
				onEvent: vi.fn(),
				triggerName: 'other',
				onLog,
			});

			latestHandler('error')(limitError('EACCES'));

			expect(chokidar.watch).toHaveBeenCalledTimes(1);
			expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('EACCES'));
		});

		it('does not restart after cleanup, and cleanup closes the polling watcher', () => {
			const cleanup = createCueFileWatcher({
				watchGlob: '*.json',
				projectRoot: '/test',
				debounceMs: 100,
				onEvent: vi.fn(),
				triggerName: 'closed',
				onLog: vi.fn(),
			});
			const nativeError = latestHandler('error');

			cleanup();
			nativeError(limitError('EMFILE'));

			expect(chokidar.watch).toHaveBeenCalledTimes(1);
		});
	});
});
