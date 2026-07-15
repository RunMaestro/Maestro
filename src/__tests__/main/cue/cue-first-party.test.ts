/**
 * Maestro Cue as a managed first-party plugin (encore-lifts L3).
 *
 * Covers:
 * - MAESTRO_CUE_FIRST_PARTY_PLUGIN definition validity: honest permission
 *   list from the engine's ACTUAL surface, no host-owned act verbs, the
 *   `cue.engine` supervised background service.
 * - createCueSupervisorHooks: the firstPartySupervisors.maestroCue hooks
 *   start/stop the engine (reason semantics match the cue:enable IPC path).
 * - Bridge integration: disabling the marketplace tile through the
 *   FirstPartyPluginBridge ACTUALLY halts file watchers / GitHub pollers /
 *   yaml watchers - not just UI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig } from '../../../main/cue/cue-types';

// --- engine collaborator mocks (same seams cue-engine.test.ts isolates) ---

const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
type DetailedResult =
	| { ok: true; config: CueConfig; warnings: string[] }
	| { ok: false; reason: 'missing' }
	| { ok: false; reason: 'parse-error'; message: string }
	| { ok: false; reason: 'invalid'; errors: string[] };
const mockLoadCueConfigDetailed = vi.fn<(projectRoot: string) => DetailedResult>();
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	loadCueConfigDetailed: (...args: unknown[]) => mockLoadCueConfigDetailed(args[0] as string),
	watchCueYaml: (...args: unknown[]) => mockWatchCueYaml(args[0] as string, args[1] as () => void),
}));

const mockCreateCueFileWatcher = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: (...args: unknown[]) => mockCreateCueFileWatcher(args[0]),
}));

const mockCreateCueGitHubPoller = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: (...args: unknown[]) => mockCreateCueGitHubPoller(args[0]),
}));

const mockCreateCueTaskScanner = vi.fn<(config: unknown) => () => void>();
vi.mock('../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: (...args: unknown[]) => mockCreateCueTaskScanner(args[0]),
}));

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	pruneCueEvents: vi.fn(),
	isCueDbReady: () => true,
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
	getLastHeartbeat: vi.fn(() => null),
	updateHeartbeat: vi.fn(),
	getRecentCueEvents: vi.fn(() => []),
	countCueEvents: vi.fn(() => 0),
}));

import { parsePermissions, grantsFromRequests } from '../../../shared/plugins/permissions';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import {
	FIRST_PARTY_PLUGINS,
	MAESTRO_CUE_FIRST_PARTY_PLUGIN,
	MAESTRO_CUE_FIRST_PARTY_PLUGIN_PERMISSIONS,
	type FirstPartyPluginDefinition,
} from '../../../shared/plugins/first-party';
import { FirstPartyPluginBridge } from '../../../main/plugins/first-party-bridge';
import {
	createCueSupervisorHooks,
	type CueEngineLifecycle,
} from '../../../main/cue/cue-first-party';
import { CueEngine } from '../../../main/cue/cue-engine';
import { createMockSession, createMockConfig, createMockDeps } from './cue-test-helpers';

describe('MAESTRO_CUE first-party plugin definition', () => {
	it('declares Maestro Cue as a first-party automation plugin with the supervised cue.engine service', () => {
		expect(MAESTRO_CUE_FIRST_PARTY_PLUGIN).toMatchObject({
			id: 'com.maestro.cue',
			name: 'Maestro Cue',
			firstParty: true,
			category: 'automation',
			settingsNamespace: 'maestroCue',
			encoreFlag: 'maestroCue',
			backgroundServices: [{ id: 'cue.engine', kind: 'supervised' }],
		});
		expect(FIRST_PARTY_PLUGINS.maestroCue).toBe(MAESTRO_CUE_FIRST_PARTY_PLUGIN);
	});

	it('requests exactly the broker capabilities the cue engine surface touches', () => {
		const parsed = parsePermissions(MAESTRO_CUE_FIRST_PARTY_PLUGIN_PERMISSIONS);
		expect(parsed.errors).toEqual([]);
		// Grepped from src/main/cue: chokidar watchers (cue-file-watcher,
		// cue-config-repository), gh CLI polling (cue-github-poller), renderer
		// toasts (cue-notify-bridge, queue overflow, heartbeat failures), wake
		// locks for time-based subs (cue-session-runtime-service →
		// onPreventSleep), the engine's own SQLite store (cue-db), and the
		// supervised engine lifecycle itself.
		expect(parsed.requests.map((p) => p.capability)).toEqual([
			'settings:read',
			'fs:watch',
			'net:fetch',
			'notifications:toast',
			'power:preventSleep',
			'storage:sql',
			'background:service',
		]);
		expect(parsed.requests.every((p) => typeof p.reason === 'string' && p.reason.length > 0)).toBe(
			true
		);
	});

	it('scopes GitHub polling to github.com and leaves fs:watch honestly unscoped', () => {
		const netFetch = MAESTRO_CUE_FIRST_PARTY_PLUGIN_PERMISSIONS.find(
			(p) => p.capability === 'net:fetch'
		);
		expect(netFetch?.scope).toBe('github.com');
		// Watch globs come from per-project cue.yaml files - a static path
		// scope cannot name them, so the request is the (disclosed) broad form.
		const fsWatch = MAESTRO_CUE_FIRST_PARTY_PLUGIN_PERMISSIONS.find(
			(p) => p.capability === 'fs:watch'
		);
		expect(fsWatch?.scope).toBeUndefined();
	});

	it('never declares the host-owned act verbs (agents:dispatch, process:spawn)', () => {
		// Cue dispatches prompts to dynamically-discovered sessions and runs
		// arbitrary user-authored `action: command` lines. FC2 allowlist scopes
		// require exact static targets, so that authority stays host-owned
		// (see the NOTE in first-party.ts).
		const caps = MAESTRO_CUE_FIRST_PARTY_PLUGIN_PERMISSIONS.map((p) => p.capability);
		expect(caps).not.toContain('agents:dispatch');
		expect(caps).not.toContain('process:spawn');
	});
});

interface FakeEngine extends CueEngineLifecycle {
	running: boolean;
}

function makeFakeEngine(running: boolean): FakeEngine {
	const engine: FakeEngine = {
		running,
		isEnabled: vi.fn(() => engine.running),
		start: vi.fn(() => {
			engine.running = true;
		}),
		stop: vi.fn(() => {
			engine.running = false;
		}),
	};
	return engine;
}

describe('createCueSupervisorHooks', () => {
	it('reconcile starts a stopped engine with system-boot (matches the cue:enable IPC reason)', () => {
		const engine = makeFakeEngine(false);
		const hooks = createCueSupervisorHooks(() => engine);

		hooks.reconcile();

		expect(engine.start).toHaveBeenCalledExactlyOnceWith('system-boot');
		expect(engine.running).toBe(true);
	});

	it('reconcile is a no-op when the engine is already running (never restarts live subscriptions)', () => {
		const engine = makeFakeEngine(true);
		const hooks = createCueSupervisorHooks(() => engine);

		hooks.reconcile();

		expect(engine.start).not.toHaveBeenCalled();
		expect(engine.stop).not.toHaveBeenCalled();
	});

	it('stopAll fully stops the engine', () => {
		const engine = makeFakeEngine(true);
		const hooks = createCueSupervisorHooks(() => engine);

		hooks.stopAll();

		expect(engine.stop).toHaveBeenCalledOnce();
		expect(engine.running).toBe(false);
	});

	it('both hooks are safe no-ops when no engine exists (headless boot / teardown)', () => {
		const hooks = createCueSupervisorHooks(() => null);
		expect(() => hooks.reconcile()).not.toThrow();
		expect(() => hooks.stopAll()).not.toThrow();
	});
});

// --- bridge integration: the marketplace toggle drives the REAL engine ---

interface SettingsStoreFake {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
}

function makeSettings(initial: Record<string, boolean> = {}): SettingsStoreFake {
	let encoreFeatures: Record<string, unknown> = { ...initial };
	return {
		get: (key: string) => (key === 'encoreFeatures' ? encoreFeatures : undefined),
		set: (key: string, value: unknown) => {
			if (key === 'encoreFeatures') encoreFeatures = value as Record<string, unknown>;
		},
	};
}

/** In-memory grant ledger (the sealed-ledger seam is pinned in
 *  first-party-bridge.test.ts against the REAL AuthorizationStore). */
