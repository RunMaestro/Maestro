/**
 * Usage & Stats `stats.sampler` lifecycle through the first-party bridge
 * (encore-lifts L5): marketplace disable/revoke must ACTUALLY stop the
 * background provider-quota sampling loop, and re-enable must re-arm it.
 *
 * Strategy: a REAL UsageRefreshScheduler (samplers + logger mocked, fake
 * timers) supervised by a REAL FirstPartyPluginBridge over the REAL
 * USAGE_STATS_FIRST_PARTY_PLUGIN definition — the same
 * reconcile=start()/stopAll=stop() hooks index.ts wires into
 * firstPartySupervisors.usageStats. Grants live in a minimal in-memory
 * ledger double (the sealed-ledger integration is covered by
 * first-party-bridge.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { runClaudeMock, runCodexMock } = vi.hoisted(() => ({
	runClaudeMock: vi.fn(),
	runCodexMock: vi.fn(),
}));

vi.mock('../../../main/agents/claude-usage-startup', () => ({
	runStartupUsageSampling: runClaudeMock,
}));

vi.mock('../../../main/agents/codex-usage-startup', () => ({
	runCodexUsageSampling: runCodexMock,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { UsageRefreshScheduler } from '../../../main/agents/usage-refresh-scheduler';
import type { UsageRefreshSchedulerDeps } from '../../../main/agents/usage-refresh-scheduler';
import { USAGE_STATS_FIRST_PARTY_PLUGIN } from '../../../shared/plugins/first-party';
import { grantsFromRequests, type PermissionGrant } from '../../../shared/plugins/permissions';
import { FirstPartyPluginBridge } from '../../../main/plugins/first-party-bridge';

const INTERVAL_MS = 60_000;

/** One store double serving BOTH consumers: the scheduler reads
 * `usageRefreshIntervals` (+ onDidChange), the bridge reads/writes
 * `encoreFeatures`. */
function makeSettingsStore(intervals: Record<string, number>) {
	const values: Record<string, unknown> = {
		usageRefreshIntervals: intervals,
		encoreFeatures: {},
	};
	return {
		get: (key: string) => values[key],
		set: (key: string, value: unknown) => {
			values[key] = value;
		},
		onDidChange: vi.fn(() => vi.fn()),
	};
}

/** Minimal in-memory grants ledger (mint verbatim from the declaration). */
function makeGrantsLedger() {
	const byPlugin = new Map<string, readonly PermissionGrant[]>();
	return {
		readGrants: (pluginId: string) => byPlugin.get(pluginId) ?? [],
		mint: (pluginId: string, grants: readonly PermissionGrant[]) => byPlugin.set(pluginId, grants),
		revoke: (pluginId: string) => byPlugin.delete(pluginId),
	};
}

function makeHarness() {
	const settingsStore = makeSettingsStore({ 'claude-code': INTERVAL_MS });
	const scheduler = new UsageRefreshScheduler({
		sessionsStore: { get: vi.fn() } as unknown as UsageRefreshSchedulerDeps['sessionsStore'],
		agentConfigsStore: {} as unknown as UsageRefreshSchedulerDeps['agentConfigsStore'],
		settingsStore: settingsStore as unknown as UsageRefreshSchedulerDeps['settingsStore'],
		agentDetector: {} as unknown as UsageRefreshSchedulerDeps['agentDetector'],
	});
	const ledger = makeGrantsLedger();
	// The EXACT hooks index.ts registers under firstPartySupervisors.usageStats.
	const bridge = new FirstPartyPluginBridge(USAGE_STATS_FIRST_PARTY_PLUGIN, {
		settingsStore,
		readGrants: (id) => ledger.readGrants(id),
		mintFirstPartyGrants: (definition) =>
			ledger.mint(definition.id, grantsFromRequests([...definition.permissions], 1000)),
		revokeGrants: (id) => ledger.revoke(id),
		supervisor: {
			reconcile: () => scheduler.start(),
			stopAll: () => scheduler.stop(),
		},
	});
	return { scheduler, bridge, settingsStore, ledger };
}

describe('stats.sampler lifecycle through the first-party bridge', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		runClaudeMock.mockReset().mockResolvedValue(undefined);
		runCodexMock.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('enable mints the declared grants and arms the sampling loop', async () => {
		const { bridge, scheduler } = makeHarness();

		const state = bridge.setEnabled(true);
		expect(state).toEqual({ enabled: true, authorized: true });

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);
		scheduler.stop();
	});

	it('marketplace disable stops the sampling loop (no further ticks)', async () => {
		const { bridge } = makeHarness();
		bridge.setEnabled(true);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);

		const state = bridge.setEnabled(false);
		expect(state.enabled).toBe(false);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
		expect(runClaudeMock).toHaveBeenCalledTimes(1); // nothing after disable
	});

	it('re-enable re-arms the loop from the persisted intervals', async () => {
		const { bridge, scheduler } = makeHarness();
		bridge.setEnabled(true);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		bridge.setEnabled(false);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);

		bridge.setEnabled(true);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(2);
		scheduler.stop();
	});

	it('revoke stops the loop and drops authority (fails closed)', async () => {
		const { bridge, ledger } = makeHarness();
		bridge.setEnabled(true);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);

		const state = bridge.revoke();
		expect(state).toEqual({ enabled: false, authorized: false });
		expect(ledger.readGrants(USAGE_STATS_FIRST_PARTY_PLUGIN.id)).toEqual([]);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);
	});

	it('reconcileBackgroundService stops the loop when grants are gone', async () => {
		const { bridge, ledger, settingsStore } = makeHarness();
		bridge.setEnabled(true);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);

		// Simulate out-of-band grant loss (ledger wipe) with the flag still on.
		ledger.revoke(USAGE_STATS_FIRST_PARTY_PLUGIN.id);
		const state = bridge.reconcileBackgroundService();
		expect(state).toEqual({ enabled: false, authorized: false });
		expect((settingsStore.get('encoreFeatures') as Record<string, unknown>).usageStats).toBe(false);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
		expect(runClaudeMock).toHaveBeenCalledTimes(1);
	});
});
