/**
 * Tab Windows IPC Handlers
 *
 * The `tabWindows:*` request channels (pop out, dock, focus, list, the calling
 * tab window's state) and the two fire-and-forget relay channels between an
 * agent's owner window and its tab window. A thin transport over
 * `src/main/tab-window-service.ts`, which holds the logic so the CLI path runs
 * the same code.
 *
 * None of these channels is on the web-desktop bridge allow-list
 * (`web-server/handlers/bridgeDenyList.ts`): a browser client has no OS
 * windows (TW-13).
 */

import { BrowserWindow, ipcMain } from 'electron';
import type Store from 'electron-store';
import type { WindowManager } from '../../app-lifecycle/window-manager';
import type { SessionsData } from '../../stores/types';
import {
	dockTab,
	focusTabWindowTab,
	isStoredAiTabHidden,
	listTabWindows,
	popOutTab,
	relayTabWindowIntent,
	relayTabWindowPatch,
	reorderTabWindow,
} from '../../tab-window-service';
import { reroutePermissionRequests } from '../../permission-relay';
import { registerTerminalHandoffHandlers } from '../../terminal-handoff';
import { requireDependency, withIpcErrorLogging } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import { toTabWindowInfo, type WindowRegistry } from '../../window-registry';
import { resolveCallingWindow } from './windows';
import {
	TAB_WINDOW_CHANNELS,
	type TabWindowDockResult,
	type TabWindowFocusResult,
	type TabWindowInfo,
	type TabWindowPopOutOptions,
	type TabWindowPopOutResult,
	type TabWindowReorderResult,
} from '../../../shared/tabWindowTypes';

const LOG_CONTEXT = '[TabWindows]';

/**
 * Getters, because the registry and window manager are built at app-ready,
 * after handler registration runs (the same contract as the windows handlers).
 */
export interface TabWindowsHandlerDependencies {
	getWindowRegistry: () => WindowRegistry | null;
	getWindowManager: () => WindowManager | null;
	/** Read for the hidden consult tab refusal (TW-14). */
	sessionsStore: Pick<Store<SessionsData>, 'get'>;
}

/** The window that sent a relay message, or null when it has none. */
function senderWindow(event: Electron.IpcMainEvent): BrowserWindow | null {
	return event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
}

/**
 * Move a permission prompt that waits in a tab window to the window that shows
 * its tab now, whenever a tab window's tabs change (a dock, or the window
 * closing, which docks every tab). The relay prompts a popped tab's requests
 * in its tab window (`initPermissionRelay` routing); without this, a request
 * left unanswered there when the tab docks would wait out the relay's timeout.
 * Returns the unsubscribe function.
 */
export function wireTabWindowPermissionRerouting(registry: WindowRegistry): () => void {
	return registry.onChange((change) => {
		if (change.type === 'tab-window-changed') reroutePermissionRequests();
	});
}

/**
 * Register the `tabWindows:*` handlers and the `tabWindow:*` relay listeners.
 */
export function registerTabWindowsHandlers(deps: TabWindowsHandlerDependencies): void {
	const { getWindowRegistry, getWindowManager, sessionsStore } = deps;

	// Create or reuse the agent's tab window and add the tab (TW-4).
	ipcMain.handle(
		TAB_WINDOW_CHANNELS.popOut,
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'popOut' },
			async (
				agentId: string,
				tabRef: unknown,
				options?: TabWindowPopOutOptions
			): Promise<TabWindowPopOutResult> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				const manager = requireDependency(getWindowManager, 'Window manager');
				return popOutTab(
					{
						registry,
						manager,
						isHiddenTab: (id, ref) => isStoredAiTabHidden(sessionsStore, id, ref),
					},
					agentId,
					tabRef,
					options ?? {}
				);
			}
		)
	);

	// Return a tab to the owner window's strip (TW-8).
	ipcMain.handle(
		TAB_WINDOW_CHANNELS.dock,
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'dock' },
			async (agentId: string, tabRef: unknown): Promise<TabWindowDockResult> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				return dockTab(registry, agentId, tabRef);
			}
		)
	);

	// Show a popped tab in its tab window and raise it (owner-side redirect, D4).
	ipcMain.handle(
		TAB_WINDOW_CHANNELS.focus,
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'focus' },
			async (agentId: string, tabRef: unknown): Promise<TabWindowFocusResult> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				return focusTabWindowTab(registry, agentId, tabRef);
			}
		)
	);

	// Set a tab window's own strip order (the owner runs the `reorderTabs` intent).
	ipcMain.handle(
		TAB_WINDOW_CHANNELS.reorder,
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'reorder' },
			async (agentId: string, tabRefs: unknown): Promise<TabWindowReorderResult> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				return reorderTabWindow(registry, agentId, tabRefs);
			}
		)
	);

	// Every tab window and its tabs.
	ipcMain.handle(
		TAB_WINDOW_CHANNELS.list,
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'list' },
			async (): Promise<TabWindowInfo[]> => {
				const registry = requireDependency(getWindowRegistry, 'Window registry');
				return listTabWindows(registry);
			}
		)
	);

	// The calling tab window's own record. Resolved from event.sender, so it
	// takes the raw (event) form; null for any caller that is not a tab window.
	ipcMain.handle(
		TAB_WINDOW_CHANNELS.getState,
		(event: Electron.IpcMainInvokeEvent): TabWindowInfo | null => {
			const registry = requireDependency(getWindowRegistry, 'Window registry');
			const entry = resolveCallingWindow(event, registry);
			return entry ? toTabWindowInfo(entry) : null;
		}
	);

	// Owner window to tab window (D2). A message the relay refuses is logged
	// and dropped: the sender keeps publishing, and the next snapshot recovers.
	ipcMain.on(TAB_WINDOW_CHANNELS.sessionPatch, (event: Electron.IpcMainEvent, patch: unknown) => {
		const registry = getWindowRegistry();
		if (!registry) return;
		const result = relayTabWindowPatch(registry, senderWindow(event), patch);
		if (!result.relayed) logger.debug(`Dropped session patch: ${result.reason}`, LOG_CONTEXT);
	});

	// Tab window to owner window (D2).
	ipcMain.on(TAB_WINDOW_CHANNELS.intent, (event: Electron.IpcMainEvent, intent: unknown) => {
		const registry = getWindowRegistry();
		if (!registry) return;
		const result = relayTabWindowIntent(registry, senderWindow(event), intent);
		if (!result.relayed) logger.warn(`Dropped intent: ${result.reason}`, LOG_CONTEXT);
	});

	// A terminal tab's view moving between windows: scrollback out, replay in (D5).
	registerTerminalHandoffHandlers();
}
