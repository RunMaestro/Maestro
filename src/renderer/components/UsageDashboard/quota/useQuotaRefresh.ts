/**
 * useQuotaRefresh
 *
 * Refresh state machine shared by the provider quota panels. Owns the manual
 * Refresh handler, the visual-busy dwell (so a sub-100ms IPC round-trip still
 * animates a full beat), a one-shot auto-sample on first arrival with
 * configured-but-empty accounts, and the periodic auto-refresh interval.
 *
 * Provider specifics live in `doRefresh`, which should trigger the main-side
 * sampler and then re-pull the renderer store.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Minimum spinner dwell so a fast IPC round-trip still animates a full beat. */
const MIN_VISIBLE_MS = 900;

export interface UseQuotaRefreshOptions {
	/** Whether the provider store currently reports an in-flight refresh. */
	refreshing: boolean;
	/** Auto-sample once on first arrival with configured-but-empty accounts. */
	autoRefresh: boolean;
	/** Whether the periodic auto-refresh control is mounted. */
	showRefreshButton: boolean;
	/** Configured account count (gates auto + interval refresh). */
	accountCount: number;
	/** Cached snapshot count (gates auto + interval refresh). */
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
	const { refreshing, autoRefresh, showRefreshButton, accountCount, snapshotCount } = opts;

	// Visual gate kept independent of `refreshing` so a fast sample still
	// animates the button for a full beat instead of flashing.
	const [visualBusy, setVisualBusy] = useState(false);
	const [refreshIntervalMs, setRefreshIntervalMs] = useState(0);

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

	const handleRefreshRef = useRef(handleRefresh);
	useEffect(() => {
		handleRefreshRef.current = handleRefresh;
	}, [handleRefresh]);

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

	// Periodic auto-refresh while the dropdown is set to an interval.
	useEffect(() => {
		if (!showRefreshButton) return;
		if (refreshIntervalMs <= 0) return;
		if (accountCount === 0) return;
		if (snapshotCount === 0) return;
		const timer = window.setInterval(() => {
			void handleRefreshRef.current();
		}, refreshIntervalMs);
		return () => window.clearInterval(timer);
	}, [showRefreshButton, refreshIntervalMs, accountCount, snapshotCount]);

	return {
		isBusy: refreshing || visualBusy,
		refreshIntervalMs,
		setRefreshIntervalMs,
		handleRefresh,
	};
}
