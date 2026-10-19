/**
 * tabWindowActions - the one renderer path that pops a tab out into its agent's
 * tab window and docks it back (Tab Windows, TW-11, TW-12).
 *
 * Every entry point calls this module and nothing else: the chip menu item, the
 * Cmd+K commands, the shortcut, the tab window's Dock button, and the
 * `maestro-cli tab pop-out` / `tab dock` handlers. The rules live here once:
 *
 * - The web-desktop build has no OS windows, so nothing is offered or run
 *   there (TW-13).
 * - A hidden consult tab never pops out (TW-14). Main refuses it too, but its
 *   store can lag one debounced write, so the renderer checks first.
 * - A tab tiled into a group leaves the group first, as a standalone tab at
 *   the group's place (D6, `promotePaneToStandalone`). Its new strip slot is
 *   where it docks back to (TW-8).
 *
 * Pop-out writes the agent's `Session` (the group detach), so it runs only in
 * the window that owns the agent, never in a tab window (D1). Dock writes
 * nothing here and runs from either side.
 *
 * Refusals come back as the result's `error`; `popOutTab` and `dockTab` show
 * no toast, so the CLI path ({@link runRemoteTabWindowCommand}) can report the
 * same words. An IPC rejection is
 * reported to Sentry and returned the same way. The UI entry points call the
 * `...FromUi` forms, which show a refusal as a toast.
 */

