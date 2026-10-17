/**
 * AI command mode: the request/confirm/run cycle.
 *
 * AI command mode (the `!!` rung of the composer's bang ladder) asks a model to
 * turn a plain-English request into one shell command line. By default that is
 * the tab's OWN provider at its current model and effort; the `ai-command`
 * Local Models assignment can move it to a local model or an endpoint. Nothing
 * runs until the user confirms.
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
import type { LocalModelEndpoint } from '../../shared/local-models/endpoints';
import {
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
	type LocalModelAssignments,
} from '../../shared/local-models/tasks';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * The model and effort the AI Command bar names for a request sent now.
 *
 * Which model answers is the `ai-command` Local Models assignment, so the label
 * follows it:
 *   - the default (`utility-agent`) is the tab's own provider, so the turn's
 *     codified model and effort are the answer;
 *   - a local model or an endpoint is named instead (`Qwen3 1.7B`,
 *     `qwen3:latest on Ollama`), with no effort: those sources have no effort
 *     ladder, and showing the tab's would credit a model that is not asked;
 *   - `off` names nothing, because no model is asked at all.
 *
 * Both the bar's draft state and `requestAiCommand` read it, so the label shown
 * before Enter is the one stamped onto the request.
 */
export function resolveAiCommandProvenance(
	turn: { turnModel?: string; turnEffort?: string },
	assignments: LocalModelAssignments | undefined,
	endpoints: readonly LocalModelEndpoint[]
): { model?: string; effort?: string } {
	const assignment = resolveLocalModelAssignment(assignments, 'ai-command');
	if (assignment.type === 'utility-agent') {
		return { model: turn.turnModel, effort: turn.turnEffort };
	}
	const source = localModelAssignmentSourceLabel(assignment, endpoints);
	return source ? { model: source } : {};
}
import { getClaudeTokenSourceFields } from '../../shared/claudeTokenMode';

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

	const { localModelAssignments, localModelEndpoints } = useSettingsStore.getState();
	const provenance = resolveAiCommandProvenance(
		{ turnModel, turnEffort },
		localModelAssignments,
		localModelEndpoints
	);

	useAiCommandStore.getState().beginAiCommand({
		requestId,
		sessionId: session.id,
		tabId,
		request,
		model: provenance.model,
		effort: provenance.effort,
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
			claudeTokenSource: getClaudeTokenSourceFields(session),
			recentCommands,
		});

		if (result.success && result.command) {
			useAiCommandStore.getState().resolveAiCommand(requestId, result.command, {
				explanation: result.explanation,
				producedBy: result.producedBy,
			});
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
