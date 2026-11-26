/**
 * Changing an AI tab's thinking mode (`'off' | 'on' | 'sticky'`), the one write every control
 * goes through: the composer's Thinking pill, its shortcut, the command palette, the prompt
 * composer, and the phone options sheet.
 *
 * It writes the tab with the shared field patch (`setShowThinkingFields()`, which also drops the
 * stored reasoning when the mode goes off), then hands the mode to a hosted agent's host
 * (`updateHostedTab()`): the host decides what its process streams and what a sticky tab keeps
 * once the turn ends, so a mode held only in this window would show 'sticky' here while the host
 * runs the turn with thinking off. For a local or SSH agent the host step is a no-op.
 */

import type { ThinkingMode } from '../types';
import { nextThinkingMode } from '../../shared/types';
import { selectSessionById, updateAiTab, useSessionStore } from '../stores/sessionStore';
import { setShowThinkingFields } from '../utils/tabHelpers';
import { updateHostedTab } from './hostedTurns';

/** Set one tab's thinking mode, here and on its host. A tab that is not there is left alone. */
export function setTabThinkingMode(sessionId: string, tabId: string, mode: ThinkingMode): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session?.aiTabs.some((tab) => tab.id === tabId)) return;
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, ...setShowThinkingFields(tab, mode) }));
	updateHostedTab(session, tabId, { thinking: mode });
}

/** Step one tab to its next thinking mode (`nextThinkingMode()`), here and on its host. */
export function cycleTabThinkingMode(sessionId: string, tabId: string): void {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	const tab = session?.aiTabs.find((candidate) => candidate.id === tabId);
	if (!tab) return;
	setTabThinkingMode(sessionId, tabId, nextThinkingMode(tab.showThinking));
}
