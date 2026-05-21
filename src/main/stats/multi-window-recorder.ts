/**
 * Multi-window telemetry recorder.
 *
 * Keeps stats collection gated by the existing Usage Dashboard setting.
 */

import type { MultiWindowEvent } from '../../shared/stats-types';
import type { WindowRegistry } from '../window-registry';
import { getStatsDB } from './singleton';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

const LOG_CONTEXT = '[MultiWindowTelemetry]';

export interface StatsSettingsReader {
	get: (key: string) => unknown;
}

export function isStatsCollectionEnabled(settingsStore?: StatsSettingsReader): boolean {
	if (!settingsStore) return true;
	return settingsStore.get('statsCollectionEnabled') !== false;
}

export function recordMultiWindowUsage(
	settingsStore: StatsSettingsReader | undefined,
	windowRegistry: WindowRegistry,
	eventType: MultiWindowEvent['eventType'],
	windowCountOverride?: number
): string | null {
	if (!isStatsCollectionEnabled(settingsStore)) {
		return null;
	}

	try {
		const entries = windowRegistry.getAll();
		const windowCount = windowCountOverride ?? entries.length;
		const secondaryWindowCount = Math.max(0, windowCount - (windowRegistry.getPrimary() ? 1 : 0));
		const sessionIds = new Set<string>();
		for (const entry of entries) {
			for (const sessionId of entry.sessionIds) {
				sessionIds.add(sessionId);
			}
		}

		return getStatsDB().recordMultiWindowEvent({
			eventType,
			windowCount,
			secondaryWindowCount,
			sessionCount: sessionIds.size,
		});
	} catch (error) {
		logger.warn(`Failed to record multi-window telemetry: ${error}`, LOG_CONTEXT);
		void captureException(error instanceof Error ? error : new Error(String(error)), {
			operation: 'recordMultiWindowUsage',
			eventType,
		});
		return null;
	}
}
