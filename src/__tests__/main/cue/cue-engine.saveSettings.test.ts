/**
 * Tests for CueEngine.saveSettings() - the path used by Settings → Encore
 * Features → Maestro Cue to persist global settings to every known cue.yaml
 * on disk and refresh in-memory engine state.
 *
 * Covers:
 *  - Dedupe by config root when two sessions share the same projectRoot
 *  - YAML round-trip preserves `subscriptions:` while merging `settings:`
 *  - In-memory mirror so getSettings() returns new values immediately
 *  - writtenRoots is empty when no sessions are registered (UI "no-targets")
 *  - readCueConfigFile returning null is tolerated per-root
 *  - Per-root write errors are isolated (one bad root doesn't block others)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CueConfig } from '../../../main/cue/cue-types';
import * as yaml from 'js-yaml';

// Mock yaml loader so engine.start() can populate the session registry
// without hitting disk. Each test sets the next returned config.
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

// Mock trigger source factories so registry init doesn't try to spawn watchers.
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: vi.fn(() => () => {}),
}));
vi.mock('../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: vi.fn(() => () => {}),
}));
vi.mock('../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: vi.fn(() => () => {}),
}));

// Mock DB so initCueDb is a no-op.
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
}));

// Mock the config repository consumed by Cue session lifecycle setup.
const mockReadCueConfigFile = vi.fn<(root: string) => { filePath: string; raw: string } | null>();
const mockPersistMutationResult = vi.fn<(root: string, content: string) => string>();
vi.mock('../../../main/cue/config/cue-config-repository', () => ({
	readCueConfigFile: (...args: unknown[]) => mockReadCueConfigFile(args[0] as string),
	// resolveCueConfigPath is consumed by cue-session-runtime-service to gate
	// which sessions get a cue.yaml watcher set up. Return a synthetic path so
	// every session passes the gate during engine.start().
	resolveCueConfigPath: (root: string) => `${root}/.maestro/cue.yaml`,
	watchCueConfigFile: vi.fn(() => () => {}),
	writeCuePromptFile: vi.fn(),
	pruneOrphanedPromptFiles: vi.fn(() => []),
	removeEmptyPromptsDir: vi.fn(() => false),
	removeEmptyMaestroDir: vi.fn(() => false),
}));

const mockUpdateGlobalSettings = vi.fn(
	async (
		root: string,
		settings: {
			timeout_minutes: number;
			timeout_on_fail: 'break' | 'continue';
			max_concurrent: number;
			queue_size: number;
		}
	) => {
		const file = mockReadCueConfigFile(root);
		if (!file) return false;
		const parsed = (yaml.load(file.raw) ?? {}) as Record<string, unknown>;
		parsed.settings = { ...(parsed.settings as Record<string, unknown>), ...settings };
		mockPersistMutationResult(root, yaml.dump(parsed));
		return true;
	}
);
vi.mock('../../../main/cue/config/cue-config-mutation-service', () => ({
	createCueConfigMutationService: () => ({
		setSubscriptionEnabled: vi.fn(),
		removeSubscription: vi.fn(),
		updateGlobalSettings: (...args: Parameters<typeof mockUpdateGlobalSettings>) =>
			mockUpdateGlobalSettings(...args),
		delete: vi.fn(),
		replace: vi.fn(),
	}),
}));

// Mock sentry so caught errors don't try to invoke the real exporter.
const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { CueEngine } from '../../../main/cue/cue-engine';
import { createMockSession, createMockConfig, createMockDeps } from './cue-test-helpers';

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadCueConfigDetailed.mockImplementation((projectRoot: string) => {
		const config = mockLoadCueConfig(projectRoot);
		return config ? { ok: true, config, warnings: [] } : { ok: false, reason: 'missing' };
	});
	mockWatchCueYaml.mockReturnValue(() => {});
	mockPersistMutationResult.mockReturnValue('/written');
});

function startEngineWithSessions(
	sessions: Array<{ id: string; projectRoot: string; config: CueConfig | null }>
) {
	const sessionInfos = sessions.map((s) =>
		createMockSession({ id: s.id, projectRoot: s.projectRoot })
	);
	const configByRoot = new Map(sessions.map((s) => [s.projectRoot, s.config]));
	mockLoadCueConfig.mockImplementation((root: string) => configByRoot.get(root) ?? null);
	const deps = createMockDeps({ getSessions: vi.fn(() => sessionInfos) });
	const engine = new CueEngine(deps);
	engine.start();
	return engine;
}

describe('CueEngine.saveSettings', () => {
	it('writes the settings block to every unique config root', async () => {
		const cfg1 = createMockConfig();
		const cfg2 = createMockConfig();
		const engine = startEngineWithSessions([
			{ id: 's1', projectRoot: '/proj1', config: cfg1 },
			{ id: 's2', projectRoot: '/proj2', config: cfg2 },
		]);

		mockReadCueConfigFile.mockImplementation((root: string) => ({
			filePath: `${root}/.maestro/cue.yaml`,
			raw: yaml.dump({
				settings: {
					timeout_minutes: 30,
					timeout_on_fail: 'break',
					max_concurrent: 1,
					queue_size: 10,
				},
				subscriptions: [],
			}),
		}));

		const result = await engine.saveSettings({
			timeout_minutes: 99,
			timeout_on_fail: 'continue',
			max_concurrent: 4,
			queue_size: 256,
		});

		expect(result.writtenRoots).toHaveLength(2);
		expect(result.writtenRoots).toEqual(expect.arrayContaining(['/proj1', '/proj2']));
		expect(mockPersistMutationResult).toHaveBeenCalledTimes(2);
	});

	it('dedupes when two sessions share the same projectRoot', async () => {
		const cfg = createMockConfig();
		const engine = startEngineWithSessions([
			{ id: 's1', projectRoot: '/shared', config: cfg },
			{ id: 's2', projectRoot: '/shared', config: cfg },
		]);

		mockReadCueConfigFile.mockReturnValue({
			filePath: '/shared/.maestro/cue.yaml',
			raw: yaml.dump({ settings: {}, subscriptions: [] }),
		});

		const result = await engine.saveSettings({
			timeout_minutes: 45,
			timeout_on_fail: 'break',
			max_concurrent: 2,
			queue_size: 100,
		});

		expect(result.writtenRoots).toEqual(['/shared']);
		expect(mockPersistMutationResult).toHaveBeenCalledTimes(1);
	});

	it('preserves subscriptions: in the YAML round-trip and only mutates settings:', async () => {
		const cfg = createMockConfig();
		const engine = startEngineWithSessions([{ id: 's1', projectRoot: '/proj', config: cfg }]);

		const existingYaml = yaml.dump({
			settings: {
				timeout_minutes: 30,
				max_concurrent: 1,
				queue_size: 10,
				timeout_on_fail: 'break',
			},
			subscriptions: [
				{ name: 'keep-me', event: 'time.heartbeat', prompt: 'do work', interval_minutes: 10 },
			],
			no_ancestor_fallback: true,
		});
		mockReadCueConfigFile.mockReturnValue({
			filePath: '/proj/.maestro/cue.yaml',
			raw: existingYaml,
		});

		await engine.saveSettings({
			timeout_minutes: 60,
			timeout_on_fail: 'continue',
			max_concurrent: 3,
			queue_size: 99,
		});

		expect(mockPersistMutationResult).toHaveBeenCalledTimes(1);
		const writtenContent = mockPersistMutationResult.mock.calls[0][1];
		const reparsed = yaml.load(writtenContent) as Record<string, unknown>;
		expect(reparsed.settings).toMatchObject({
			timeout_minutes: 60,
			timeout_on_fail: 'continue',
			max_concurrent: 3,
			queue_size: 99,
		});
		expect(reparsed.subscriptions).toEqual([
			expect.objectContaining({ name: 'keep-me', event: 'time.heartbeat' }),
		]);
		expect(reparsed.no_ancestor_fallback).toBe(true);
	});

	it('never propagates owner_agent_id and preserves each root’s existing one', async () => {
		// Regression: owner_agent_id is per-root. Broadcasting an incoming
		// owner_agent_id into every cue.yaml flagged unrelated single-agent
		// projects with a bogus "does not match any agent" warning. saveSettings
		// must strip it from the incoming settings and leave each file's own
		// owner_agent_id untouched via the merge.
		const cfg = createMockConfig();
		const engine = startEngineWithSessions([{ id: 's1', projectRoot: '/proj', config: cfg }]);

		const existingYaml = yaml.dump({
			settings: {
				timeout_minutes: 30,
				max_concurrent: 1,
				queue_size: 10,
				timeout_on_fail: 'break',
				owner_agent_id: 'this-roots-own-owner',
			},
			subscriptions: [
				{ name: 'keep-me', event: 'time.heartbeat', prompt: 'x', interval_minutes: 5 },
			],
		});
		mockReadCueConfigFile.mockReturnValue({
			filePath: '/proj/.maestro/cue.yaml',
			raw: existingYaml,
		});

		await engine.saveSettings({
			timeout_minutes: 60,
			timeout_on_fail: 'continue',
			max_concurrent: 3,
			queue_size: 99,
			// A foreign owner that must NOT be written into this root.
			owner_agent_id: 'some-other-agent-uuid',
		});

		const writtenContent = mockPersistMutationResult.mock.calls[0][1];
		const reparsed = yaml.load(writtenContent) as { settings: Record<string, unknown> };
		// Global fields updated...
		expect(reparsed.settings.timeout_minutes).toBe(60);
		// ...but the root keeps its OWN owner, not the foreign one we passed in.
		expect(reparsed.settings.owner_agent_id).toBe('this-roots-own-owner');
	});

	it('mirrors new settings into in-memory state so getSettings() returns them immediately', async () => {
		const cfg = createMockConfig({
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		});
		const engine = startEngineWithSessions([{ id: 's1', projectRoot: '/proj', config: cfg }]);

		mockReadCueConfigFile.mockReturnValue({
			filePath: '/proj/.maestro/cue.yaml',
			raw: yaml.dump({ settings: {}, subscriptions: [] }),
		});

		await engine.saveSettings({
			timeout_minutes: 77,
			timeout_on_fail: 'continue',
			max_concurrent: 5,
			queue_size: 64,
		});

		expect(engine.getSettings()).toMatchObject({
			timeout_minutes: 77,
			timeout_on_fail: 'continue',
			max_concurrent: 5,
			queue_size: 64,
		});
	});

	it('returns an empty writtenRoots list when no sessions are registered', async () => {
		// Engine constructed but never started → registry empty.
		const deps = createMockDeps({ getSessions: vi.fn(() => []) });
		const engine = new CueEngine(deps);

		const result = await engine.saveSettings({
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		});

		expect(result.writtenRoots).toEqual([]);
		expect(mockReadCueConfigFile).not.toHaveBeenCalled();
		expect(mockPersistMutationResult).not.toHaveBeenCalled();
	});

	it('skips a root when readCueConfigFile returns null (no yaml on disk yet)', async () => {
		const cfg = createMockConfig();
		const engine = startEngineWithSessions([
			{ id: 's1', projectRoot: '/has-yaml', config: cfg },
			{ id: 's2', projectRoot: '/no-yaml', config: cfg },
		]);

		mockReadCueConfigFile.mockImplementation((root: string) => {
			if (root === '/no-yaml') return null;
			return {
				filePath: `${root}/.maestro/cue.yaml`,
				raw: yaml.dump({ settings: {}, subscriptions: [] }),
			};
		});

		const result = await engine.saveSettings({
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		});

		expect(result.writtenRoots).toEqual(['/has-yaml']);
		expect(mockPersistMutationResult).toHaveBeenCalledTimes(1);
		expect(mockPersistMutationResult).toHaveBeenCalledWith('/has-yaml', expect.any(String));
	});

	it('isolates errors per root and reports the failure to sentry', async () => {
		const cfg = createMockConfig();
		const engine = startEngineWithSessions([
			{ id: 's1', projectRoot: '/good', config: cfg },
			{ id: 's2', projectRoot: '/bad', config: cfg },
		]);

		mockReadCueConfigFile.mockImplementation((root: string) => {
			if (root === '/bad') throw new Error('EACCES: permission denied');
			return {
				filePath: `${root}/.maestro/cue.yaml`,
				raw: yaml.dump({ settings: {}, subscriptions: [] }),
			};
		});

		// Reset before exercising saveSettings - captureException may be called
		// during engine.start() bootstrap noise we don't care about here.
		mockCaptureException.mockClear();
		const result = await engine.saveSettings({
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		});

		expect(result.writtenRoots).toEqual(['/good']);
		expect(mockPersistMutationResult).toHaveBeenCalledTimes(1);
		expect(mockCaptureException).toHaveBeenCalledTimes(1);
		const [err, ctx] = mockCaptureException.mock.calls[0];
		expect(err).toBeInstanceOf(Error);
		expect(ctx).toMatchObject({
			operation: 'cue.saveSettings',
			extra: { root: '/bad' },
		});
	});
});
