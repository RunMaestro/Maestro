/**
 * Multi-Window Usage Telemetry Wiring
 *
 * Subscribes to the {@link WindowRegistry} change signal and records aggregate
 * multi-window usage (secondary windows opened + peak concurrent window count)
 * into the stats database. This is the main-process counterpart to the renderer's
 * `stats:*` IPC writers - window open/close happens entirely in the main process,
 * so the registry is the natural funnel.
 *
 * What is recorded, and why it is aggregate-only:
 *  - `windows_opened` increments only for SECONDARY window opens. The primary
 *    window opens once per launch and is not "multi-window" usage, so counting it
 *    would conflate app launches with the feature this telemetry measures.
 *  - `peak_concurrent` is sampled from the full registry size (primary included)
 *    at each secondary open. The concurrent count only rises when a window opens,
 *    so sampling on open captures the true daily peak. A peak below 2 means the
 *    user never ran more than one window.
 *
 * No agent ids, session contents, or window ids are stored - just a date and two
 * integers. Everything is gated on the user's `statsCollectionEnabled` setting:
 * when analytics are off, nothing is recorded.
 */

import type { WindowRegistry } from '../window-registry';
import type { StatsDB } from './stats-db';
import { getStatsDB } from './singleton';
import { isStatsCollectionEnabled, LOG_CONTEXT, type StatsSettingsStore } from './utils';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

/** Dependencies for {@link wireMultiWindowTelemetry}. */
export interface MultiWindowTelemetryDependencies {
	/** Settings store used to honor the `statsCollectionEnabled` analytics gate. */
	settingsStore?: StatsSettingsStore;
	/**
	 * Stats DB accessor. Defaults to the shared singleton; injectable so tests can
	 * supply a fake without loading the native SQLite module.
	 */
	getStatsDb?: () => Pick<StatsDB, 'isReady' | 'recordWindowOpened'>;
}

/**
 * Subscribe to window-open events and record multi-window usage telemetry.
 *
 * Returns an unsubscribe function so callers (and tests) can tear the
 * subscription down. The recording is fully defensive: a stats-DB hiccup is
 * reported to Sentry but never propagates out of the synchronous registry
 * listener, so a telemetry failure can never break window creation.
 */
export function wireMultiWindowTelemetry(
	registry: WindowRegistry,
	deps: MultiWindowTelemetryDependencies = {}
): () => void {
	const { settingsStore, getStatsDb = getStatsDB } = deps;

	return registry.onChange((change) => {
		// Only window opens carry telemetry. Window close lowers the concurrent
		// count, which never raises the peak, so there is nothing to record.
		if (change.type !== 'created' || !change.windowId) return;

		// Skip the always-present primary window - this telemetry measures the
		// multi-window feature, not app launches.
		const opened = registry.get(change.windowId);
		if (!opened || opened.isMain) return;

		// Honor the user's analytics setting: record nothing when it is off.
		if (!isStatsCollectionEnabled(settingsStore)) return;

		try {
			const db = getStatsDb();
			// Stats DB may be unavailable (failed to initialize); skip silently.
			if (!db.isReady()) return;
			const concurrentWindowCount = registry.getAll().length;
			db.recordWindowOpened(Date.now(), concurrentWindowCount);
		} catch (error) {
			// Telemetry is best-effort and must never break window creation. Report
			// the unexpected failure to Sentry, then swallow it.
			logger.warn(`Failed to record multi-window telemetry: ${error}`, LOG_CONTEXT);
			void captureException(error instanceof Error ? error : new Error(String(error)), {
				operation: 'stats:recordWindowOpened',
			});
		}
	});
}
