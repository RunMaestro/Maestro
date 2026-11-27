// `maestro-cli tab suggest-cleanup` - ask the Tab cleanup Local Models
// assignment which tabs, across every agent, could be closed, snoozed, or
// brought back from snooze.
//
// It runs in the desktop over the WS bridge, through the same main-process
// function as the Tab Cleanup Suggestions modal, so the CLI and the modal read
// the same tabs, the same assignment, and the same guard: a tab that is busy,
// starred, or holding an unsent draft is never suggested.
//
// READ-ONLY. It prints suggestions and changes no tab. Each suggestion comes
// with the ordinary verb that applies it (`tab close`, `snooze tab`, `snooze
// wake`), which is the same path the modal's Apply button takes. There is
// deliberately no `--apply`: closing tabs on a model's say-so, with nobody
// reading the list, is the one thing this feature must never do.
//
// Exit codes, for scripts: 0 with a list (an empty list is still an answer).
// A task that is off, a model that is unavailable, or a reply that was not
// usable exits non-zero with the reason on stderr.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import { formatTabCleanupSuggestions } from '../output/formatter';
import { tabCleanupApplyCommand, type TabCleanupResult } from '../../shared/tabCleanup';
import { failCommand, failFromError } from '../services/session-command';

/**
 * Above the app's own budget for the model (120s), so a slow model comes back
 * as the app's timeout verdict rather than the CLI giving up first.
 */
const SUGGEST_TIMEOUT_MS = 150_000;

interface SuggestCleanupOptions {
	json?: boolean;
}

export async function tabSuggestCleanup(options: SuggestCleanupOptions): Promise<void> {
	let reply: { success: boolean; result?: TabCleanupResult; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_tab_cleanup' },
				'local_models_tab_cleanup_result',
				SUGGEST_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success || !reply.result) {
		failCommand(reply.error || 'Tab cleanup failed', options.json);
	}
	const result = reply.result;

	if (options.json) {
		console.log(
			JSON.stringify(
				result.success
					? {
							...result,
							suggestions: result.suggestions.map((suggestion) => ({
								...suggestion,
								apply: tabCleanupApplyCommand(suggestion),
							})),
						}
					: result
			)
		);
		if (!result.success) exitWith(ExitCode.GeneralError);
		return;
	}
	if (!result.success) failCommand(result.error);
	console.log(formatTabCleanupSuggestions(result));
}