function makeGrantLedger(): {
	readGrants: (id: string) => readonly PermissionGrant[];
	mint: (definition: FirstPartyPluginDefinition) => void;
	revoke: (id: string) => void;
} {
	const grants = new Map<string, PermissionGrant[]>();
	return {
		readGrants: (id) => grants.get(id) ?? [],
		mint: (definition) => {
			grants.set(definition.id, grantsFromRequests([...definition.permissions], 1000));
		},
		revoke: (id) => {
			grants.delete(id);
		},
	};
}

describe('marketplace toggle → bridge → cue engine lifecycle', () => {
	let engine: CueEngine;
	let bridge: FirstPartyPluginBridge;
	let settings: SettingsStoreFake;
	let ledger: {
		readGrants: (id: string) => readonly PermissionGrant[];
		mint: (definition: FirstPartyPluginDefinition) => void;
		revoke: (id: string) => void;
	};
	let yamlWatcherCleanup: () => void;
	let fileWatcherCleanup: () => void;
	let gitHubPollerCleanup: () => void;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		yamlWatcherCleanup = vi.fn();
		mockWatchCueYaml.mockReturnValue(yamlWatcherCleanup);
		fileWatcherCleanup = vi.fn();
		mockCreateCueFileWatcher.mockReturnValue(fileWatcherCleanup);
		gitHubPollerCleanup = vi.fn();
		mockCreateCueGitHubPoller.mockReturnValue(gitHubPollerCleanup);
		mockCreateCueTaskScanner.mockReturnValue(vi.fn());

		const config = createMockConfig({
			subscriptions: [
				{
					name: 'watch-src',
					event: 'file.changed',
					enabled: true,
					prompt: 'lint',
					watch: 'src/**/*.ts',
				},
				{
					name: 'watch-prs',
					event: 'github.pull_request',
					enabled: true,
					prompt: 'review',
					repo: 'acme/widgets',
					poll_minutes: 5,
				},
			],
		});
		mockLoadCueConfig.mockReturnValue(config);
		mockLoadCueConfigDetailed.mockImplementation((projectRoot: string) => {
			const loaded = mockLoadCueConfig(projectRoot);
			return loaded ? { ok: true, config: loaded, warnings: [] } : { ok: false, reason: 'missing' };
		});

		engine = new CueEngine(createMockDeps({ getSessions: () => [createMockSession()] }));
		settings = makeSettings();
		ledger = makeGrantLedger();
		bridge = new FirstPartyPluginBridge(MAESTRO_CUE_FIRST_PARTY_PLUGIN, {
			settingsStore: settings,
			readGrants: ledger.readGrants,
			mintFirstPartyGrants: ledger.mint,
			revokeGrants: ledger.revoke,
			supervisor: createCueSupervisorHooks(() => engine),
		});
	});

	afterEach(() => {
		engine.stop();
		vi.useRealTimers();
	});

	it('enable mints the declared grants and starts the engine (watchers + pollers armed)', () => {
		const state = bridge.setEnabled(true);

		expect(state).toEqual({ enabled: true, authorized: true });
		expect(engine.isEnabled()).toBe(true);
		expect(mockCreateCueFileWatcher).toHaveBeenCalledOnce();
		expect(mockCreateCueGitHubPoller).toHaveBeenCalledOnce();
		const encoreFeatures = settings.get('encoreFeatures') as Record<string, unknown>;
		expect(encoreFeatures.maestroCue).toBe(true);
	});

	it('disable ACTUALLY halts watchers, pollers, and yaml watchers - not just UI', () => {
		bridge.setEnabled(true);
		expect(engine.isEnabled()).toBe(true);

		const state = bridge.setEnabled(false);

		expect(state.enabled).toBe(false);
		expect(engine.isEnabled()).toBe(false);
		expect(fileWatcherCleanup).toHaveBeenCalled();
		expect(gitHubPollerCleanup).toHaveBeenCalled();
		expect(yamlWatcherCleanup).toHaveBeenCalled();
		const encoreFeatures = settings.get('encoreFeatures') as Record<string, unknown>;
		expect(encoreFeatures.maestroCue).toBe(false);
	});

	it('revoked grants force the engine off through reconcileBackgroundService (fail closed)', () => {
		bridge.setEnabled(true);
		expect(engine.isEnabled()).toBe(true);

		ledger.revoke(MAESTRO_CUE_FIRST_PARTY_PLUGIN.id);
		const state = bridge.reconcileBackgroundService();

		expect(state).toEqual({ enabled: false, authorized: false });
		expect(engine.isEnabled()).toBe(false);
		expect(fileWatcherCleanup).toHaveBeenCalled();
	});

	it('re-enable after disable arms fresh watchers (round-trip through the same seam)', () => {
		bridge.setEnabled(true);
		bridge.setEnabled(false);
		expect(engine.isEnabled()).toBe(false);

		bridge.setEnabled(true);

		expect(engine.isEnabled()).toBe(true);
		expect(mockCreateCueFileWatcher).toHaveBeenCalledTimes(2);
		expect(mockCreateCueGitHubPoller).toHaveBeenCalledTimes(2);
	});
});
