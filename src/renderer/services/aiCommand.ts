/**
 * AI command mode: the request/confirm/run cycle.
 *
 * AI command mode (the `!!` rung of the composer's bang ladder) asks the tab's
 * OWN model, at its current model and effort, to turn a plain-English request
 * into one shell command line. Nothing runs until the user confirms.
 *
 * The accepted command goes back through `dispatchShellCommand`, the same entry
 * point a typed `!` command uses, so it lands in the transcript and in recall
 * history exactly as if the user had typed it themselves. That is the whole
 * point of the feature: the AI writes the command, the shell path stays one
 * path.
 */

import type { Session } from '../types';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';
import { dispatchShellCommand, resolveCommandCwd } from './shellCommand';
import { aiCommandKey, useAiCommandStore, type AiCommandEntry } from '../stores/aiCommandStore';
import { codifyTurnSettings } from '../utils/providerTabSessions';
import { collectRecentCommands } from '../../shared/aiCommand';

/**
 * Ask the model for a command line for `request`, in the context of `session`.
 *
 * Fire and forget: everything the user sees is driven off `aiCommandStore`, and
 * a reply that arrives after the user dismissed the request is dropped by the
 * store's request-id check rather than resurrecting a card they closed.
 */
export async function requestAiCommand(options: {
	session: Session;
	tabId: string;
	request: string;
}): Promise<void> {
	const { session, tabId, request } = options;
	const requestId = generateId();

	const tab = session.aiTabs?.find((t) => t.id === tabId);
	// Same resolution the chat spawn uses, so the suggestion runs under exactly
	// the model and effort the composer's pills advertise. Settings are codified
	// here, at send time, for the same reason a chat turn codifies them: changing
	// the model while the suggestion is in flight applies to the NEXT request.
	const { turnModel, turnEffort } = codifyTurnSettings(tab, session);

	// Mined from THIS tab's transcript, so "actually just the count" refines the
	// command the user is looking at. Read here rather than in the main process:
	// the transcript is renderer state, and it is the only record that keeps a
	// tab's commands in true chronological order.
	const recentCommands = collectRecentCommands(tab?.logs ?? []);

	useAiCommandStore.getState().beginAiCommand({
		requestId,
		sessionId: session.id,
		tabId,
		request,
		model: turnModel,
		effort: turnEffort,
	});

	try {
		const result = await window.maestro.aiCommand.suggest({
			request,
			agentType: session.toolType,
			cwd: resolveCommandCwd(session),
			isGitRepo: session.isGitRepo,
			sessionSshRemoteConfig: session.sessionSshRemoteConfig,
			sshRemoteName: session.sshRemote?.name,
			customPath: session.customPath,
			customArgs: session.customArgs,
			customEnvVars: session.customEnvVars,
			customModel: turnModel,
			customEffort: turnEffort,
			recentCommands,
		});

		if (result.success && result.command) {
			useAiCommandStore.getState().resolveAiCommand(requestId, result.command);
		} else {
			useAiCommandStore
				.getState()
				.failAiCommand(requestId, result.error || 'No command came back.');
		}
	} catch (error) {
		logger.error('[aiCommand] Suggestion request failed', undefined, error);
		useAiCommandStore
			.getState()
			.failAiCommand(requestId, error instanceof Error ? error.message : String(error));
	}
}

/**
 * Run the proposed command and clear the card.
 *
 * No-op unless the entry is actually holding a proposal - the confirmation keys
 * are live while the spinner is up too, and "Enter" during thinking must not
 * run an empty string.
 */
export function acceptAiCommand(session: Session, entry: AiCommandEntry): void {
	if (entry.status !== 'proposed' || !entry.command) return;

	useAiCommandStore.getState().clearAiCommand(aiCommandKey(entry.sessionId, entry.tabId));

	dispatchShellCommand({
		session,
		tabId: entry.tabId,
		command: entry.command,
		// Carried onto the card so the request outlives the proposal: it is what
		// the card shows as provenance, and what a later follow-up refines.
		request: entry.request,
	}).catch((error) => {
		logger.error('[aiCommand] Accepted command failed to run', undefined, error);
	});
}

/**
 * Dismiss the card and hand the original request back to the composer.
 *
 * Returning the text rather than discarding it is what makes "no" cheap: the
 * usual reason to decline is that the request was underspecified, and the user
 * is one edit away from a better one.
 */
export function dismissAiCommand(entry: AiCommandEntry): string {
	useAiCommandStore.getState().clearAiCommand(aiCommandKey(entry.sessionId, entry.tabId));
	return entry.request;
}
