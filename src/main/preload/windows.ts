/**
 * Preload API for the multi-window system.
 *
 * Provides the `window.maestro.windows` namespace, mirroring the `windows:*` IPC
 * handlers in `src/main/ipc/handlers/windows.ts`. Lets the renderer enumerate,
 * create, focus, and close windows, and inspect/move the agents (sessions) each
 * window owns.
 */

import { ipcRenderer } from 'electron';
import type {
	WindowBounds,
	WindowHighlightDropZonePayload,
	WindowInfo,
	WindowPanelState,
	WindowSessionMovedPayload,
	WindowState,
} from '../../shared/window-types';
import type { WindowCommandRequest, WindowCommandResult } from '../../shared/windowCommands';
import {
	TAB_WINDOW_CHANNELS,
	type TabWindowDockResult,
	type TabWindowFocusResult,
	type TabWindowInfo,
	type TabWindowIntent,
	type TabWindowPopOutOptions,
	type TabWindowPopOutResult,
	type TabWindowReorderResult,
	type TabWindowSessionPatch,
	type TabWindowTabRef,
} from '../../shared/tabWindowTypes';
import type {
	TabWindowCommandRequest,
	TabWindowCommandResult,
} from '../../shared/tabWindowCommands';

export type { WindowBounds };

/**
 * Creates the windows API object for preload exposure.
 */
