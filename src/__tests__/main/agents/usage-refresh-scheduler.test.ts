/**
 * Tests for src/main/agents/usage-refresh-scheduler.ts
 *
 * Strategy: mock both provider samplers (`claude-usage-startup`,
 * `codex-usage-startup`) and the logger, then drive the scheduler with fake
 * timers and a hand-rolled settings store that exposes `get` +
 * `onDidChange`. The other deps (sessions/agentConfigs/detector) are opaque
 * pass-throughs to the mocked samplers, so they can be minimal stubs.
 *
 * The scheduler's contract: read the persisted per-provider interval map, arm
 * one timer per provider with a positive interval (clamped to a 1-minute
 * floor), fire the matching sampler on each tick (guarding overlapping ticks),
 * re-arm when the persisted map changes, and tear everything down on stop().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
	runClaudeMock,
	runCodexMock,
	loggerInfoMock,
	loggerWarnMock,
	claudeSnapshotsMock,
	codexSnapshotsMock,
} = vi.hoisted(() => ({
	runClaudeMock: vi.fn(),
	runCodexMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerWarnMock: vi.fn(),
	claudeSnapshotsMock: vi.fn(),
	codexSnapshotsMock: vi.fn(),
}));

vi.mock('../../../main/agents/claude-usage-startup', () => ({
	runStartupUsageSampling: runClaudeMock,
}));

vi.mock('../../../main/agents/codex-usage-startup', () => ({
	runCodexUsageSampling: runCodexMock,
}));

// Snapshot stores are electron-store backed; the warm-up path only reads them.
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	getAllSnapshots: claudeSnapshotsMock,
}));

vi.mock('../../../main/stores/codexUsageStore', () => ({
	getAllCodexUsageSnapshots: codexSnapshotsMock,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: loggerInfoMock,
		warn: loggerWarnMock,
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

import { UsageRefreshScheduler } from '../../../main/agents/usage-refresh-scheduler';
import type { UsageRefreshSchedulerDeps } from '../../../main/agents/usage-refresh-scheduler';

const MIN_INTERVAL_MS = 60_000;

/**
 * Minimal settings-store double. `get` returns the current interval map;
 * `onDidChange` records the callback so a test can simulate a persisted change
 * (the scheduler re-reads via `get`, not the callback argument). The returned
 * unsubscribe is tracked so stop() can be asserted.
 */
function makeSettingsStore(initial: Record<string, number>) {
	let intervals = initial;
	const unsubscribe = vi.fn();
	let changeCb: (() => void) | null = null;
	const onDidChange = vi.fn((_key: string, cb: () => void) => {
		changeCb = cb;
		return unsubscribe;
	});
	return {
		store: {
			get: (_key: string) => intervals,
			onDidChange,
		} as unknown as UsageRefreshSchedulerDeps['settingsStore'],
		onDidChange,
		unsubscribe,
		/** Persist a new map and fire the change subscription, as the app would. */
		setIntervals(next: Record<string, number>) {
			intervals = next;
			changeCb?.();
		},
	};
}

function makeDeps(
	settingsStore: UsageRefreshSchedulerDeps['settingsStore']
): UsageRefreshSchedulerDeps {
	return {
		sessionsStore: { get: vi.fn() } as unknown as UsageRefreshSchedulerDeps['sessionsStore'],
		agentConfigsStore: {} as unknown as UsageRefreshSchedulerDeps['agentConfigsStore'],
		settingsStore,
		agentDetector: {} as unknown as UsageRefreshSchedulerDeps['agentDetector'],
	};
}

