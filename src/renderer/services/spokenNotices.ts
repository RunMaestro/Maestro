/**
 * Spoken notices, renderer side: tell main that an agent finished a turn.
 *
 * The renderer knows WHAT finished (the agent's name, the request, the reply);
 * main decides whether to say anything about it (the `spokenNotices` setting,
 * whether Maestro is focused, whether a voice session is live), writes the
 * line, and speaks it. See `src/main/local-models/spoken-notices.ts`.
 *
 * Fire and forget: a notice is a courtesy, so nothing a turn does afterwards
 * waits on it, and a notice that was skipped is not an error.
 */

import {
	boundAgentFinishedNotice,
	type AgentFinishedNotice,
	type SpokenNoticeResult,
} from '../../shared/spokenNotices';
import { useSettingsStore } from '../stores/settingsStore';
import { logger } from '../utils/logger';

/** The line the Test button speaks. */
export const SPOKEN_NOTICE_TEST_LINE = 'Maestro finished: this is how a spoken notice sounds.';

/**
 * Report a finished turn. A no-op while the setting is off, so a user who never
 * opted in sends nothing across the bridge.
 *
 * Call it only from the client that owns a turn's side effects: the line is
 * spoken on the computer running Maestro, and two clients reporting one turn
 * would say it twice.
 */
export function announceAgentFinished(notice: AgentFinishedNotice): void {
	if (useSettingsStore.getState().spokenNotices === 'off') return;
	const api = window.maestro?.localModels?.spokenNotices;
	if (!api) return;
	api
		.agentFinished(boundAgentFinishedNotice(notice))
		.then((result) => {
			if (!result.spoken && result.code === 'speech-failed') {
				logger.warn('[SpokenNotices] Notice was not spoken:', undefined, result.message);
			}
		})
		.catch((error) => {
			logger.error('[SpokenNotices] Notice request failed:', undefined, error);
		});
}

/** Speak the sample line now, whatever the setting says. The Test button. */
export function speakTestNotice(): Promise<SpokenNoticeResult> {
	return window.maestro.localModels.spokenNotices.speak(SPOKEN_NOTICE_TEST_LINE);
}
