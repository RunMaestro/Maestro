/**
 * Tests for CueQueryService.
 *
 * Key contract: both getStatus() and getGraphData() must surface dormant
 * sessions (those with a cue config on disk but not yet engine-initialized)
 * regardless of whether the engine is currently enabled. The previous
 * `if (!deps.enabled())` guard meant dormant agents were invisible whenever
 * the engine was running.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	createCueQueryService,
	type CueQueryServiceDeps,
} from '../../../main/cue/cue-query-service';
import {
	DEFAULT_CUE_SETTINGS,
	type CueConfig,
	type CueSettings,
	type CueSubscription,
} from '../../../main/cue/cue-types';
import type { SessionState } from '../../../main/cue/cue-session-state';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(
	subscriptions: CueSubscription[] = [],
	settingsOverrides: Partial<CueSettings> = {}
): CueConfig {
	return {
		subscriptions,
		settings: { ...DEFAULT_CUE_SETTINGS, ...settingsOverrides },
	};
}

function makeState(config?: CueConfig): SessionState {
	return {
		config: config ?? makeConfig(),
		triggerSources: [],
		yamlWatcher: null,
		sleepPrevented: false,
	};
}

function makeSession(id: string, name = `Session-${id}`, projectRoot = `/proj/${id}`) {
	return { id, name, toolType: 'claude-code', projectRoot };
}

function makeDeps(overrides: Partial<CueQueryServiceDeps> = {}): CueQueryServiceDeps {
	return {
		getAllSessions: vi.fn(() => []),
		getSessionStates: vi.fn(() => new Map()),
		getActiveRunCount: vi.fn(() => 0),
		loadConfigForProjectRoot: vi.fn(() => null),
		...overrides,
	};
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
	it('returns active session with enabled:true when in registry', () => {
		const session = makeSession('s1');
		const state = makeState(
			makeConfig([
				{ name: 'sub1', event: 'time.heartbeat', enabled: true, prompt: 'p', interval_minutes: 60 },
			])
		);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map([['s1', state]]),
			getActiveRunCount: () => 2,
		});
		const svc = createCueQueryService(deps);
		const result = svc.getStatus();

		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('s1');
		expect(result[0].enabled).toBe(true);
		expect(result[0].activeRuns).toBe(2);
		expect(result[0].subscriptionCount).toBe(1);
	});

	it('returns dormant session with enabled:false when engine is running but session not in registry', () => {
		const session = makeSession('s1');
		const config = makeConfig([
			{ name: 'sub1', event: 'time.heartbeat', enabled: true, prompt: 'p', interval_minutes: 30 },
		]);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(), // engine running but s1 not initialized
			loadConfigForProjectRoot: () => config,
		});
		const svc = createCueQueryService(deps);
		const result = svc.getStatus();

		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('s1');
		expect(result[0].enabled).toBe(false);
		expect(result[0].activeRuns).toBe(0);
		expect(result[0].subscriptionCount).toBe(1);
	});

	it('dormant subscriptionCount excludes disabled subscriptions', () => {
		const session = makeSession('s1');
		const config = makeConfig([
			{
				name: 'active-sub',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'p',
				interval_minutes: 30,
			},
			{
				name: 'disabled-sub',
				event: 'time.heartbeat',
				enabled: false,
				prompt: 'p',
				interval_minutes: 60,
			},
		]);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => config,
		});
		const result = createCueQueryService(deps).getStatus();

		expect(result[0].subscriptionCount).toBe(1);
	});

	it('does not double-report a session that is both in registry and allSessions', () => {
		const session = makeSession('s1');
		const state = makeState();
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map([['s1', state]]),
			loadConfigForProjectRoot: () => makeConfig(),
		});
		const svc = createCueQueryService(deps);
		const result = svc.getStatus();

		expect(result).toHaveLength(1);
	});

	it('excludes dormant sessions with no cue config', () => {
		const session = makeSession('s1');
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => null,
		});
		const svc = createCueQueryService(deps);
		expect(svc.getStatus()).toHaveLength(0);
	});

	it('reports both active and dormant sessions simultaneously', () => {
		const active = makeSession('a1');
		const dormant = makeSession('d1');
		const state = makeState();
		const deps = makeDeps({
			getAllSessions: () => [active, dormant],
			getSessionStates: () => new Map([['a1', state]]),
			loadConfigForProjectRoot: (root) => (root === dormant.projectRoot ? makeConfig() : null),
		});
		const svc = createCueQueryService(deps);
		const result = svc.getStatus();

		expect(result).toHaveLength(2);
		expect(result.find((r) => r.sessionId === 'a1')?.enabled).toBe(true);
		expect(result.find((r) => r.sessionId === 'd1')?.enabled).toBe(false);
	});
});

// ─── getGraphData ─────────────────────────────────────────────────────────────

describe('getGraphData', () => {
	it('returns dormant session subscriptions when engine is running but session not initialized', () => {
		const session = makeSession('s1', 'Agent1');
		const sub: CueSubscription = {
			name: 'heartbeat',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'go',
			interval_minutes: 60,
		};
		const config = makeConfig([sub]);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => config,
		});
		const svc = createCueQueryService(deps);
		const result = svc.getGraphData();

		expect(result).toHaveLength(1);
		expect(result[0].sessionId).toBe('s1');
		expect(result[0].sessionName).toBe('Agent1');
		expect(result[0].subscriptions).toHaveLength(1);
		expect(result[0].subscriptions[0].name).toBe('heartbeat');
	});

	it('does not double-report a session that is both initialized and in allSessions', () => {
		const session = makeSession('s1');
		const sub: CueSubscription = {
			name: 'sub1',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 60,
		};
		const state = makeState(makeConfig([sub]));
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map([['s1', state]]),
			loadConfigForProjectRoot: () => makeConfig([sub]),
		});
		const svc = createCueQueryService(deps);
		const result = svc.getGraphData();

		expect(result).toHaveLength(1);
	});

	it('excludes dormant sessions with no cue config', () => {
		const session = makeSession('s1');
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => null,
		});
		expect(createCueQueryService(deps).getGraphData()).toHaveLength(0);
	});

	it('filters dormant subscriptions via isSubscriptionParticipant — owned by other agent excluded', () => {
		const session = makeSession('s1', 'A');
		const ownedBySelf: CueSubscription = {
			name: 'mine',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 30,
			agent_id: 's1',
		};
		const ownedByOther: CueSubscription = {
			name: 'theirs',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 30,
			agent_id: 'other-session',
		};
		const config = makeConfig([ownedBySelf, ownedByOther]);
		const deps = makeDeps({
			getAllSessions: () => [session],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => config,
		});
		const result = createCueQueryService(deps).getGraphData();

		expect(result[0].subscriptions).toHaveLength(1);
		expect(result[0].subscriptions[0].name).toBe('mine');
	});

	it('includes fan-out target sessions in dormant graph data', () => {
		const owner = makeSession('owner', 'Owner');
		const target = makeSession('target', 'Target');
		const sub: CueSubscription = {
			name: 'fanout-sub',
			event: 'time.heartbeat',
			enabled: true,
			prompt: 'p',
			interval_minutes: 60,
			agent_id: 'owner',
			fan_out: ['Target'],
		};
		const config = makeConfig([sub]);
		// Neither session is initialized (both dormant)
		const deps = makeDeps({
			getAllSessions: () => [owner, target],
			getSessionStates: () => new Map(),
			loadConfigForProjectRoot: () => config,
		});
		const result = createCueQueryService(deps).getGraphData();

		// Both owner and fan-out target should appear with the sub
		expect(result).toHaveLength(2);
		const targetEntry = result.find((r) => r.sessionId === 'target');
		expect(targetEntry?.subscriptions).toHaveLength(1);
		expect(targetEntry?.subscriptions[0].name).toBe('fanout-sub');
	});
});

// ─── getSettings ─────────────────────────────────────────────────────────────

describe('getSettings', () => {
	it('returns settings from an initialized session', () => {
		const state = makeState(
			makeConfig([], {
				timeout_minutes: 99,
				timeout_on_fail: 'continue',
				max_concurrent: 5,
				queue_size: 20,
			})
		);
		const deps = makeDeps({ getSessionStates: () => new Map([['s1', state]]) });
		const settings = createCueQueryService(deps).getSettings();

		expect(settings.timeout_minutes).toBe(99);
		expect(settings.max_concurrent).toBe(5);
	});

	it('falls back to DEFAULT_CUE_SETTINGS when no sessions are initialized', () => {
		const deps = makeDeps({ getSessionStates: () => new Map() });
		const settings = createCueQueryService(deps).getSettings();

		expect(settings).toEqual(DEFAULT_CUE_SETTINGS);
	});
});
