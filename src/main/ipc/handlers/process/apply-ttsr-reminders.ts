/**
 * Fold TTSR's deferred reminders into a spawn's prompt (plan Phase 3c).
 *
 * A rule that matches without interrupting does not abort the turn - it queues
 * a `<system-reminder>` main-side. Maestro has no tool-result hook to fold that
 * guidance in-band the way OMP does, so it waits until the conversation's next
 * prompt is spawned, which is here.
 *
 * The read is transactional: the queue is only cleared once the process has
 * actually been spawned. Everything between this call and `ProcessManager.spawn`
 * can throw - Claude context resolution, the fail-loud SSH resolver, the spawn
 * itself - and a destructive read would silently destroy the guidance on the way
 * out, with nothing left to re-deliver it on the next attempt.
 *
 * The drain is injected rather than imported so the spawn path keeps no TTSR
 * dependency; with no drain (or nothing queued) the config is returned as-is.
 */

import { logger } from '../../../utils/logger';
import type { SpawnProcessConfig } from './spawn-types';

const LOG_CONTEXT = '[ProcessManager]';

/** Non-destructive read of a conversation's queue, plus its commit. */
export interface TtsrReminderPeek {
	text: string;
	commit(): void;
}

export interface TtsrReminderApplication {
	/** The spawn config, with the reminders prepended to its prompt. */
	config: SpawnProcessConfig;
	/**
	 * Clear the queue. Call it only after the spawn has succeeded; skipping it
	 * (on a throw or an early return) leaves the reminders queued for the next
	 * attempt. Idempotent, so a spawn path that retries internally cannot eat a
	 * second batch.
	 */
	commit(): void;
}

const NOOP_COMMIT = () => {};

export function applyTtsrReminders(
	config: SpawnProcessConfig,
	peekReminders?: (sessionId: string) => TtsrReminderPeek
): TtsrReminderApplication {
	// A promptless spawn (terminal, interactive shell) has nothing to prepend to,
	// and draining there would throw the reminder away.
	if (!peekReminders || !config.prompt) return { config, commit: NOOP_COMMIT };

	const { text, commit } = peekReminders(config.sessionId);
	if (!text) return { config, commit: NOOP_COMMIT };

	logger.info('Prepended TTSR deferred reminders to prompt', LOG_CONTEXT, {
		sessionId: config.sessionId,
		reminderLength: text.length,
	});
	return { config: { ...config, prompt: `${text}\n\n${config.prompt}` }, commit };
}
