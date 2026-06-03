/**
 * useQuotaRefresh
 *
 * Refresh state machine shared by the provider quota panels. Owns the manual
 * Refresh handler, the visual-busy dwell (so a sub-100ms IPC round-trip still
 * animates a full beat), a one-shot auto-sample on first arrival with
 * configured-but-empty accounts, and read/write of the persisted per-provider
 * auto-refresh interval.
 *
 * The periodic background sampling is NOT driven here - it lives in the main
 * process (`usage-refresh-scheduler.ts`), which reads the same persisted
 * `usageRefreshIntervals` map and samples on cadence even when the dashboard is
 * closed. This hook only surfaces the dropdown's current value and persists the
 * user's choice; the main scheduler is the sole driver.
 *
 * Provider specifics live in `doRefresh`, which should trigger the main-side
 * sampler and then re-pull the renderer store.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../../stores/uiStore';

/** Minimum spinner dwell so a fast IPC round-trip still animates a full beat. */
const MIN_VISIBLE_MS = 900;

export interface UseQuotaRefreshOptions {
	/**
	 * Provider id this panel refreshes ('claude-code' | 'codex'). Keys the
	 * persisted auto-refresh interval so each provider has its own cadence.
	 */
	providerId: string;
	/** Whether the provider store currently reports an in-flight refresh. */
	refreshing: boolean;
	/** Auto-sample once on first arrival with configured-but-empty accounts. */
	autoRefresh: boolean;
	/** Configured account count (gates the one-shot auto-sample). */
	accountCount: number;
	/** Cached snapshot count (gates the one-shot auto-sample). */
	snapshotCount: number;
	/** Provider refresh: trigger the main sampler, then re-pull the store. */
	doRefresh: () => Promise<void>;
}

export interface UseQuotaRefreshResult {
	isBusy: boolean;
	refreshIntervalMs: number;
	setRefreshIntervalMs: (ms: number) => void;
	handleRefresh: () => Promise<void>;
}

export function useQuotaRefresh(opts: UseQuotaRefreshOptions): UseQuotaRefreshResult {
	const { providerId, refreshing, autoRefresh, accountCount, snapshotCount } = opts;

	// Visual gate kept independent of `refreshing` so a fast sample still
	// animates the button for a full beat instead of flashing.
	const [visualBusy, setVisualBusy] = useState(false);

	// Interval is persisted per provider in uiStore (alongside the hidden-account
	// map) so the dropdown survives closing the dashboard / switching tabs. The
	// main-process scheduler reads the same persisted value and is the sole driver
	// of background sampling - this hook never arms its own timer.
	const refreshIntervalMs = useUIStore((s) => s.usageRefreshIntervals[providerId] ?? 0);
	const setRefreshIntervalMs = useCallback(
		(ms: number) => useUIStore.getState().setUsageRefreshInterval(providerId, ms),
		[providerId]
	);

	const doRefreshRef = useRef(opts.doRefresh);
	useEffect(() => {
		doRefreshRef.current = opts.doRefresh;
	});

	const handleRefresh = useCallback(async () => {
		if (refreshing || visualBusy) return;
		setVisualBusy(true);
		const start = Date.now();
		try {
			await doRefreshRef.current();
		} catch {
			// Provider logs carry the detail; keep the last good snapshot map
			// rather than blowing up the dashboard.
		}
		const elapsed = Date.now() - start;
		if (elapsed < MIN_VISIBLE_MS) {
			await new Promise((r) => setTimeout(r, MIN_VISIBLE_MS - elapsed));
		}
		setVisualBusy(false);
	}, [refreshing, visualBusy]);

	// Auto-sample once when opened with configured-but-empty accounts - saves a
	// manual click. The empty-snapshot CTA still acts as a fallback if the
	// auto-sample itself fails. Ref-guarded so React Strict-Mode's dev
	// double-mount doesn't fire two samples back-to-back.
	const autoRefreshFiredRef = useRef(false);
	useEffect(() => {
		if (!autoRefresh) return;
		if (autoRefreshFiredRef.current) return;
		if (accountCount === 0) return;
		if (snapshotCount > 0) return;
		if (refreshing || visualBusy) return;
		autoRefreshFiredRef.current = true;
		void handleRefresh();
	}, [autoRefresh, accountCount, snapshotCount, refreshing, visualBusy, handleRefresh]);

	return {
		isBusy: refreshing || visualBusy,
		refreshIntervalMs,
		setRefreshIntervalMs,
		handleRefresh,
	};
}