import type { Session } from '../types';
import type {
	TabWindowDockResult,
	TabWindowPopOutOptions,
	TabWindowPopOutResult,
	TabWindowTabRef,
} from '../../shared/tabWindowTypes';
import {
	resolveTabIdInSessions,
	type TabWindowCommandRequest,
	type TabWindowCommandResult,
} from '../../shared/tabWindowCommands';
import { isSingleTabRef } from '../../shared/unifiedTabRef';
import { notifyToast } from '../stores/notificationStore';
import { selectSessionById, updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { promotePaneToStandalone, resolveActiveTabRef } from '../utils/panelLayout';
import { findGroupPaneForTab } from '../utils/tabHelpers/groupFocus';
import { isAiTabHidden } from '../utils/unifiedTabOrderUtils';
import { isTabWindow, isWebDesktop } from '../utils/runtimeContext';
import { ipcErrorMessage } from '../utils/ipcErrorMessage';
import { captureException } from '../utils/sentry';
import { sessionHasTab } from './tabWindowNavigation';

/** Why tab windows do not exist in this renderer (TW-13). */
const UNAVAILABLE_ERROR = 'Tab windows are only available in the desktop app';

/**
 * Whether this renderer can pop tabs out at all: the desktop build, with the
 * tab windows API, and not itself a tab window. Entry points hide their item
 * when this is false.
 */
export function canUseTabWindows(): boolean {
	return !isWebDesktop() && !isTabWindow() && !!window.maestro?.tabWindows;
}

/**
 * Why `ref` of `session` cannot pop out, or null when it can. Covers the tab
 * itself only; {@link canUseTabWindows} covers the renderer. Entry points use
 * it to hide their item, and {@link popOutTab} refuses with the same words.
 */
export function popOutRefusal(session: Session, ref: TabWindowTabRef): string | null {
	if (!sessionHasTab(session, ref)) return 'The agent has no such tab';
	if (ref.type === 'ai') {
		const tab = session.aiTabs.find((t) => t.id === ref.id);
		if (tab && isAiTabHidden(tab)) return 'A hidden consult tab cannot be popped out';
	}
	return null;
}

/**
 * The tab the keyboard shortcut and the Cmd+K command pop out: the shown tab,
 * or the focused pane of a shown tiled group (`resolveActiveTabRef`). Null when
 * this renderer has no tab windows or that tab cannot pop out, which is also
 * when those entry points stay hidden or inert.
 */
export function resolvePopOutTarget(session: Session): TabWindowTabRef | null {
	if (!canUseTabWindows()) return null;
	const ref = resolveActiveTabRef(session);
	if (!ref || !isSingleTabRef(ref)) return null;
	return popOutRefusal(session, ref) ? null : ref;
}

/**
 * Detach `ref` from the tiled group that holds it, placing it right after the
 * group in the strip (D6). A no-op for a standalone tab.
 */
function detachFromGroup(agentId: string, ref: TabWindowTabRef): void {
	const session = selectSessionById(agentId)(useSessionStore.getState());
	if (!session || !findGroupPaneForTab(session, ref.type, ref.id)) return;
	updateSessionWith(agentId, (s) => {
		const pane = findGroupPaneForTab(s, ref.type, ref.id);
		if (!pane) return s;
		const order = s.unifiedTabOrder ?? [];
		const groupIndex = order.findIndex((r) => r.type === 'group' && r.id === pane.groupId);
		const insertIndex = groupIndex < 0 ? order.length : groupIndex + 1;
		return promotePaneToStandalone(s, pane.groupId, pane.leafId, insertIndex);
	});
}

function reportRejection(error: unknown, operation: string, ref: TabWindowTabRef): string {
	captureException(error instanceof Error ? error : new Error(String(error)), {
		extra: { operation: `tabWindows.${operation}`, tabType: ref.type },
	});
	return ipcErrorMessage(error);
}

/**
 * Pop one of `agentId`'s tabs out into the agent's tab window, opening it when
 * the agent has none (TW-4). The window is raised and the tab shown unless
 * `background` is set. Resolves with main's answer, or a refusal.
 */
export async function popOutTab(
	agentId: string,
	ref: TabWindowTabRef,
	options: TabWindowPopOutOptions = {}
): Promise<TabWindowPopOutResult> {
	if (!canUseTabWindows()) return { poppedOut: false, error: UNAVAILABLE_ERROR };
	const session = selectSessionById(agentId)(useSessionStore.getState());
	if (!session) return { poppedOut: false, error: 'Agent not found' };
	const refusal = popOutRefusal(session, ref);
	if (refusal) return { poppedOut: false, error: refusal };

	detachFromGroup(agentId, ref);
	try {
		return await window.maestro.tabWindows.popOut(agentId, ref, {
			background: options.background === true,
		});
	} catch (error) {
		return { poppedOut: false, error: reportRejection(error, 'popOut', ref) };
	}
}

/**
 * Return a popped tab to its owner window's strip, at the slot it left (TW-8).
 * Main closes the tab window when this was its last tab. Resolves with main's
 * answer, or a refusal.
 */
export async function dockTab(agentId: string, ref: TabWindowTabRef): Promise<TabWindowDockResult> {
	const api = window.maestro?.tabWindows;
	if (isWebDesktop() || !api) return { docked: false, error: UNAVAILABLE_ERROR };
	try {
		return await api.dock(agentId, ref);
	} catch (error) {
		return { docked: false, error: reportRejection(error, 'dock', ref) };
	}
}

function toastRefusal(error: string): void {
	notifyToast({ color: 'red', title: 'Tab Window', message: error });
}

/**
 * {@link popOutTab} for a UI entry point (chip menu, Cmd+K, shortcut): the
 * window is raised, and a refusal is shown as a toast.
 */
export async function popOutTabFromUi(agentId: string, ref: TabWindowTabRef): Promise<void> {
	const result = await popOutTab(agentId, ref);
	if (!result.poppedOut) toastRefusal(result.error);
}

/** {@link dockTab} for a UI entry point: a refusal is shown as a toast. */
export async function dockTabFromUi(agentId: string, ref: TabWindowTabRef): Promise<void> {
	const result = await dockTab(agentId, ref);
	if (!result.docked) toastRefusal(result.error);
}

/**
 * The tabs `windowId` holds now; empty when the window is gone (a dock of its
 * last tab). Undefined when the list call fails: the verb itself already ran,
 * so the failure is reported to Sentry and the answer goes out without it.
 */
async function tabRefsOfWindow(windowId: string): Promise<TabWindowTabRef[] | undefined> {
	try {
		const windows = await window.maestro.tabWindows.list();
		return windows.find((info) => info.windowId === windowId)?.tabRefs ?? [];
	} catch (error) {
		captureException(error instanceof Error ? error : new Error(String(error)), {
			extra: { operation: 'tabWindows.list' },
		});
		return undefined;
	}
}

/**
 * Answer `maestro-cli tab pop-out` and `tab dock` (the `tab_window_command`
 * message) in the agent's owner window, through {@link popOutTab} and
 * {@link dockTab}. Main has already resolved the agent; the tab id (exact or a
 * unique prefix, any tab kind) is resolved here against the live session, so
 * a tab the sessions store has not caught up with yet still resolves. `list`
 * is answered by main from the registry and never reaches the renderer.
 */
export async function runRemoteTabWindowCommand(
	request: TabWindowCommandRequest
): Promise<TabWindowCommandResult> {
	if (request.action === 'list') {
		return { success: false, error: 'Tab windows are listed by the main process' };
	}
	const agentId = request.sessionId;
	if (!agentId || !request.tabId) {
		return { success: false, error: 'An agent id and a tab id are required' };
	}
	const session = selectSessionById(agentId)(useSessionStore.getState());
	if (!session) return { success: false, error: `Agent not found: ${agentId}` };
	const found = resolveTabIdInSessions([session], request.tabId);
	if (!found.ok) return { success: false, error: found.error };
	const { tabRef } = found.resolved;

	if (request.action === 'pop-out') {
		const result = await popOutTab(agentId, tabRef, { background: request.background === true });
		if (!result.poppedOut) return { success: false, error: result.error };
		return {
			success: true,
			agentId,
			tabRef,
			windowId: result.windowId,
			created: result.created,
			tabRefs: await tabRefsOfWindow(result.windowId),
		};
	}

	const result = await dockTab(agentId, tabRef);
	if (!result.docked) return { success: false, error: result.error };
	return {
		success: true,
		agentId,
		tabRef,
		windowId: result.windowId,
		tabRefs: await tabRefsOfWindow(result.windowId),
	};
}
