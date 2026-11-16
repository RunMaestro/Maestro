/**
 * Primary Agent Seed Migration (#2050)
 *
 * One-shot seed of the app-level Primary Agent from the per-feature default
 * that existed before it: Quick Chat's chosen agent. A user who already picked
 * an agent for Quick Chat gets that agent as their Primary Agent, so the new
 * setting starts where their habits already are.
 *
 * Quick Chat's own setting is left as it is. It still overrides the Primary
 * Agent for Quick Chat, which keeps the migration free of behavior changes.
 *
 * Idempotent via a marker. A Primary Agent that is already set is never
 * replaced, and once the marker is set the seed never runs again, so a user who
 * clears the Primary Agent later does not get it back on the next boot.
 */

import type Store from 'electron-store';

import { logger } from '../../utils/logger';
import { getSessionsStore } from '../getters';
import type { MaestroSettings, StoredSession } from '../types';
import { PRIMARY_AGENT_SETTING_KEY, pickPrimaryAgentSeed } from '../../../shared/primaryAgent';
import { resolveQuickChatSettings, QUICK_CHAT_SETTINGS_KEY } from '../../../shared/quickChat';

/** Settings key marking the one-time Primary Agent seed as done. */
export const PRIMARY_AGENT_SEED_MIGRATION_MARKER = 'migration_primaryAgentSeedV1';

export function migratePrimaryAgentSeed(store: Store<MaestroSettings>): void {
	if (store.get(PRIMARY_AGENT_SEED_MIGRATION_MARKER)) return;

	const current = store.get(PRIMARY_AGENT_SETTING_KEY, null);
	if (typeof current !== 'string' || current === '') {
		const sessions = getSessionsStore().get('sessions', []) as StoredSession[];
		const liveIds = new Set(sessions.map((s) => s.id));
		const quickChat = resolveQuickChatSettings(store.get(QUICK_CHAT_SETTINGS_KEY));
		const seed = pickPrimaryAgentSeed([quickChat.agentId], liveIds);
		if (seed) {
			store.set(PRIMARY_AGENT_SETTING_KEY, seed);
			logger.info('Primary Agent seeded from the Quick Chat agent', 'Migration');
		}
	}

	store.set(PRIMARY_AGENT_SEED_MIGRATION_MARKER, true);
}
