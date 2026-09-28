/**
 * toastClickActions - the single place that turns a toast's data-driven
 * `clickAction` into navigation.
 *
 * A toast fired from outside the renderer (CLI, Cue, the web bridge) cannot
 * carry a callback, so it carries a `ToastClickAction` instead
 * (`shared/toastClickAction.ts`). This module is the other half of that
 * contract: one exported dispatcher, so every producer of a toast gets the
 * same click behavior and adding a kind is a change in exactly two files.
 *
 * Each kind lands the user on a different tab type, and the main window renders
 * exactly ONE tab type by precedence (terminal > file > browser > ai), which is
 * why every focus here goes through the `*TabFocusFields` helpers rather than
 * setting an active-tab id by hand - see `utils/tabFocusFields.ts`.
 */

import type { ToastClickAction } from '../../shared/toastClickAction';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useFileExplorerStore } from '../stores/fileExplorerStore';
import { notifyToast } from '../stores/notificationStore';
import { resolveTerminalTab } from '../utils/terminalTabHelpers';
import { browserTabFocusFields, terminalTabFocusFields } from '../utils/tabFocusFields';
import { openUrl } from '../utils/openUrl';
import { logger } from '../utils/logger';

export interface ToastClickActionHandlers {
	/**
	 * App's session-jump callback (`handleToastSessionClick`). Used for the
	 * `jump-session` kind so the jump keeps whatever extra behavior App attaches
	 * to it. Omitted in contexts that have no such callback (tests, headless).
	 */
	onSessionClick?: (sessionId: string, tabId?: string) => void;
}

/**
 * Bring an agent on screen. Mirrors the housekeeping `handleToastSessionClick`
 * does before switching: the Document Graph is a full-screen overlay, so
 * leaving it open would park it on top of the tab we just focused and swallow
 * every click meant for it.
 */
function switchToSession(sessionId: string): void {
	const fileExplorer = useFileExplorerStore.getState();
	if (fileExplorer.isGraphViewOpen) {
		fileExplorer.closeGraphView();
	}
	useSessionStore.getState().setActiveSessionId(sessionId);
}

/** Tell the user why a click went nowhere instead of failing silently. */
function reportMiss(title: string, message: string): void {
	notifyToast({ color: 'yellow', title, message });
}

/**
 * Run a toast's click action.
 *
 * Every kind is best-effort: when the target no longer exists (the terminal tab
 * was closed, the agent was deleted) the user still gets taken as close as we
 * can get, plus a toast saying what was missing. A click that does nothing at
 * all reads as a broken app.
 */
export function dispatchToastClickAction(
	action: ToastClickAction,
	handlers: ToastClickActionHandlers = {}
): void {
	switch (action.kind) {
		case 'jump-session':
			handlers.onSessionClick?.(action.sessionId, action.tabId);
			return;

		case 'open-file':
			// Reuse the existing CLI/remote file-open path. The listener
			// (useAppRemoteEventListeners) switches to the target agent, reads the
			// file, and opens it in a preview tab.
			window.dispatchEvent(
				new CustomEvent('maestro:openFileTab', {
					detail: { sessionId: action.sessionId, filePath: action.path },
				})
			);
			return;

		case 'open-terminal': {
			const sessions = useSessionStore.getState().sessions;
			const resolved = resolveTerminalTab(sessions, action.sessionId, action.tabRef);
			if (!resolved) {
				// The agent may still be there even when the tab is not, so take the
				// user to it rather than dropping the click on the floor.
				if (sessions.some((s) => s.id === action.sessionId)) {
					switchToSession(action.sessionId);
					reportMiss(
						'Terminal tab not found',
						action.tabRef
							? `No terminal tab matching "${action.tabRef}" is open. Switched to the agent instead.`
							: 'That agent has no terminal tab open. Switched to the agent instead.'
					);
				} else {
					reportMiss('Agent not found', 'The agent this notification points at is gone.');
				}
				return;
			}
			switchToSession(resolved.session.id);
			updateSessionWith(resolved.session.id, (s) => ({
				...s,
				...terminalTabFocusFields(resolved.tab.id),
			}));
			return;
		}

		case 'open-browser': {
			const sessions = useSessionStore.getState().sessions;
			const session = sessions.find((s) => s.id === action.sessionId);
			if (!session) {
				reportMiss('Agent not found', 'The agent this notification points at is gone.');
				return;
			}
			const existing = action.tabId
				? (session.browserTabs || []).find((t) => t.id === action.tabId)
				: undefined;
			if (existing) {
				switchToSession(session.id);
				updateSessionWith(session.id, (s) => ({ ...s, ...browserTabFocusFields(existing.id) }));
				return;
			}
			if (action.url) {
				// No `background` flag: a click is the user asking to be taken there.
				// The listener creates the tab, focuses it, and switches agent.
				window.dispatchEvent(
					new CustomEvent('maestro:openBrowserTab', {
						detail: { sessionId: session.id, url: action.url },
					})
				);
				return;
			}
			switchToSession(session.id);
			reportMiss(
				'Browser tab not found',
				'That browser tab has been closed. Switched to the agent instead.'
			);
			return;
		}

		case 'open-url':
			openUrl(action.url);
			return;

		default: {
			// Exhaustiveness guard: a new kind added to the shared type without a
			// case here would otherwise be a silent no-op click.
			const unhandled: never = action;
			logger.warn('Unhandled toast click action', 'Toast', { action: unhandled });
		}
	}
}
