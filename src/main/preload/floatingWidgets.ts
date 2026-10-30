/**
 * Preload API for floating widgets (`window.maestro.floatingWidgets`).
 *
 * Every window uses it: app windows drive a widget's window and, as its
 * authority, publish its state and answer its commands; widget windows mirror
 * that state and send commands back. The main-process side is
 * src/main/floating-widgets/floating-widget-relay.ts. See
 * `Plans/floating-widgets.md`, section 1.
 *
 * State and commands are plain JSON. Their shapes belong to each widget, so
 * the methods take a type parameter instead of fixing one here.
 */

import { ipcRenderer } from 'electron';
import type {
	FloatingWidgetBounds,
	FloatingWidgetId,
	FloatingWidgetOverflow,
} from '../../shared/floatingWidgets';

/**
 * Listen on a channel whose first argument is a widget id, calling back only
 * for `id`. Returns the unsubscribe function.
 */
function subscribeForWidget<T>(
	channel: string,
	id: FloatingWidgetId,
	callback: (payload: T) => void
): () => void {
	const handler = (_event: Electron.IpcRendererEvent, widgetId: FloatingWidgetId, payload: T) => {
		if (widgetId === id) callback(payload);
	};
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

export function createFloatingWidgetsApi() {
	return {
		// --- The widget's window ---

		/** Show the widget's window without taking focus. Resolves with whether it is visible. */
		show: (id: FloatingWidgetId): Promise<boolean> =>
			ipcRenderer.invoke('floatingWidgets:show', id),

		/** Hide the widget's window (it is kept, not closed). Resolves with whether it is visible. */
		hide: (id: FloatingWidgetId): Promise<boolean> =>
			ipcRenderer.invoke('floatingWidgets:hide', id),

		/** Show the window when hidden, hide it when shown. Resolves with whether it is visible. */
		toggle: (id: FloatingWidgetId): Promise<boolean> =>
			ipcRenderer.invoke('floatingWidgets:toggle', id),

		/** Whether the widget's window is on screen or about to be. */
		isVisible: (id: FloatingWidgetId): Promise<boolean> =>
			ipcRenderer.invoke('floatingWidgets:isVisible', id),

		/** Where the widget's window is, or null when it was never created. */
		getBounds: (id: FloatingWidgetId): Promise<Electron.Rectangle | null> =>
			ipcRenderer.invoke('floatingWidgets:getBounds', id),

		/** Move or resize the widget's window (saved). Resolves with where it ended up. */
		setBounds: (
			id: FloatingWidgetId,
			bounds: FloatingWidgetBounds
		): Promise<Electron.Rectangle | null> =>
			ipcRenderer.invoke('floatingWidgets:setBounds', id, bounds),

		/**
		 * Borrow room past the widget's card for content taller than it (not
		 * saved). `need` is how far each side would have to grow; resolves with
		 * what the window granted. A zero need gives the room back.
		 */
		setOverflow: (
			id: FloatingWidgetId,
			need: FloatingWidgetOverflow
		): Promise<FloatingWidgetOverflow> =>
			ipcRenderer.invoke('floatingWidgets:setOverflow', id, need),

		// --- State: published by the authority, mirrored everywhere else ---

		/** The latest published state, or null when none was published yet. */
		getState: <T = unknown>(id: FloatingWidgetId): Promise<T | null> =>
			ipcRenderer.invoke('floatingWidgets:getState', id),

		/** Authority side: report the widget's current state to every other window. */
		publishState: <T = unknown>(id: FloatingWidgetId, state: T): void =>
			ipcRenderer.send('floatingWidgets:publishState', id, state),

		/** Replica side: fired with each state the authority publishes for `id`. */
		onState: <T = unknown>(id: FloatingWidgetId, callback: (state: T) => void): (() => void) =>
			subscribeForWidget('floatingWidgets:state', id, callback),

		// --- Commands: sent from any window, handled by the authority ---

		/** Ask the widget's authority to act. Main creates and waits for a widget window when needed. */
		sendCommand: <T = unknown>(id: FloatingWidgetId, command: T): void =>
			ipcRenderer.send('floatingWidgets:command', id, command),

		/** Authority side: fired with each command for `id`. */
		onCommand: <T = unknown>(id: FloatingWidgetId, callback: (command: T) => void): (() => void) =>
			subscribeForWidget('floatingWidgets:command', id, callback),

		/** Widget window side: the root mounted and subscribed, so held commands may arrive. */
		ready: (id: FloatingWidgetId): void => ipcRenderer.send('floatingWidgets:ready', id),
	};
}

export type FloatingWidgetsApi = ReturnType<typeof createFloatingWidgetsApi>;
