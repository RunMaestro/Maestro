import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CueSessionRuntimeServiceDeps } from '../../../main/cue/cue-session-runtime-service';
import { createCueSessionRuntimeService } from '../../../main/cue/cue-session-runtime-service';
import { createCueSessionRegistry } from '../../../main/cue/cue-session-registry';
import { loadCueConfigDetailed, watchCueYaml } from '../../../main/cue/cue-yaml-loader';
import { resolveCueConfigPath } from '../../../main/cue/config/cue-config-repository';
import { createMockConfig, createMockSession } from './cue-test-helpers';

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfigDetailed: vi.fn(),
	watchCueYaml: vi.fn(() => vi.fn()),
}));
vi.mock('../../../main/cue/config/cue-config-repository', () => ({
	resolveCueConfigPath: vi.fn(),
}));
vi.mock('../../../main/cue/cue-db', () => ({
	clearGitHubSeenForSubscription: vi.fn(),
}));
vi.mock('../../../main/cue/triggers/cue-trigger-source-registry', () => ({
	createTriggerSource: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), nextTriggerAt: () => null })),
}));

function createRuntime() {
	const session = createMockSession();
	const registry = createCueSessionRegistry();
	const deps: CueSessionRuntimeServiceDeps = {
		enabled: () => true,
		getSessions: () => [session],
		onRefreshRequested: vi.fn(),
		onLog: vi.fn(),
		registry,
		dispatchSubscription: vi.fn(() => 0),
		clearQueue: vi.fn(),
		clearFanInState: vi.fn(),
	};
	return { session, registry, deps, runtime: createCueSessionRuntimeService(deps) };
}

const config = createMockConfig({
	subscriptions: [
		{ name: 'sub', event: 'time.heartbeat', enabled: true, prompt: 'test', interval_minutes: 5 },
	],
});

describe('CueSessionRuntimeService missing-config retry', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.mocked(loadCueConfigDetailed)
			.mockReset()
			.mockReturnValue({ ok: true, config, warnings: [] });
		vi.mocked(resolveCueConfigPath).mockReset().mockReturnValue('/projects/test/.maestro/cue.yaml');
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('yields between all three retries and preserves subscriptions when the third attempt succeeds', async () => {
		const { session, registry, deps, runtime } = createRuntime();
		await runtime.initSession(session, { reason: 'user-toggle' });
		const state = registry.get(session.id)!;
		vi.mocked(loadCueConfigDetailed).mockReturnValue({ ok: false, reason: 'missing' });
		vi.mocked(resolveCueConfigPath)
			.mockReset()
			.mockReturnValueOnce(null)
			.mockReturnValueOnce(null)
			.mockReturnValueOnce('/projects/test/.maestro/cue.yaml');
		const interleaved = vi.fn();
		setTimeout(interleaved, 50);
		const refresh = runtime.refreshSession(session.id, session.projectRoot);
		expect(resolveCueConfigPath).not.toHaveBeenCalled();
		expect(registry.get(session.id)).toBe(state);
		await vi.advanceTimersByTimeAsync(149);
		expect(interleaved).toHaveBeenCalledOnce();
		expect(resolveCueConfigPath).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(resolveCueConfigPath).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(150);
		expect(resolveCueConfigPath).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(150);
		expect(await refresh).toMatchObject({ reloaded: true, configRemoved: false, activeCount: 1 });
		expect(resolveCueConfigPath).toHaveBeenCalledTimes(3);
		expect(registry.get(session.id)).toBe(state);
		expect(state.config.subscriptions).toHaveLength(1);
		expect(deps.clearQueue).not.toHaveBeenCalled();
		runtime.clearAll();
	});

	it('confirms a persistent deletion before stopping its trigger sources', async () => {
		const { session, registry, runtime } = createRuntime();
		await runtime.initSession(session, { reason: 'user-toggle' });
		const stop = registry.get(session.id)!.triggerSources[0].stop;
		vi.mocked(loadCueConfigDetailed).mockReturnValue({ ok: false, reason: 'missing' });
		vi.mocked(resolveCueConfigPath).mockReturnValue(null);
		const refresh = runtime.refreshSession(session.id, session.projectRoot);
		expect(stop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(450);
		expect(await refresh).toMatchObject({ reloaded: false, configRemoved: true });
		expect(stop).toHaveBeenCalledOnce();
		expect(registry.has(session.id)).toBe(false);
		expect(watchCueYaml).toHaveBeenCalledTimes(2);
		runtime.clearAll();
	});

	it('does not resurrect a removed session while a missing-config retry is pending', async () => {
		const { session, registry, runtime } = createRuntime();
		await runtime.initSession(session, { reason: 'user-toggle' });
		vi.mocked(loadCueConfigDetailed).mockReturnValue({ ok: false, reason: 'missing' });
		const refresh = runtime.refreshSession(session.id, session.projectRoot);
		runtime.removeSession(session.id);
		await vi.advanceTimersByTimeAsync(150);
		expect(await refresh).toEqual({ reloaded: false, configRemoved: false });
		expect(registry.has(session.id)).toBe(false);
		expect(watchCueYaml).toHaveBeenCalledTimes(1);
	});

	it('keeps an already initialized session active when initSession sees a transient missing file', async () => {
		const { session, registry, runtime } = createRuntime();
		await runtime.initSession(session, { reason: 'user-toggle' });
		const state = registry.get(session.id);
		vi.mocked(loadCueConfigDetailed).mockReturnValue({ ok: false, reason: 'missing' });
		const init = runtime.initSession(session, { reason: 'refresh' });
		expect(registry.get(session.id)).toBe(state);
		await vi.advanceTimersByTimeAsync(150);
		expect(await init).toEqual({ kind: 'loaded' });
		expect(registry.get(session.id)).toBe(state);
		runtime.clearAll();
	});
});
