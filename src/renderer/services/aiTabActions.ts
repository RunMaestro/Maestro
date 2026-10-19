/**
 * aiTabActions - the per-tab settings and marks a user changes on one AI tab,
 * addressed by an explicit agent and tab.
 *
 * Each action used to live inline in the control that runs it (the composer
 * toolbar, the tab handlers, the tab store), bound to the ACTIVE agent and its
 * active tab. That binding is right for an app window's own controls and wrong
 * for anything else: a tab popped out into a tab window is never its owner's
 * active tab (Tab Windows, D4), so the owner has to run the same action on the
 * tab the tab window names. So the action lives here once, with its target as
 * an argument, and both callers reach it:
 *
 * - the app window's handlers resolve the active agent and tab, then call it;
 * - the owner's tab window intent dispatcher (`tabWindowIntents.ts`) calls it
 *   with the agent and tab the intent names.
 *
 * Every write goes through the session store's id-addressed helpers, and a
 * target the store no longer holds is a no-op (a tab closed while the action
 * was in flight).
 */

import type { AITab, ThinkingMode } from '../types';
import { selectSessionById, updateAiTab, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { persistTabStarred } from '../utils/starredSessions';
import {
	cycleShowThinkingFields,
	permissionModeFields,
	setShowThinkingFields,
	toggleReadOnlyModeFields,
} from '../utils/tabHelpers';

/** The AI tab an action applies to. */
export interface AiTabTarget {
	sessionId: string;
	tabId: string;
}

/** The three permission modes the composer's pill cycles through. */
export type AiTabPermissionMode = 'full' | 'standard' | 'readonly';

/** The tab, when the store still holds it. */
function findAiTab(target: AiTabTarget): AITab | undefined {
	const session = selectSessionById(target.sessionId)(useSessionStore.getState());
	return session?.aiTabs.find((tab) => tab.id === target.tabId);
}

/** Write `patch(tab)` onto the target tab; nothing when the tab is gone. */
function patchAiTab(target: AiTabTarget, patch: (tab: AITab) => Partial<AITab>): boolean {
	if (!findAiTab(target)) return false;
	updateAiTab(target.sessionId, target.tabId, (tab) => ({ ...tab, ...patch(tab) }));
	return true;
}

/** Set the permission mode outright (the toolbar pill's cycle, the phone sheet). */
export function setAiTabPermissionMode(target: AiTabTarget, mode: AiTabPermissionMode): boolean {
	return patchAiTab(target, () => permissionModeFields(mode));
}

/** Flip read-only on or off (Cmd+R, the Prompt Composer). */
export function toggleAiTabReadOnlyMode(target: AiTabTarget): boolean {
	return patchAiTab(target, toggleReadOnlyModeFields);
}

/** Step the thinking display to its next mode (the toolbar pill, Cmd+Shift+K). */
export function cycleAiTabShowThinking(target: AiTabTarget): boolean {
	return patchAiTab(target, cycleShowThinkingFields);
}

/** Set the thinking display outright (the phone sheet names a mode). */
export function setAiTabShowThinking(target: AiTabTarget, mode: ThinkingMode): boolean {
	return patchAiTab(target, (tab) => setShowThinkingFields(tab, mode));
}

/** Flip "Save to History" for the tab. */
export function toggleAiTabSaveToHistory(target: AiTabTarget): boolean {
	return patchAiTab(target, (tab) => ({ saveToHistory: !tab.saveToHistory }));
}

/** Flip Enter-to-send for the tab; an unset tab starts from the global default. */
export function toggleAiTabEnterToSend(target: AiTabTarget): boolean {
	const globalDefault = useSettingsStore.getState().enterToSendAI;
	return patchAiTab(target, (tab) => ({ enterToSend: !(tab.enterToSend ?? globalDefault) }));
}

/** Set the tab's model override; empty or undefined falls back to the agent's model. */
export function setAiTabModel(target: AiTabTarget, model: string | undefined): boolean {
	return patchAiTab(target, () => ({ customModel: model || undefined }));
}

/** Set the tab's effort override; empty or undefined falls back to the agent's effort. */
export function setAiTabEffort(target: AiTabTarget, effort: string | undefined): boolean {
	return patchAiTab(target, () => ({ customEffort: effort || undefined }));
}

/**
 * Star or unstar the tab's conversation. Only a tab with a provider session
 * can be starred: the star is saved with that session, so it outlives the tab.
 */
export function setAiTabStarred(target: AiTabTarget, starred: boolean): boolean {
	const session = selectSessionById(target.sessionId)(useSessionStore.getState());
	const tab = session?.aiTabs.find((t) => t.id === target.tabId);
	if (!session || !tab?.agentSessionId) return false;
	persistTabStarred(session, tab, starred);
	return patchAiTab(target, () => ({ starred }));
}

/** Mark the tab unread ("Mark as Unread"). */
export function markAiTabUnread(target: AiTabTarget): boolean {
	return patchAiTab(target, () => ({ hasUnread: true }));
}
