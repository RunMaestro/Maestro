/**
 * Legacy Adaptive Mode Migration (v1)
 *
 * Source version: the historical one-time default-on rollout.
 * Target version: recorded completion without altering a token-source choice.
 *
 * Adaptive Mode now defaults to API. This retained migration only closes the
 * historical marker window; it deliberately does not reinterpret persisted or
 * absent session values.
 */

import type Store from 'electron-store';

import { logger } from '../../utils/logger';
import type { MaestroSettings } from '../types';

/** Persisted marker for the legacy default-on rollout. */
export const ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER = 'migration_adaptiveModeDefaultV1';

export const ADAPTIVE_MODE_DEFAULT_MIGRATION_SOURCE_VERSION = 0;
export const ADAPTIVE_MODE_DEFAULT_MIGRATION_TARGET_VERSION = 1;

/** Record completion of the legacy migration without mutating session data. */
export function migrateLegacyAdaptiveModeDefaultV1(store: Store<MaestroSettings>): void {
	if (store.get(ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER)) {
		return;
	}

	store.set(ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER, true);
	logger.info('Legacy Adaptive Mode migration v1 recorded without session changes', 'Migration');
}
