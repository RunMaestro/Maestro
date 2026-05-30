/**
 * Tests for the task.pending trigger source wrapper.
 *
 * The underlying createCueTaskScanner is tested in cue-task-scanner.test.ts.
 * These tests verify that the wrapper:
 *  - returns null when `watch` is missing
 *  - calls the underlying provider with the right parameters (incl. poll_minutes)
 *  - routes events through passesFilter before emitting
 *  - releases the cleanup function on stop()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCleanup = vi.fn();
const mockCreateCueTaskScanner = vi.fn(() => mockCleanup);
vi.mock('../../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: (...args: unknown[]) =>
		mockCreateCueTaskScanner(...(args as Parameters<typeof mockCreateCueTaskScanner>)),
}));

import { createCueTaskScannerTriggerSource } from '../../../../main/cue/triggers/cue-task-scanner-trigger-source';
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
		name: 'tasks',
		event: 'task.pending',
		enabled: true,
		prompt: 'do work',
		watch: '**/TODO.md',
		...overrides,
	};
}

function makeEvent(): CueEvent {
	return {
		id: 'evt-1',
		type: 'task.pending',
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'tasks',
		payload: { taskCount: 3, filename: 'TODO.md' },
	};
}

describe('cue-task-scanner-trigger-source', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns null when watch is missing', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession(),
			subscription: makeSub({ watch: undefined }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		});
		expect(source).toBeNull();
		expect(mockCreateCueTaskScanner).not.toHaveBeenCalled();
	});

	it('start() wires up the task scanner with the subscription poll_minutes', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession(),
			subscription: makeSub({ poll_minutes: 5 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();

		expect(mockCreateCueTaskScanner).toHaveBeenCalledOnce();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as {
			watchGlob: string;
			pollMinutes: number;
			projectRoot: string;
			triggerName: string;
		};
		expect(config.watchGlob).toBe('**/TODO.md');
		expect(config.pollMinutes).toBe(5);
		expect(config.projectRoot).toBe('/p');
		expect(config.triggerName).toBe('tasks');

		source.stop();
	});

	it('start() defaults pollMinutes to 1 when subscription does not specify', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as { pollMinutes: number };
		expect(config.pollMinutes).toBe(1);

		source.stop();
	});

	it('emit fires when the underlying scanner reports an event', () => {
		const emit = vi.fn();
		const source = createCueTaskScannerTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent());

		expect(emit).toHaveBeenCalledOnce();

		source.stop();
	});

	it('does not emit when enabled() returns false', () => {
		const emit = vi.fn();
		const source = createCueTaskScannerTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => false,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueTaskScanner.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent());

		expect(emit).not.toHaveBeenCalled();

		source.stop();
	});

	it('stop() releases the underlying scanner cleanup', () => {
		const source = createCueTaskScannerTriggerSource({
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

	it('nextTriggerAt() always returns null', () => {
		const source = createCueTaskScannerTriggerSource({
			session: makeSession(),
			subscription: makeSub(),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		expect(source.nextTriggerAt()).toBeNull();
		source.start();
		expect(source.nextTriggerAt()).toBeNull();
		source.stop();
	});
});