export function createWindowsApi() {
	return {
		/**
		 * Open a new secondary window.
		 * @param sessionIds - Agent IDs the new window should own (default: none)
		 * @param bounds - Optional initial bounds / maximize state
		 * @returns The created window's info, or null if it could not be tracked
		 */
		create: (sessionIds?: string[], bounds?: Partial<WindowState>): Promise<WindowInfo | null> =>
			ipcRenderer.invoke('windows:create', sessionIds, bounds),

		/**
		 * Close a window by ID. The primary window cannot be closed this way.
		 * @param windowId - ID of the window to close
		 */
		close: (windowId: string): Promise<{ closed: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:close', windowId),

		/** List every open window. */
		list: (): Promise<WindowInfo[]> => ipcRenderer.invoke('windows:list'),

		/**
		 * Find which window owns a given agent (session).
		 * @param sessionId - Agent ID to look up
		 * @returns The owning window's ID, or null if no window owns it
		 */
		getForSession: (sessionId: string): Promise<string | null> =>
			ipcRenderer.invoke('windows:getForSession', sessionId),

		/**
		 * Move an agent from one window to another.
		 * @param sessionId - Agent ID to move
		 * @param fromWindowId - Source window ID
		 * @param toWindowId - Destination window ID
		 */
		moveSession: (
			sessionId: string,
			fromWindowId: string,
			toWindowId: string
		): Promise<{ moved: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:moveSession', sessionId, fromWindowId, toWindowId),

		/**
		 * Bring a window to the foreground.
		 * @param windowId - ID of the window to focus
		 */
		focusWindow: (windowId: string): Promise<{ focused: boolean; error?: string }> =>
			ipcRenderer.invoke('windows:focusWindow', windowId),

		/** The calling window's full state (bounds + owned agents + panel collapse). */
		getState: (): Promise<WindowState | null> => ipcRenderer.invoke('windows:getState'),

		/**
		 * Claim a freshly-created agent for the CALLING window so it surfaces here
		 * immediately and is never momentarily shown by the primary window's
		 * catch-all (spawn flicker). Called at agent-creation time, before the
		 * agent's process starts emitting output.
		 * @param sessionId - The newly-created agent's ID
		 */
		registerSession: (sessionId: string): Promise<{ registered: boolean }> =>
			ipcRenderer.invoke('windows:registerSession', sessionId),

		/**
		 * Persist the calling window's panel-collapse UI state. Per-window (keyed to
		 * the calling window in the main process), not a global setting, so each
		 * window remembers its own collapsed side panels. Only the provided fields
		 * change (partial merge).
		 * @param panel - Collapse flags to write (omit a field to leave it unchanged)
		 */
		setPanelState: (panel: Partial<WindowPanelState>): Promise<void> =>
			ipcRenderer.invoke('windows:setPanelState', panel),

		/**
		 * Set (or clear, via an empty string) a window's user-assigned name. Any
		 * window may rename any window, so this takes an explicit windowId. The new
		 * name persists and is broadcast to every window so labels refresh.
		 * @param windowId - The window to (re)name
		 * @param name - New name; empty/whitespace clears back to the generic label
		 */
		setName: (windowId: string, name: string): Promise<{ renamed: boolean }> =>
			ipcRenderer.invoke('windows:setName', windowId, name),

		/**
		 * On-screen bounds of a window. Defaults to the calling window.
		 * @param windowId - Optional window ID to query a specific window
		 */
		getBounds: (windowId?: string): Promise<WindowBounds | null> =>
			ipcRenderer.invoke('windows:getBounds', windowId),

		/**
		 * Find the window whose screen bounds contain a point.
		 * @param screenX - Screen X coordinate
		 * @param screenY - Screen Y coordinate
		 * @returns The window's ID, or null if no window contains the point
		 */
		findWindowAtPoint: (screenX: number, screenY: number): Promise<string | null> =>
			ipcRenderer.invoke('windows:findWindowAtPoint', screenX, screenY),

		/**
		 * Subscribe to `windows:sessionMoved` broadcasts. The main process emits one
		 * to every window whenever session ownership changes (an agent moves between
		 * windows or a window's owned set is replaced), so each renderer can refresh
		 * which agents it surfaces and its cross-window badges.
		 * @param callback - Invoked with the change payload on every broadcast
		 * @returns An unsubscribe function
		 */
		onSessionMoved: (callback: (payload: WindowSessionMovedPayload) => void): (() => void) => {
			const handler = (_event: unknown, payload: WindowSessionMovedPayload) => callback(payload);
			ipcRenderer.on('windows:sessionMoved', handler);
			return () => {
				ipcRenderer.removeListener('windows:sessionMoved', handler);
			};
		},

		/**
		 * Toggle the drop-zone highlight on a target window's tab bar while a tab is
		 * dragged over it from another window (Phase 3 tab drag-out feedback). Called
		 * by the source window's drag-out tracking as the cursor enters/leaves a
		 * candidate window.
		 * @param windowId - The window whose tab bar should (un)highlight
		 * @param active - True to light it up, false to clear it
		 */
		highlightDropZone: (windowId: string, active: boolean): Promise<void> =>
			ipcRenderer.invoke('windows:highlightDropZone', windowId, active),

		/**
		 * Subscribe to `windows:highlightDropZone` pushes for THIS window. The main
		 * process sends one only to the window being hovered as a drop target, so the
		 * renderer can light up / clear its tab-bar drop zone.
		 * @param callback - Invoked with `{ windowId, active }` on every push
		 * @returns An unsubscribe function
		 */
		onHighlightDropZone: (
			callback: (payload: WindowHighlightDropZonePayload) => void
		): (() => void) => {
			const handler = (_event: unknown, payload: WindowHighlightDropZonePayload) =>
				callback(payload);
			ipcRenderer.on('windows:highlightDropZone', handler);
			return () => {
				ipcRenderer.removeListener('windows:highlightDropZone', handler);
			};
		},

		/**
		 * Subscribe to a remote window verb (`maestro-cli window`). Main sends it
		 * to the primary window only. A round trip: the caller is told where the
		 * agents landed, or why they did not move.
		 */
		onRemoteCommand: (
			callback: (request: WindowCommandRequest, responseChannel: string) => void
		): (() => void) => {
			const handler = (_event: unknown, request: WindowCommandRequest, responseChannel: string) =>
				callback(request, responseChannel);
			ipcRenderer.on('remote:windowCommand', handler);
			return () => ipcRenderer.removeListener('remote:windowCommand', handler);
		},

		sendRemoteCommandResponse: (responseChannel: string, result: WindowCommandResult): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}

/**
 * TypeScript type for the windows API.
 */
export type WindowsApi = ReturnType<typeof createWindowsApi>;

/**
 * Creates the `window.maestro.tabWindows` API (Tab Windows), mirroring the
 * handlers in `src/main/ipc/handlers/tab-windows.ts`. The two relay methods
 * are fire-and-forget: main forwards a patch to the agent's tab window and an
 * intent to the agent's CURRENT owner window, and drops either one when the
 * sender has no right to speak for the agent.
 */
export function createTabWindowsApi() {
	return {
		/**
		 * Pop a tab out into its agent's tab window, opening the window if the
		 * agent has none (one per agent). The window is raised unless `background`.
		 */
		popOut: (
			agentId: string,
			tabRef: TabWindowTabRef,
			options?: TabWindowPopOutOptions
		): Promise<TabWindowPopOutResult> =>
			ipcRenderer.invoke(TAB_WINDOW_CHANNELS.popOut, agentId, tabRef, options),

		/** Return a popped tab to its owner window's strip. */
		dock: (agentId: string, tabRef: TabWindowTabRef): Promise<TabWindowDockResult> =>
			ipcRenderer.invoke(TAB_WINDOW_CHANNELS.dock, agentId, tabRef),

		/** Show a popped tab in its tab window and raise that window. */
		focus: (agentId: string, tabRef: TabWindowTabRef): Promise<TabWindowFocusResult> =>
			ipcRenderer.invoke(TAB_WINDOW_CHANNELS.focus, agentId, tabRef),

		/**
		 * Put the agent's tab window strip in this order. `tabRefs` must name
		 * exactly the tabs the window holds; each keeps its dock slot.
		 */
		reorder: (agentId: string, tabRefs: TabWindowTabRef[]): Promise<TabWindowReorderResult> =>
			ipcRenderer.invoke(TAB_WINDOW_CHANNELS.reorder, agentId, tabRefs),

		/** Every tab window and its tabs. */
		list: (): Promise<TabWindowInfo[]> => ipcRenderer.invoke(TAB_WINDOW_CHANNELS.list),

		/** The calling tab window's own record; null in any other window. */
		getState: (): Promise<TabWindowInfo | null> => ipcRenderer.invoke(TAB_WINDOW_CHANNELS.getState),

		/** Owner window: publish a patch to the agent's tab window. */
		sendSessionPatch: (patch: TabWindowSessionPatch): void => {
			ipcRenderer.send(TAB_WINDOW_CHANNELS.sessionPatch, patch);
		},

		/** Tab window: subscribe to the patches its owner publishes. */
		onSessionPatch: (callback: (patch: TabWindowSessionPatch) => void): (() => void) => {
			const handler = (_event: unknown, patch: TabWindowSessionPatch) => callback(patch);
			ipcRenderer.on(TAB_WINDOW_CHANNELS.sessionPatch, handler);
			return () => ipcRenderer.removeListener(TAB_WINDOW_CHANNELS.sessionPatch, handler);
		},

		/** Tab window: ask the owner window to run an action. */
		sendIntent: (intent: TabWindowIntent): void => {
			ipcRenderer.send(TAB_WINDOW_CHANNELS.intent, intent);
		},

		/** Owner window: subscribe to the intents its agents' tab windows send. */
		onIntent: (callback: (intent: TabWindowIntent) => void): (() => void) => {
			const handler = (_event: unknown, intent: TabWindowIntent) => callback(intent);
			ipcRenderer.on(TAB_WINDOW_CHANNELS.intent, handler);
			return () => ipcRenderer.removeListener(TAB_WINDOW_CHANNELS.intent, handler);
		},

		/**
		 * Terminal handoff (D5, `src/main/terminal-handoff.ts`): this window gives
		 * up its view of a PTY. Main starts holding the PTY's output and answers
		 * through {@link onTerminalReleaseBegun}, in order with `process:data`.
		 */
		beginTerminalRelease: (processId: string): void => {
			ipcRenderer.send(TAB_WINDOW_CHANNELS.terminalRelease, processId);
		},

		/** The answer to {@link beginTerminalRelease}. */
		onTerminalReleaseBegun: (callback: (processId: string) => void): (() => void) => {
			const handler = (_event: unknown, processId: string) => callback(processId);
			ipcRenderer.on(TAB_WINDOW_CHANNELS.terminalReleaseBegun, handler);
			return () => ipcRenderer.removeListener(TAB_WINDOW_CHANNELS.terminalReleaseBegun, handler);
		},

		/** The scrollback of a view this window gave up, for the next view to replay. */
		commitTerminalRelease: (processId: string, text: string): void => {
			ipcRenderer.send(TAB_WINDOW_CHANNELS.terminalCommit, processId, text);
		},

		/** This window mounts a view of a PTY: ask for the scrollback to replay. */
		claimTerminalReplay: (processId: string): void => {
			ipcRenderer.send(TAB_WINDOW_CHANNELS.terminalClaim, processId);
		},

		/** The answer to {@link claimTerminalReplay}: the replay, or null for none. */
		onTerminalReplay: (
			callback: (processId: string, text: string | null) => void
		): (() => void) => {
			const handler = (_event: unknown, processId: string, text: string | null) =>
				callback(processId, text);
			ipcRenderer.on(TAB_WINDOW_CHANNELS.terminalReplay, handler);
			return () => ipcRenderer.removeListener(TAB_WINDOW_CHANNELS.terminalReplay, handler);
		},

		/**
		 * Owner window: subscribe to a remote `tab pop-out` / `tab dock`
		 * (`maestro-cli`). Main sends it to the agent's owner window. A round
		 * trip: the caller is told the window and tabs, or why nothing moved.
		 */
		onRemoteCommand: (
			callback: (request: TabWindowCommandRequest, responseChannel: string) => void
		): (() => void) => {
			const handler = (
				_event: unknown,
				request: TabWindowCommandRequest,
				responseChannel: string
			) => callback(request, responseChannel);
			ipcRenderer.on('remote:tabWindowCommand', handler);
			return () => ipcRenderer.removeListener('remote:tabWindowCommand', handler);
		},

		sendRemoteCommandResponse: (responseChannel: string, result: TabWindowCommandResult): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}

/**
 * TypeScript type for the tab windows API.
 */
export type TabWindowsApi = ReturnType<typeof createTabWindowsApi>;
