/**
 * Tests for the file.changed trigger source wrapper.
 *
 * The underlying createCueFileWatcher is tested in cue-file-watcher.test.ts.
 * These tests verify that the wrapper:
 *  - returns null when `watch` is missing
 *  - calls the underlying provider with the correct parameters
 *  - routes events through passesFilter before emitting
 *  - releases the cleanup function on stop()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCleanup = vi.fn();
const mockCreateCueFileWatcher = vi.fn(() => mockCleanup);
vi.mock('../../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) =>
		mockCreateCueFileWatcher(...(args as Parameters<typeof mockCreateCueFileWatcher>)),
}));

import { createCueFileWatcherTriggerSource } from '../../../../main/cue/triggers/cue-file-watcher-trigger-source';
import { createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type { CueEvent, CueSubscription } from '../../../../main/cue/cue-types';
import type { SessionInfo } from '../../../../shared/types';

function makeSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test',
		toolType: 'claude-code',
		cwd: '/p',
		projectRoot: '/p',
	};
}

function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'watch-tasks',
		event: 'file.changed',
		enabled: true,
		prompt: 'do work',
		watch: '**/*.md',
		...overrides,
	};
}

function makeEvent(): CueEvent {
	return {
		id: 'evt-1',
		type: 'file.changed',
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'watch-tasks',
		payload: { path: '/p/notes.md', filename: 'notes.md' },
	};
}

describe('cue-file-watcher-trigger-source', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns null when watch is missing', () => {
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub({ watch: undefined }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		});
		expect(source).toBeNull();
		expect(mockCreateCueFileWatcher).not.toHaveBeenCalled();
	});

	it('start() wires up the underlying file watcher with the right config', () => {
		const onLog = vi.fn();
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub({ watch: '**/*.ts' }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit: vi.fn(),
		})!;

		source.start();

		expect(mockCreateCueFileWatcher).toHaveBeenCalledOnce();
		const config = mockCreateCueFileWatcher.mock.calls[0][0] as {
			watchGlob: string;
			projectRoot: string;
			triggerName: string;
		};
		expect(config.watchGlob).toBe('**/*.ts');
		expect(config.projectRoot).toBe('/p');
		expect(config.triggerName).toBe('watch-tasks');

		source.stop();
	});

	it('emit fires when the underlying watcher reports an event and filter passes', () => {
		const emit = vi.fn();
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();

		// Pull the onEvent callback that the wrapper passed to the provider and
		// invoke it directly — simulates a file change.
		const config = mockCreateCueFileWatcher.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent());

		expect(emit).toHaveBeenCalledOnce();

		source.stop();
	});

	it('does not emit when enabled() returns false', () => {
		const emit = vi.fn();
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => false,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueFileWatcher.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent());

		expect(emit).not.toHaveBeenCalled();

		source.stop();
	});

	it('does not emit when the subscription filter rejects the event', () => {
		const emit = vi.fn();
		const onLog = vi.fn();
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub({ filter: { filename: 'other.md' } }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit,
		})!;

		source.start();
		const config = mockCreateCueFileWatcher.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent());

		expect(emit).not.toHaveBeenCalled();
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));

		source.stop();
	});

	it('stop() releases the underlying watcher cleanup', () => {
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		source.stop();

		expect(mockCleanup).toHaveBeenCalledOnce();
	});

	it('nextTriggerAt() always returns null (file watchers fire on demand)', () => {
		const source = createCueFileWatcherTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		expect(source.nextTriggerAt()).toBeNull();
		source.stop();
	});
});