describe('UsageRefreshScheduler', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		runClaudeMock.mockReset().mockResolvedValue(undefined);
		runCodexMock.mockReset().mockResolvedValue(undefined);
		loggerInfoMock.mockReset();
		loggerWarnMock.mockReset();
		claudeSnapshotsMock.mockReset().mockReturnValue({});
		codexSnapshotsMock.mockReset().mockReturnValue({});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('arms a claude timer and ticks the claude sampler in manual mode', async () => {
		const s = makeSettingsStore({ 'claude-code': MIN_INTERVAL_MS });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();

		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);

		expect(runClaudeMock).toHaveBeenCalledTimes(1);
		expect(runClaudeMock.mock.calls[0][0]).toMatchObject({ mode: 'manual' });
		expect(runCodexMock).not.toHaveBeenCalled();
		scheduler.stop();
	});

	it('arms a codex timer and ticks the codex sampler', async () => {
		const s = makeSettingsStore({ codex: MIN_INTERVAL_MS });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();

		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);

		expect(runCodexMock).toHaveBeenCalledTimes(1);
		expect(runClaudeMock).not.toHaveBeenCalled();
		scheduler.stop();
	});

	it('does not arm a timer when the interval is 0 (off) or missing', async () => {
		const s = makeSettingsStore({ 'claude-code': 0 });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();

		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS * 5);

		expect(runClaudeMock).not.toHaveBeenCalled();
		expect(runCodexMock).not.toHaveBeenCalled();
		scheduler.stop();
	});

	it('clamps a sub-minute interval up to the 1-minute floor', async () => {
		const s = makeSettingsStore({ 'claude-code': 1_000 });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();

		// Below the floor: nothing fires yet.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(runClaudeMock).not.toHaveBeenCalled();

		// Reaching the clamped 60s floor fires exactly once.
		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS - 1_000);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);
		scheduler.stop();
	});

	it('is idempotent: a second start() does not double-arm', async () => {
		const s = makeSettingsStore({ 'claude-code': MIN_INTERVAL_MS });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();
		scheduler.start();

		expect(s.onDidChange).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);
		scheduler.stop();
	});

	it('re-arms when the persisted interval map changes', async () => {
		const s = makeSettingsStore({ 'claude-code': 0 });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();

		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
		expect(runClaudeMock).not.toHaveBeenCalled();

		// User picks an interval in the dashboard dropdown.
		s.setIntervals({ 'claude-code': MIN_INTERVAL_MS });
		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);
		scheduler.stop();
	});

	it('skips an overlapping tick while the previous sample is still running', async () => {
		let resolveSample: (() => void) | undefined;
		runClaudeMock.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveSample = resolve;
				})
		);
		const s = makeSettingsStore({ 'claude-code': MIN_INTERVAL_MS });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();

		// First tick starts and stays in-flight (promise unresolved).
		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);

		// Second tick fires while still in-flight: it should be skipped.
		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);

		// Let the first sample finish, then the next tick runs normally.
		resolveSample?.();
		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(2);
		scheduler.stop();
	});

	it('keeps the interval alive after a sampler throws', async () => {
		runClaudeMock.mockReset().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
		const s = makeSettingsStore({ 'claude-code': MIN_INTERVAL_MS });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();

		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);
		expect(loggerWarnMock).toHaveBeenCalled();

		// A throw must not kill the interval: the next tick still fires.
		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(2);
		scheduler.stop();
	});

	describe('warmUp()', () => {
		const usefulClaudeSnapshot = {
			claude: {
				sampledAt: new Date(0).toISOString(),
				configDirKey: '/home/u/.claude',
				authState: 'authenticated',
				session: { percent: 12, resetsAt: '2026-01-01T00:00:00.000Z' },
				weekAllModels: { percent: 30, resetsAt: '2026-01-05T00:00:00.000Z' },
				weekSonnetOnly: { percent: 8, resetsAt: '2026-01-05T00:00:00.000Z' },
			},
		};
		const usefulCodexSnapshot = {
			codex: {
				sampledAt: new Date(0).toISOString(),
				codexHomeKey: '/home/u/.codex',
				authState: 'authenticated',
				session: { percent: 40, resetsAt: '2026-01-01T00:00:00.000Z' },
			},
		};

		it('samples both providers when neither has a usable snapshot', async () => {
			const s = makeSettingsStore({});
			const scheduler = new UsageRefreshScheduler(makeDeps(s.store));

			await scheduler.warmUp();

			expect(runClaudeMock).toHaveBeenCalledTimes(1);
			expect(runClaudeMock.mock.calls[0][0]).toMatchObject({ mode: 'manual' });
			expect(runCodexMock).toHaveBeenCalledTimes(1);
		});

		it('samples only the cold provider', async () => {
			claudeSnapshotsMock.mockReturnValue(usefulClaudeSnapshot);
			const s = makeSettingsStore({});
			const scheduler = new UsageRefreshScheduler(makeDeps(s.store));

			await scheduler.warmUp();

			expect(runClaudeMock).not.toHaveBeenCalled();
			expect(runCodexMock).toHaveBeenCalledTimes(1);
		});

		it('no-ops when both providers already have usable snapshots', async () => {
			claudeSnapshotsMock.mockReturnValue(usefulClaudeSnapshot);
			codexSnapshotsMock.mockReturnValue(usefulCodexSnapshot);
			const s = makeSettingsStore({});
			const scheduler = new UsageRefreshScheduler(makeDeps(s.store));

			await scheduler.warmUp();

			expect(runClaudeMock).not.toHaveBeenCalled();
			expect(runCodexMock).not.toHaveBeenCalled();
		});

		it('treats an unauthenticated/empty snapshot as cold', async () => {
			claudeSnapshotsMock.mockReturnValue({
				claude: { ...usefulClaudeSnapshot.claude, authState: 'unauthenticated' },
			});
			codexSnapshotsMock.mockReturnValue({
				codex: { sampledAt: '', codexHomeKey: '/home/u/.codex', authState: 'missing_auth' },
			});
			const s = makeSettingsStore({});
			const scheduler = new UsageRefreshScheduler(makeDeps(s.store));

			await scheduler.warmUp();

			expect(runClaudeMock).toHaveBeenCalledTimes(1);
			expect(runCodexMock).toHaveBeenCalledTimes(1);
		});

		it('does not throw when a sampler fails', async () => {
			runClaudeMock.mockRejectedValueOnce(new Error('boom'));
			const s = makeSettingsStore({});
			const scheduler = new UsageRefreshScheduler(makeDeps(s.store));

			await expect(scheduler.warmUp()).resolves.toBeUndefined();
			expect(loggerWarnMock).toHaveBeenCalled();
		});

		it('does not stack with an in-flight scheduled tick', async () => {
			let resolveSample: (() => void) | undefined;
			runClaudeMock.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						resolveSample = resolve;
					})
			);
			const s = makeSettingsStore({ 'claude-code': MIN_INTERVAL_MS });
			const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
			scheduler.start();

			await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
			expect(runClaudeMock).toHaveBeenCalledTimes(1);

			// Warm-up while that sample is still running must be skipped, not queued.
			void scheduler.warmUp();
			await vi.advanceTimersByTimeAsync(0);
			expect(runClaudeMock).toHaveBeenCalledTimes(1);

			resolveSample?.();
			scheduler.stop();
		});
	});

	it('stop() clears timers and unsubscribes from settings changes', async () => {
		const s = makeSettingsStore({ 'claude-code': MIN_INTERVAL_MS });
		const scheduler = new UsageRefreshScheduler(makeDeps(s.store));
		scheduler.start();

		scheduler.stop();
		expect(s.unsubscribe).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS * 3);
		expect(runClaudeMock).not.toHaveBeenCalled();
	});
});
