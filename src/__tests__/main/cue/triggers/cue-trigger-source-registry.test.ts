/**
 * Tests for the trigger source factory.
 *
 * Verifies that every Cue event type maps to the correct source implementation
 * (and that the non-source types `app.startup` / `agent.completed` correctly
 * return null since they are handled directly by the runtime).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { createCueFileWatcher } from '../../../../main/cue/cue-file-watcher';
import { createCueTaskScanner } from '../../../../main/cue/cue-task-scanner';
import { createCueGitHubPoller } from '../../../../main/cue/cue-github-poller';

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

// ─── table data ──────────────────────────────────────────────────────────────

type FactoryKey = 'file' | 'task' | 'github' | null;

const POSITIVE_CASES: Array<{
	event: CueEventType;
	overrides: Partial<CueSubscription>;
	factoryKey: FactoryKey;
}> = [
	{ event: 'time.heartbeat', overrides: { interval_minutes: 5 }, factoryKey: null },
	{ event: 'time.scheduled', overrides: { schedule_times: ['09:00'] }, factoryKey: null },
	{ event: 'file.changed', overrides: { watch: '**/*.ts' }, factoryKey: 'file' },
	{ event: 'task.pending', overrides: { watch: '**/*.md' }, factoryKey: 'task' },
	{ event: 'github.pull_request', overrides: { repo: 'foo/bar' }, factoryKey: 'github' },
	{ event: 'github.issue', overrides: { repo: 'foo/bar' }, factoryKey: 'github' },
];

const NULL_CASES: Array<{
	event: CueEventType;
	overrides: Partial<CueSubscription>;
	reason: string;
}> = [
	{ event: 'time.heartbeat', overrides: {}, reason: 'missing interval_minutes' },
	{ event: 'time.scheduled', overrides: {}, reason: 'missing schedule_times' },
	{ event: 'file.changed', overrides: {}, reason: 'missing watch' },
	{ event: 'task.pending', overrides: {}, reason: 'missing watch' },
	{ event: 'github.pull_request', overrides: {}, reason: 'missing repo' },
	{ event: 'github.issue', overrides: {}, reason: 'missing repo' },
	{ event: 'app.startup', overrides: {}, reason: 'handled by the runtime' },
	{ event: 'agent.completed', overrides: {}, reason: 'handled by the completion service' },
];

// ─── tests ───────────────────────────────────────────────────────────────────

describe('createTriggerSource', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('positive cases — non-null source with correct shape and provider factory invoked', () => {
		it.each(POSITIVE_CASES)('$event', ({ event, overrides, factoryKey }) => {
			const source = createTriggerSource(event, makeCtx(baseSub(event, overrides)));

			expect(source).not.toBeNull();
			expect(typeof source!.start).toBe('function');
			expect(typeof source!.stop).toBe('function');
			expect(typeof source!.nextTriggerAt).toBe('function');

			// Start the source so provider factory calls are triggered, then verify
			// the correct branch was taken for event types backed by a mocked provider.
			source!.start();

			const factoryMocks: Record<NonNullable<FactoryKey>, ReturnType<typeof vi.fn>> = {
				file: vi.mocked(createCueFileWatcher),
				task: vi.mocked(createCueTaskScanner),
				github: vi.mocked(createCueGitHubPoller),
			};
			if (factoryKey !== null) {
				expect(factoryMocks[factoryKey]).toHaveBeenCalledOnce();
			}

			source!.stop();
		});
	});

	describe('negative cases — null for missing required fields or runtime-handled types', () => {
		it.each(NULL_CASES)('$event ($reason)', ({ event, overrides }) => {
			const source = createTriggerSource(event, makeCtx(baseSub(event, overrides)));
			expect(source).toBeNull();
		});
	});
});
