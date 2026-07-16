/**
 * API Mode Default Migration (v2)
 *
 * Source version: sessions without `enableMaestroP`.
 * Target version: those sessions explicitly persist the current API default
 * (`enableMaestroP: false`).
 *
 * Explicit `true` and `false` values are user choices and must never be
 * overwritten by a default-policy migration. The marker makes repeated startup
 * runs idempotent while retaining the historical read window.
 */

import type Store from 'electron-store';

import { logger } from '../../utils/logger';
import { getSessionsStore } from '../getters';
import type { MaestroSettings, StoredSession } from '../types';

/** Persisted marker for the v2 API-default migration. */
export const API_MODE_DEFAULT_MIGRATION_MARKER = 'migration_apiModeDefaultV2';

export const API_MODE_DEFAULT_MIGRATION_SOURCE_VERSION = 1;
export const API_MODE_DEFAULT_MIGRATION_TARGET_VERSION = 2;

/** Apply the v2 default only to older sessions with no token-source choice. */
export function migrateApiModeDefaultV2(store: Store<MaestroSettings>): void {
	if (store.get(API_MODE_DEFAULT_MIGRATION_MARKER)) {
		return;
	}

	const sessionsStore = getSessionsStore();
	const sessions = sessionsStore.get('sessions', []) as StoredSession[];

	let updated = 0;
	const nextSessions = sessions.map((session) => {
		// Only an absent value receives a default. Both true (Adaptive Mode) and
		// false (API) are explicit persisted choices that must survive upgrades.
		if (session.toolType === 'claude-code' && session.enableMaestroP === undefined) {
			updated++;
			return { ...session, enableMaestroP: false };
		}
		return session;
	});

	if (updated > 0) {
		sessionsStore.set('sessions', nextSessions);
	}

	store.set(API_MODE_DEFAULT_MIGRATION_MARKER, true);
	logger.info(
		`API Mode default migration v2 complete - backfilled ${updated} unconfigured Claude Code agent(s)`,
		'Migration'
	);
}
