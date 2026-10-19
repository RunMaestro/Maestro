/**
 * tabWindowIntentSender - how a tab window hands an action to its owner window
 * (Tab Windows, D2).
 *
 * A tab window writes no `Session` and starts no process (D1). Most of its
 * controls know the agent and tab they act on and send their intent directly.
 * A few shared services run deep inside reused components that know neither
 * (the shell card's Stop, a `maestro://` link, a link opened in Maestro's
 * browser); in a tab window those services call {@link sendShownTabIntent},
 * which addresses the intent to the AI tab the window shows. That is the same
 * thing the service does in an app window, where it acts on the active agent
 * and its active tab: in a tab window the store holds the window's one agent as
 * its active agent, with its shown AI tab as the active tab.
 */

import type {
	TabWindowIntent,
	TabWindowIntentKind,
	TabWindowIntentPayloads,
} from '../../shared/tabWindowTypes';
import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import { isTabWindow } from '../utils/runtimeContext';
import { logger } from '../utils/logger';

/**
 * An intent before its envelope: what a control knows (the kind and its
 * payload), without the agent and tab the sender addresses it to.
 */
export type TabWindowIntentBody = TabWindowIntent extends infer I
	? I extends unknown
		? Omit<I, 'agentId' | 'tabRef'>
		: never
	: never;

/** Send one intent to the owner window. False where there is no tab windows API. */
export function sendTabWindowIntent(intent: TabWindowIntent): boolean {
	const api = window.maestro?.tabWindows;
	if (!api) return false;
	api.sendIntent(intent);
	return true;
}

/**
 * In a tab window, send `kind` for the AI tab the window shows. Returns true
 * in a tab window, where the action is always the owner's: the caller must not
 * run it here too (with no agent or AI tab shown yet it is dropped, logged).
 * Returns false outside a tab window, where the caller runs it itself.
 */
export function sendShownTabIntent<K extends TabWindowIntentKind>(
	kind: K,
	payload: TabWindowIntentPayloads[K]
): boolean {
	if (!isTabWindow()) return false;
	const session = selectActiveSession(useSessionStore.getState());
	if (!session?.activeTabId) {
		logger.warn(`Dropped a ${kind} action: the tab window shows no AI tab yet`, '[TabWindows]');
		return true;
	}
	sendTabWindowIntent({
		kind,
		agentId: session.id,
		tabRef: { type: 'ai', id: session.activeTabId },
		...payload,
	} as TabWindowIntent);
	return true;
}
