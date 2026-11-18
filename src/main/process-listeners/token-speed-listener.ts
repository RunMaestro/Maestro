/**
 * Token speed listener.
 *
 * Writes every model call the process manager timed off a provider's live
 * stream (`'token-speed'`, see `StdoutHandler.recordCallTiming`) into the stats
 * database's hourly token speed table. Honors the stats collection setting like
 * every other stats write, and never lets a database failure reach the
 * process pipeline.
 */

import type { ProcessManager } from '../process-manager';
import { getStatsDB } from '../stats/singleton';
import { isStatsCollectionEnabled, type StatsSettingsStore } from '../stats/utils';
import { captureException } from '../utils/sentry';

export function setupTokenSpeedListener(
	processManager: ProcessManager,
	settingsStore: StatsSettingsStore
): void {
	processManager.on('token-speed', (_sessionId, agentType, sample) => {
		if (!isStatsCollectionEnabled(settingsStore)) return;
		const db = getStatsDB();
		if (!db.isReady()) return;
		try {
			db.recordTokenSpeedSample(agentType, sample);
		} catch (error) {
			// A dropped sample costs one call's speed reading; it must not take
			// the agent's output stream down with it.
			void captureException(error, { operation: 'recordTokenSpeedSample', agentType });
		}
	});
}
