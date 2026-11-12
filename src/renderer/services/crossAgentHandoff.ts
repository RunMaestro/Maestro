/**
 * crossAgentHandoff - forward a turn's final answer to the agents the user
 * asked to hand it to.
 *
 * "Look into MNQ and feed whatever we learn over to @Kensho" names an ORDER:
 * this agent works first, and @Kensho gets the result. Consulting @Kensho at
 * send time (the parallel path) hands it a question with nothing in it yet, and
 * the findings it was promised never reach it. So a hand-off is armed on the
 * source tab when the message dispatches and released when that turn ends:
 *
 * 1. Dispatch (`armMentionHandoff`) stamps `pendingMentionHandoff` on the tab
 *    and the turn's prompt gets `cross-agent-handoff-pending`, so the agent
 *    writes a final answer that stands on its own.
 * 2. The turn's process exits (`useAgentExitListener` calls
 *    `releaseMentionHandoff`). A clean exit sends the user's message plus the
 *    turn's final answer to every target, through the same consult pipeline a
 *    typed mention uses, flagged as a hand-off so the target is told what it
 *    is receiving. A failed turn sends nothing and says so in the transcript.
 * 3. Stop clears it (`dropMentionHandoffs`): Stop means stop, and forwarding a
 *    half-finished answer would act on the user's behalf after they said no.
 *
 * One way by design: the target's reply lands on the source tab as an
 * attributed bubble, and no follow-up turn is sent back to the source agent.
 */

import type { ConsultHoldTarget, LogEntry, MentionHandoff } from '../types';
import { updateAiTab, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { sendCrossAgentRequest } from '../hooks/agent/useCrossAgentDispatch';
import { isSelfContainedCard } from '../utils/logEntries';
import { generateId } from '../utils/ids';
import { formatConsultedAgentNames } from './crossAgentConsultHold';

/** The turn's answer, and the transcript that led up to it. */
export interface HandoffTurn {
	/** The turn's final answer: its last assistant entry with text. */
	answer: string;
	/** Everything before the turn's user message, for the target's context. */
	priorLogs: LogEntry[];
}

/** Assistant output that can carry the answer (cards own their own text). */
function isAnswerEntry(entry: LogEntry): boolean {
	return (
		(entry.source === 'ai' || entry.source === 'stdout') &&
		!isSelfContainedCard(entry) &&
		!!entry.text?.trim()
	);
}

/**
 * Split a finished turn out of a tab's logs. The turn starts at the LAST user
 * entry; its answer is the last assistant entry after that, which is what the
 * pending note told the agent to make stand on its own (earlier entries are
 * narration between tool calls). Returns null when the turn produced no answer.
 */
export function collectHandoffTurn(logs: LogEntry[]): HandoffTurn | null {
	let userIndex = -1;
	for (let i = logs.length - 1; i >= 0; i--) {
		if (logs[i].source === 'user') {
			userIndex = i;
			break;
		}
	}
	for (let i = logs.length - 1; i > userIndex; i--) {
		if (isAnswerEntry(logs[i])) {
			return {
				answer: logs[i].text.trim(),
				priorLogs: userIndex >= 0 ? logs.slice(0, userIndex) : [],
			};
		}
	}
	return null;
}

/** Arm a hand-off on the tab whose turn is about to run. */
export function armMentionHandoff(sessionId: string, tabId: string, handoff: MentionHandoff): void {
	if (handoff.targets.length === 0) return;
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, pendingMentionHandoff: handoff }));
}

/** Clear every armed hand-off on an agent (Stop is agent-level). */
export function dropMentionHandoffs(sessionId: string): void {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session?.aiTabs.some((t) => t.pendingMentionHandoff)) return;
	updateSessionWith(sessionId, (s) => ({
		...s,
		aiTabs: s.aiTabs.map((t) =>
			t.pendingMentionHandoff ? { ...t, pendingMentionHandoff: undefined } : t
		),
	}));
}

/** A system note on the source tab saying why a hand-off did not go out. */
function noteSkippedHandoff(
	sessionId: string,
	tabId: string,
	targets: ConsultHoldTarget[],
	why: string
) {
	const names = formatConsultedAgentNames(targets.map((t) => t.targetAgentName));
	const entry: LogEntry = {
		id: generateId(),
		timestamp: Date.now(),
		source: 'system',
		text: `Nothing was handed off to ${names}: ${why}`,
	};
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, logs: [...tab.logs, entry] }));
}

/**
 * Release the hand-off armed on a tab whose turn just ended. `failed` is a turn
 * that did not end cleanly (non-zero exit): its answer is not what the user
 * asked to pass on, so nothing is sent. A no-op when nothing is armed, which
 * makes a second exit event for the same turn harmless.
 */
export function releaseMentionHandoff(
	sessionId: string,
	tabId: string,
	opts: { failed: boolean }
): void {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const tab = session?.aiTabs.find((t) => t.id === tabId);
	const handoff = tab?.pendingMentionHandoff;
	if (!session || !tab || !handoff) return;

	// Clear first, so a send that throws cannot leave it armed for the next turn.
	updateAiTab(sessionId, tabId, (t) => ({ ...t, pendingMentionHandoff: undefined }));

	if (opts.failed) {
		noteSkippedHandoff(sessionId, tabId, handoff.targets, 'the turn did not finish.');
		return;
	}
	const turn = collectHandoffTurn(tab.logs);
	if (!turn) {
		noteSkippedHandoff(sessionId, tabId, handoff.targets, 'the turn produced no answer.');
		return;
	}

	for (const target of handoff.targets) {
		sendCrossAgentRequest({
			sourceSessionId: session.id,
			sourceAgentName: session.name,
			sourceTabId: tabId,
			targetSessionId: target.targetSessionId,
			userPrompt: handoff.message,
			sourceLogs: turn.priorLogs,
			sourceCwd: session.cwd,
			handoffAnswer: turn.answer,
		});
	}
}
