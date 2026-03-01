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

import { createCueFileWatcher } from '../../../main/cue/cue-file-watcher';
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

		// Advance past debounce — event should NOT fire since cleanup was called
		vi.advanceTimersByTime(5000);
		expect(onEvent).not.toHaveBeenCalled();
		expect(mockClose).toHaveBeenCalled();
	});

	it('handles watcher errors gracefully', () => {
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
});
