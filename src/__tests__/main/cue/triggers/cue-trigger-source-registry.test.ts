/**
 * Tests for the trigger source factory.
 *
 * Verifies that every Cue event type maps to the correct source implementation
 * (and that the non-source types `app.startup` / `agent.completed` correctly
 * return null since they are handled directly by the runtime).
 */

import { describe, it, expect, vi } from 'vitest';
import { createTriggerSource } from '../../../../main/cue/triggers/cue-trigger-source-registry';
import { createCueSessionRegistry } from '../../../../main/cue/cue-session-registry';
import type { CueEventType, CueSubscription } from '../../../../main/cue/cue-types';
import type { CueTriggerSourceContext } from '../../../../main/cue/triggers/cue-trigger-source';

// Mock the underlying provider modules so the factory tests don't actually
// touch chokidar / gh / fs. We only care that the factory selects the right
// shape — the providers themselves are tested elsewhere.
vi.mock('../../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: vi.fn(() => vi.fn()),
}));
vi.mock('../../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: vi.fn(() => vi.fn()),
}));
vi.mock('../../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: vi.fn(() => vi.fn()),
}));

function makeCtx(sub: CueSubscription): CueTriggerSourceContext {
	return {
		session: {
			id: 'session-1',
			name: 'Test',
			toolType: 'claude-code',
			cwd: '/p',
			projectRoot: '/p',
		},
		subscription: sub,
		registry: createCueSessionRegistry(),
		enabled: () => true,
		onLog: vi.fn(),
		emit: vi.fn(),
	};
}

function baseSub(event: CueEventType, extra: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'sub-1',
		event,
		enabled: true,
		prompt: 'do work',
		...extra,
	};
}

describe('createTriggerSource', () => {
	it('returns a source for time.heartbeat with interval_minutes', () => {
		const source = createTriggerSource(
			'time.heartbeat',
			makeCtx(baseSub('time.heartbeat', { interval_minutes: 5 }))
		);
		expect(source).not.toBeNull();
		expect(typeof source!.start).toBe('function');
		expect(typeof source!.stop).toBe('function');
		expect(typeof source!.nextTriggerAt).toBe('function');
	});

	it('returns null for time.heartbeat missing interval_minutes', () => {
		const source = createTriggerSource('time.heartbeat', makeCtx(baseSub('time.heartbeat')));
		expect(source).toBeNull();
	});

	it('returns a source for time.scheduled with schedule_times', () => {
		const source = createTriggerSource(
			'time.scheduled',
			makeCtx(baseSub('time.scheduled', { schedule_times: ['09:00'] }))
		);
		expect(source).not.toBeNull();
	});

	it('returns null for time.scheduled missing schedule_times', () => {
		const source = createTriggerSource('time.scheduled', makeCtx(baseSub('time.scheduled')));
		expect(source).toBeNull();
	});

	it('returns a source for file.changed with watch glob', () => {
		const source = createTriggerSource(
			'file.changed',
			makeCtx(baseSub('file.changed', { watch: '**/*.ts' }))
		);
		expect(source).not.toBeNull();
	});

	it('returns null for file.changed missing watch', () => {
		const source = createTriggerSource('file.changed', makeCtx(baseSub('file.changed')));
		expect(source).toBeNull();
	});

	it('returns a source for task.pending with watch glob', () => {
		const source = createTriggerSource(
			'task.pending',
			makeCtx(baseSub('task.pending', { watch: '**/*.md' }))
		);
		expect(source).not.toBeNull();
	});

	it('returns null for task.pending missing watch', () => {
		const source = createTriggerSource('task.pending', makeCtx(baseSub('task.pending')));
		expect(source).toBeNull();
	});

	it('returns a source for github.pull_request', () => {
		const source = createTriggerSource(
			'github.pull_request',
			makeCtx(baseSub('github.pull_request', { repo: 'foo/bar' }))
		);
		expect(source).not.toBeNull();
	});

	it('returns a source for github.issue', () => {
		const source = createTriggerSource(
			'github.issue',
			makeCtx(baseSub('github.issue', { repo: 'foo/bar' }))
		);
		expect(source).not.toBeNull();
	});

	it('returns null for app.startup (handled by the runtime, not a trigger source)', () => {
		const source = createTriggerSource('app.startup', makeCtx(baseSub('app.startup')));
		expect(source).toBeNull();
	});

	it('returns null for agent.completed (handled by the completion service)', () => {
		const source = createTriggerSource('agent.completed', makeCtx(baseSub('agent.completed')));
		expect(source).toBeNull();
	});
});
