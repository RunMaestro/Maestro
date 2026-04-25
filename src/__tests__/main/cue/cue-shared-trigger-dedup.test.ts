/**
 * Tests for shared-trigger ownership deduplication (#867).
 *
 * When multiple sessions share the same projectRoot, unowned subscriptions
 * (no agent_id) must only register ONE trigger source — for the first session
 * to initialize. Without this, each session creates its own trigger source and
 * the trigger fires N times per tick.
 *
 * These tests operate at two levels:
 * 1. Registry unit tests — claimSharedTriggerOwner / getSharedTriggerOwner /
 *    releaseSharedTriggersForSession
 * 2. Runtime service integration — verifying that only one trigger source is
 *    created when two sessions share a root and an unowned sub
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createCueSessionRegistry,
	type CueSessionRegistry,
} from '../../../main/cue/cue-session-registry';

// ─── Mock the YAML loader ─────────────────────────────────────────────────────

import type { CueConfig, CueSubscription } from '../../../main/cue/cue-types';

const mockLoadCueConfigDetailed =
	vi.fn<
		(
			root: string
		) => { ok: true; config: CueConfig; warnings: string[] } | { ok: false; reason: 'missing' }
	>();
const mockWatchCueYaml = vi.fn<(root: string, cb: () => void) => () => void>();

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (root: string) => {
		const result = mockLoadCueConfigDetailed(root);
		return result.ok ? result.config : null;
	},
	loadCueConfigDetailed: (root: string) => mockLoadCueConfigDetailed(root),
	watchCueYaml: (root: string, cb: () => void) => mockWatchCueYaml(root, cb),
	findAncestorCueConfigRoot: () => null,
}));

// ─── Mock trigger source factory ─────────────────────────────────────────────

const mockCreateTriggerSource = vi.fn();
vi.mock('../../../main/cue/triggers/cue-trigger-source-registry', () => ({
	createTriggerSource: (...args: unknown[]) => mockCreateTriggerSource(...args),
}));

// ─── Mock cue-db ─────────────────────────────────────────────────────────────

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	pruneCueEvents: vi.fn(),
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
	clearGitHubSeenForSubscription: vi.fn(),
}));

vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `uuid-${Math.random().toString(36).slice(2, 8)}`),
}));

import {
	createCueSessionRuntimeService,
	type CueSessionRuntimeServiceDeps,
} from '../../../main/cue/cue-session-runtime-service';
import type { SessionInfo } from '../../../shared/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SHARED_ROOT = '/shared/project';

function makeSession(id: string, name = `S-${id}`, root = SHARED_ROOT): SessionInfo {
	return { id, name, toolType: 'claude-code', cwd: root, projectRoot: root };
}

function makeConfig(subs: CueSubscription[] = []): CueConfig {
	return {
		subscriptions: subs,
		settings: { timeout_minutes: 30, timeout_on_fail: 'break', max_concurrent: 1, queue_size: 10 },
	};
}

function makeUnownedSub(name = 'shared-sub'): CueSubscription {
	return { name, event: 'time.heartbeat', enabled: true, prompt: 'go', interval_minutes: 60 };
}

function makeOwnedSub(agentId: string, name = 'owned-sub'): CueSubscription {
	return {
		name,
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'go',
		interval_minutes: 60,
		agent_id: agentId,
	};
}

function makeFakeTriggerSource() {
	return { start: vi.fn(), stop: vi.fn(), nextTriggerAt: vi.fn(() => null) };
}

function makeRuntimeDeps(
	registry: CueSessionRegistry,
	overrides: Partial<CueSessionRuntimeServiceDeps> = {}
): CueSessionRuntimeServiceDeps {
	return {
		enabled: () => true,
		getSessions: vi.fn(() => []),
		onRefreshRequested: vi.fn(),
		onLog: vi.fn(),
		registry,
		dispatchSubscription: vi.fn(() => 0),
		clearQueue: vi.fn(),
		clearFanInState: vi.fn(),
		...overrides,
	};
}

// ─── Registry unit tests ──────────────────────────────────────────────────────

describe('CueSessionRegistry — shared trigger ownership', () => {
	let registry: CueSessionRegistry;

	beforeEach(() => {
		registry = createCueSessionRegistry();
	});

	it('claimSharedTriggerOwner grants ownership to the first caller', () => {
		const claimed = registry.claimSharedTriggerOwner('/proj', 'sub1', 'session-A');
		expect(claimed).toBe(true);
		expect(registry.getSharedTriggerOwner('/proj', 'sub1')).toBe('session-A');
	});

	it('claimSharedTriggerOwner rejects a different session for the same key', () => {
		registry.claimSharedTriggerOwner('/proj', 'sub1', 'session-A');
		const rejected = registry.claimSharedTriggerOwner('/proj', 'sub1', 'session-B');
		expect(rejected).toBe(false);
		expect(registry.getSharedTriggerOwner('/proj', 'sub1')).toBe('session-A');
	});

	it('claimSharedTriggerOwner is idempotent for the same session', () => {
		registry.claimSharedTriggerOwner('/proj', 'sub1', 'session-A');
		const reclaim = registry.claimSharedTriggerOwner('/proj', 'sub1', 'session-A');
		expect(reclaim).toBe(true);
	});

	it('getSharedTriggerOwner returns null when unclaimed', () => {
		expect(registry.getSharedTriggerOwner('/proj', 'sub1')).toBeNull();
	});

	it("releaseSharedTriggersForSession removes only that session's claims", () => {
		registry.claimSharedTriggerOwner('/proj', 'sub1', 'session-A');
		registry.claimSharedTriggerOwner('/proj', 'sub2', 'session-B');

		registry.releaseSharedTriggersForSession('session-A');

		expect(registry.getSharedTriggerOwner('/proj', 'sub1')).toBeNull();
		expect(registry.getSharedTriggerOwner('/proj', 'sub2')).toBe('session-B');
	});

	it('clear() wipes all shared trigger owners', () => {
		registry.claimSharedTriggerOwner('/proj', 'sub1', 'session-A');
		registry.clear();
		expect(registry.getSharedTriggerOwner('/proj', 'sub1')).toBeNull();
	});

	it('different projectRoots do not interfere with each other', () => {
		registry.claimSharedTriggerOwner('/proj-A', 'sub1', 'session-A');
		const claimed = registry.claimSharedTriggerOwner('/proj-B', 'sub1', 'session-B');
		expect(claimed).toBe(true);
		expect(registry.getSharedTriggerOwner('/proj-A', 'sub1')).toBe('session-A');
		expect(registry.getSharedTriggerOwner('/proj-B', 'sub1')).toBe('session-B');
	});
});

// ─── Runtime service integration tests ───────────────────────────────────────

describe('CueSessionRuntimeService — shared-root trigger deduplication', () => {
	let registry: CueSessionRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		registry = createCueSessionRegistry();
		mockWatchCueYaml.mockReturnValue(vi.fn());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('only first session at shared root creates trigger source for unowned sub', () => {
		const config = makeConfig([makeUnownedSub('shared-sub')]);
		mockLoadCueConfigDetailed.mockReturnValue({ ok: true, config, warnings: [] });
		mockCreateTriggerSource.mockImplementation(() => makeFakeTriggerSource());

		const svc = createCueSessionRuntimeService(makeRuntimeDeps(registry));

		svc.initSession(makeSession('s1'), { reason: 'discovery' });
		svc.initSession(makeSession('s2'), { reason: 'discovery' });

		// createTriggerSource called once (only for s1)
		expect(mockCreateTriggerSource).toHaveBeenCalledTimes(1);
	});

	it('second session skips unowned sub; owned subs are unaffected', () => {
		const config = makeConfig([
			makeUnownedSub('shared-sub'),
			makeOwnedSub('s1', 'owned-by-s1'),
			makeOwnedSub('s2', 'owned-by-s2'),
		]);
		mockLoadCueConfigDetailed.mockReturnValue({ ok: true, config, warnings: [] });
		mockCreateTriggerSource.mockImplementation(() => makeFakeTriggerSource());

		const svc = createCueSessionRuntimeService(makeRuntimeDeps(registry));

		svc.initSession(makeSession('s1'), { reason: 'discovery' });
		svc.initSession(makeSession('s2'), { reason: 'discovery' });

		// s1: shared-sub (unowned, claimed) + owned-by-s1 = 2
		// s2: shared-sub (unowned, rejected) + owned-by-s2 = 1
		// Total: 3
		expect(mockCreateTriggerSource).toHaveBeenCalledTimes(3);
	});

	it('sessions at different projectRoots each get their own trigger source', () => {
		const config = makeConfig([makeUnownedSub('sub')]);
		mockLoadCueConfigDetailed.mockReturnValue({ ok: true, config, warnings: [] });
		mockCreateTriggerSource.mockImplementation(() => makeFakeTriggerSource());

		const svc = createCueSessionRuntimeService(makeRuntimeDeps(registry));

		svc.initSession(makeSession('s1', 'S1', '/proj-A'), { reason: 'discovery' });
		svc.initSession(makeSession('s2', 'S2', '/proj-B'), { reason: 'discovery' });

		// Both get sources — different roots don't share ownership
		expect(mockCreateTriggerSource).toHaveBeenCalledTimes(2);
	});

	it('after owning session is torn down, sibling session can claim on re-init', () => {
		const config = makeConfig([makeUnownedSub('shared-sub')]);
		mockLoadCueConfigDetailed.mockReturnValue({ ok: true, config, warnings: [] });

		const fakeSource = makeFakeTriggerSource();
		mockCreateTriggerSource.mockImplementation(() => fakeSource);

		const svc = createCueSessionRuntimeService(makeRuntimeDeps(registry));

		// s1 initializes and claims ownership
		svc.initSession(makeSession('s1'), { reason: 'discovery' });
		expect(mockCreateTriggerSource).toHaveBeenCalledTimes(1);

		// s2 initializes but is blocked by s1's ownership
		svc.initSession(makeSession('s2'), { reason: 'discovery' });
		expect(mockCreateTriggerSource).toHaveBeenCalledTimes(1); // still 1

		// s1 is removed — releases claim
		svc.removeSession('s1');
		expect(registry.getSharedTriggerOwner(SHARED_ROOT, 'shared-sub')).toBeNull();

		// s2 re-initializes and can now claim
		mockCreateTriggerSource.mockClear();
		svc.initSession(makeSession('s2'), { reason: 'refresh' });
		expect(mockCreateTriggerSource).toHaveBeenCalledTimes(1);
		expect(registry.getSharedTriggerOwner(SHARED_ROOT, 'shared-sub')).toBe('s2');
	});

	it('owned sub is never subject to shared-trigger dedup even at shared root', () => {
		const config = makeConfig([makeOwnedSub('s1', 'owned-sub')]);
		mockLoadCueConfigDetailed.mockReturnValue({ ok: true, config, warnings: [] });
		mockCreateTriggerSource.mockImplementation(() => makeFakeTriggerSource());

		const svc = createCueSessionRuntimeService(makeRuntimeDeps(registry));

		svc.initSession(makeSession('s1'), { reason: 'discovery' });
		svc.initSession(makeSession('s2'), { reason: 'discovery' });

		// s2 is skipped entirely (agent_id filter), not the shared-trigger filter
		// s1 gets one source for its owned sub
		expect(mockCreateTriggerSource).toHaveBeenCalledTimes(1);
	});
});
