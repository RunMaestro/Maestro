import type { AITab, BatchRunState, Session } from '../types';

/**
 * A session snapshot can only disqualify a retirement; a clear result is not
 * an acknowledgement. The caller must first freeze every target producer and
 * also inspect editors, other sessions' file tabs, and the main process.
 */
export function retirementSessionBlocker(
	session: Session,
	batch: BatchRunState | undefined,
	liveComposer: { aiValue: string; aiValueTabId: string | null; terminalValue: string },
	isActiveSession: boolean
): string | undefined {
	if (
		session.state === 'busy' ||
		session.state === 'waiting_input' ||
		session.state === 'connecting' ||
		session.aiTabs.some((tab) => tab.state === 'busy') ||
		(session.orphanedThinkingTabs?.length ?? 0) > 0 ||
		session.cliActivity
	)
		return 'agent activity';
	if (session.executionQueue.length || session.pendingSteers?.length) return 'queued work';
	if (batch?.isRunning || batch?.isStopping) return 'Auto Run';
	// A snooze can reopen tabs or deliver a prompt later, including a terminal.
	if (session.snoozedTabs?.length) return 'snoozed tabs';
	if (session.filePreviewTabs.length) return 'open file tabs';
	if (session.terminalDraftInput || (isActiveSession && liveComposer.terminalValue))
		return 'terminal draft';
	if (
		session.aiTabs.some((tab: AITab) =>
			Boolean(tab.inputValue || tab.stagedImages?.length || tab.pendingMentionHandoff)
		) ||
		(liveComposer.aiValue &&
			(session.aiTabs.some((tab) => tab.id === liveComposer.aiValueTabId) ||
				(isActiveSession && liveComposer.aiValueTabId === null)))
	)
		return 'AI draft';
	return undefined;
}
