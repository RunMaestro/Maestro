/**
 * Fold TTSR's deferred reminders into a spawn's prompt (plan Phase 3c).
 *
 * A rule that matches without interrupting does not abort the turn - it queues
 * a `<system-reminder>` main-side. Maestro has no tool-result hook to fold that
 * guidance in-band the way OMP does, so it waits until the conversation's next
 * prompt is spawned, which is here.
 *
 * The drain is injected rather than imported so the spawn path keeps no TTSR
 * dependency; with no drain (or nothing queued) the config is returned as-is.
 */

import { logger } from '../../../utils/logger';
import type { SpawnProcessConfig } from './spawn-types';

const LOG_CONTEXT = '[ProcessManager]';

export function applyTtsrReminders(
	config: SpawnProcessConfig,
	takeReminders?: (sessionId: string) => string
): SpawnProcessConfig {
	// A promptless spawn (terminal, interactive shell) has nothing to prepend to,
	// and draining there would throw the reminder away.
	if (!takeReminders || !config.prompt) return config;

	const reminders = takeReminders(config.sessionId);
	if (!reminders) return config;

	logger.info('Prepended TTSR deferred reminders to prompt', LOG_CONTEXT, {
		sessionId: config.sessionId,
		reminderLength: reminders.length,
	});
	return { ...config, prompt: `${reminders}\n\n${config.prompt}` };
}
