/**
 * Adaptive Mode Default Migration
 *
 * One-shot backfill that turns Adaptive Mode (`enableMaestroP`) on for every
 * existing Claude Code agent that has NEVER configured a token source, matching
 * the new "default on for new agents" behavior (see `isAdaptiveModeDefaultOn`
 * in `src/shared/agentConstants.ts`). Agents with an explicit `false` (the user
 * deliberately picked the API token source) are left untouched - flipping them
 * on would silently revert their choice to Dynamic.
 *
 * Idempotent via a marker in the settings store - once the marker is set the
 * migration never runs again, so a user who later turns Adaptive Mode off on a
 * given agent won't have it forced back on.
 */

import type Store from 'electron-store';

import { isAdaptiveModeDefaultOn } from '../../../shared/agentConstants';
import { logger } from '../../utils/logger';
import { getSessionsStore } from '../getters';
import type { MaestroSettings, StoredSession } from '../types';

/** Settings key marking the one-time Adaptive Mode default backfill as done. */
export const ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER = 'migration_adaptiveModeDefaultV1';

/**
 * Enable Adaptive Mode on existing Claude Code agents once. Reads/writes the
 * sessions store directly; guarded by a marker in the passed settings store.
 */
export function migrateAdaptiveModeDefault(store: Store<MaestroSettings>): void {
	if (store.get(ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER)) {
		return;
	}

	const sessionsStore = getSessionsStore();
	const sessions = sessionsStore.get('sessions', []) as StoredSession[];

	let updated = 0;
	const nextSessions = sessions.map((session) => {
		// Only backfill the NEVER-CONFIGURED state (`undefined`). An explicit
		// `false` means the user deliberately picked API as their token source -
		// forcing Adaptive Mode back on would silently revert their choice to
		// Dynamic on the next app launch. `!== true` would wrongly catch both.
		if (isAdaptiveModeDefaultOn(session.toolType) && session.enableMaestroP === undefined) {
			updated++;
			return { ...session, enableMaestroP: true };
		}
		return session;
	});

	if (updated > 0) {
		sessionsStore.set('sessions', nextSessions);
	}

	store.set(ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER, true);
	logger.info(
		`Adaptive Mode default migration complete - enabled on ${updated} existing Claude Code agent(s)`,
		'Migration'
	);
}
