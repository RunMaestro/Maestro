/**
 * Side questions (`/btw <question>`): ask the tab's own model about the
 * conversation without adding to it.
 *
 * The main process resumes the tab's provider session as a throwaway fork, with
 * tools off, so the question runs at once even while the tab is mid-turn (it is
 * never queued) and neither the question nor the answer lands in the tab's
 * transcript or its provider session. The answer shows on a card above the
 * composer, driven by `sideQuestionStore`.
 *
 * `maestro-cli ask <agent> "<question>" --btw` reaches the same function, so a
 * question asked from a script shows the same card and gets the same answer.
 *
 * A hosted agent's tab lives on its Federation host, so the host forks its own
 * tab (`askMirrorSideQuestion()`, the same `ask --btw` path) and the answer
 * draws on the same card here. A tab kept from before the move, which the host
 * lacks, forks over the record's SSH remote as an SSH agent's tab does. Only the
 * transport differs.
 */

import type { Session } from '../types';
import { generateId } from '../utils/ids';
import { logger } from '../utils/logger';
import { codifyTurnSettings } from '../utils/providerTabSessions';
import { useSessionStore } from '../stores/sessionStore';
import { sideQuestionKey, useSideQuestionStore } from '../stores/sideQuestionStore';
import { hostedTargetOf, isHostTab } from './hostedTurns';
import { askMirrorSideQuestion } from './peerMirror';

export interface SideQuestionOutcome {
	success: boolean;
	answer?: string;
	error?: string;
	tabId?: string;
	agentName?: string;
}

/**
 * Ask `question` about the conversation in `tabId` of `session`. Resolves with
 * the outcome (also written to the card); never throws.
 */
export async function askSideQuestion(options: {
	session: Session;
	tabId: string;
	question: string;
}): Promise<SideQuestionOutcome> {
	const { session, tabId } = options;
	const question = options.question.trim();
	const requestId = generateId();
	const tab = session.aiTabs?.find((t) => t.id === tabId);
	// The tab's model and effort, codified now: switching the model while the
	// question is in flight applies to the next one, as it does for chat turns.
	const { turnModel, turnEffort } = codifyTurnSettings(tab, session);

	const store = useSideQuestionStore.getState();
	store.beginSideQuestion({ requestId, sessionId: session.id, tabId, question, model: turnModel });

	const fail = (error: string): SideQuestionOutcome => {
		useSideQuestionStore.getState().failSideQuestion(requestId, error);
		return { success: false, error, tabId, agentName: session.name };
	};

	if (!question) return fail('Type a question after /btw.');

	// A host tab is forked by its host. A tab kept from before the move has no conversation there,
	// so its own provider session is forked over the record's SSH remote, exactly as an SSH
	// agent's is: a fork only reads the conversation and never writes it.
	const hosted = hostedTargetOf(session);
	if (hosted && isHostTab(hosted, tabId)) {
		const reply = await askMirrorSideQuestion(hosted.peerId, hosted.agentId, tabId, question);
		if ('error' in reply) return fail(reply.error);
		if (!reply.answer) return fail('No answer came back.');
		useSideQuestionStore.getState().resolveSideQuestion(requestId, reply.answer);
		return { success: true, answer: reply.answer, tabId, agentName: session.name };
	}

	try {
		const result = await window.maestro.sideQuestion.ask({
			question,
			ownerAgentId: session.id,
			agentType: session.toolType,
			cwd: session.cwd,
			agentSessionId: tab?.agentSessionId ?? undefined,
			sessionSshRemoteConfig: session.sessionSshRemoteConfig,
			customPath: session.customPath,
			customArgs: session.customArgs,
			customEnvVars: session.customEnvVars,
			customModel: turnModel,
			customEffort: turnEffort,
		});
		if (!result.success || !result.answer) {
			return fail(result.error || 'No answer came back.');
		}
		useSideQuestionStore.getState().resolveSideQuestion(requestId, result.answer);
		return { success: true, answer: result.answer, tabId, agentName: session.name };
	} catch (error) {
		logger.error('[sideQuestion] Request failed', undefined, error);
		return fail(error instanceof Error ? error.message : String(error));
	}
}

/** Close a tab's side-question card. A reply still in flight is dropped. */
export function dismissSideQuestion(sessionId: string, tabId: string): void {
	useSideQuestionStore.getState().clearSideQuestion(sideQuestionKey(sessionId, tabId));
}

/**
 * The `maestro-cli ask --btw` entry point: resolve the agent and tab (the
 * agent's active tab unless one is named) and ask.
 */
export async function runRemoteSideQuestion(request: {
	targetSessionId: string;
	question: string;
	tabId?: string;
}): Promise<SideQuestionOutcome> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === request.targetSessionId);
	if (!session) return { success: false, error: `No agent with id ${request.targetSessionId}` };
	if (session.toolType !== 'claude-code') {
		return {
			success: false,
			error: `${session.name} cannot answer side questions (Claude Code agents only)`,
			agentName: session.name,
		};
	}
	const tabId = request.tabId ?? session.activeTabId;
	if (!tabId || !session.aiTabs?.some((t) => t.id === tabId)) {
		return {
			success: false,
			error: request.tabId ? `No AI tab ${request.tabId} on ${session.name}` : 'No AI tab to ask',
			agentName: session.name,
		};
	}
	return askSideQuestion({ session, tabId, question: request.question });
}
