/**
 * Tests for the github.{pull_request,issue} trigger source wrapper.
 *
 * The underlying createCueGitHubPoller is tested in cue-github-poller.test.ts.
 * These tests verify that the wrapper:
 *  - returns null for non-GitHub event types
 *  - calls the underlying provider with the right config (event type, repo,
 *    poll_minutes, gh_state, subscriptionId)
 *  - routes events through passesFilter before emitting
 *  - releases the cleanup function on stop()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCleanup = vi.fn();
const mockCreateCueGitHubPoller = vi.fn(() => mockCleanup);
vi.mock('../../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: (...args: unknown[]) =>
		mockCreateCueGitHubPoller(...(args as Parameters<typeof mockCreateCueGitHubPoller>)),
}));

import { createCueGitHubPollerTriggerSource } from '../../../../main/cue/triggers/cue-github-poller-trigger-source';
import { createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type { CueEvent, CueEventType, CueSubscription } from '../../../../main/cue/cue-types';
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

function makeSub(event: CueEventType, overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'gh-poll',
		event,
		enabled: true,
		prompt: 'do work',
		repo: 'foo/bar',
		...overrides,
	};
}

function makeEvent(type: CueEventType): CueEvent {
	return {
		id: 'evt-1',
		type,
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'gh-poll',
		payload: { number: 42, title: 'Test PR', state: 'open' },
	};
}

describe('cue-github-poller-trigger-source', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns null for non-GitHub event types', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession(),
			subscription: makeSub('time.heartbeat', { interval_minutes: 5 }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		});
		expect(source).toBeNull();
		expect(mockCreateCueGitHubPoller).not.toHaveBeenCalled();
	});

	it('start() wires up the GitHub poller for github.pull_request', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession(),
			subscription: makeSub('github.pull_request', {
				poll_minutes: 10,
				gh_state: 'merged',
			}),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();

		expect(mockCreateCueGitHubPoller).toHaveBeenCalledOnce();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as {
			eventType: CueEventType;
			repo?: string;
			pollMinutes: number;
			projectRoot: string;
			triggerName: string;
			subscriptionId: string;
			ghState?: string;
		};
		expect(config.eventType).toBe('github.pull_request');
		expect(config.repo).toBe('foo/bar');
		expect(config.pollMinutes).toBe(10);
		expect(config.ghState).toBe('merged');
		expect(config.subscriptionId).toBe('session-1:gh-poll');

		source.stop();
	});

	it('start() wires up the GitHub poller for github.issue', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession(),
			subscription: makeSub('github.issue'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();

		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as { eventType: CueEventType };
		expect(config.eventType).toBe('github.issue');

		source.stop();
	});

	it('defaults pollMinutes to 5 when not specified', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession(),
			subscription: makeSub('github.pull_request'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit: vi.fn(),
		})!;

		source.start();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as { pollMinutes: number };
		expect(config.pollMinutes).toBe(5);
		source.stop();
	});

	it('emit fires when the underlying poller reports an event', () => {
		const emit = vi.fn();
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession(),
			subscription: makeSub('github.pull_request'),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog: vi.fn(),
			emit,
		})!;

		source.start();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent('github.pull_request'));

		expect(emit).toHaveBeenCalledOnce();

		source.stop();
	});

	it('honours the subscription filter', () => {
		const emit = vi.fn();
		const onLog = vi.fn();
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession(),
			subscription: makeSub('github.pull_request', { filter: { number: 99 } }),
			registry: createCueSessionRegistry(),
			enabled: () => true,
			onLog,
			emit,
		})!;

		source.start();
		const config = mockCreateCueGitHubPoller.mock.calls[0][0] as {
			onEvent: (event: CueEvent) => void;
		};
		config.onEvent(makeEvent('github.pull_request')); // payload has number: 42, not 99

		expect(emit).not.toHaveBeenCalled();
		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('filter not matched'));

		source.stop();
	});

	it('stop() releases the underlying poller cleanup', () => {
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession(),
			subscription: makeSub('github.pull_request'),
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
		const source = createCueGitHubPollerTriggerSource({
			session: makeSession(),
			subscription: makeSub('github.pull_request'),
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
