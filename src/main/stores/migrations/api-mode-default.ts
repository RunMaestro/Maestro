/**
 * API Mode Default Migration
 *
 * One-shot reset that forces every existing Claude Code agent back onto the API
 * token source (`claude --print`, persisted as `enableMaestroP: false`).
 *
 * Background: an earlier migration (`migrateAdaptiveModeDefault`) flipped
 * unconfigured Claude Code agents onto Adaptive Mode (maestro-p), which legacy
 * storage reads as Dynamic. The maestro-p TUI path has since been a recurring
 * source of trouble, so we are reverting that decision wholesale: this
 * migration sets `enableMaestroP: false` on ALL Claude Code agents - including
 * ones currently on TUI or Dynamic, whether chosen automatically or by hand.
 * After this runs, every Claude Code agent spends per-token API credit until
 * the user deliberately re-enables TUI/Dynamic on that agent.
 *
 * `maestroPMode` is left untouched: it is ignored while `enableMaestroP` is
 * false, so leaving it in place simply remembers the user's prior sub-choice
 * if they later turn Adaptive Mode back on.
 *
 * Idempotent via a marker in the settings store. Once the marker is set the
 * migration never runs again, so a user who later re-enables TUI/Dynamic on an
 * agent won't have it forced back to API.
 */

import type Store from 'electron-store';

import { logger } from '../../utils/logger';
import { getSessionsStore } from '../getters';
import type { MaestroSettings, StoredSession } from '../types';

/** Settings key marking the one-time API-mode reset as done. */
export const API_MODE_DEFAULT_MIGRATION_MARKER = 'migration_apiModeDefaultV1';

/**
 * Force every existing Claude Code agent back onto the API token source once.
 * Reads/writes the sessions store directly; guarded by a marker in the passed
 * settings store.
 */
export function migrateApiModeDefault(store: Store<MaestroSettings>): void {
	if (store.get(API_MODE_DEFAULT_MIGRATION_MARKER)) {
		return;
	}

	const sessionsStore = getSessionsStore();
	const sessions = sessionsStore.get('sessions', []) as StoredSession[];

	let updated = 0;
	const nextSessions = sessions.map((session) => {
		// Reset EVERY Claude Code agent that isn't already pinned to API. Unlike
		// the prior adaptive-mode backfill, this is a deliberate blanket reset:
		// TUI/Dynamic agents (auto-flipped or hand-picked) all go back to API.
		if (session.toolType === 'claude-code' && session.enableMaestroP !== false) {
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
		`API Mode default migration complete - reset ${updated} existing Claude Code agent(s) to the API token source`,
		'Migration'
	);
}
