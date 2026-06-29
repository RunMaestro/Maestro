// Preload API for the Maestro TUI (`mae`) bridge.
//
// Exposes window.maestro.mae: renderer subscriptions to the main-process push
// of externally-run omp/`mae` session lifecycle, so the renderer can surface a
// tracked session live. Payloads are delivered as `unknown` and validated in the
// renderer (they originate from the bridge's session.register/event/end verbs;
// see src/mae/protocol.ts parseSessionRegister/Event/End).

import { ipcRenderer, type IpcRendererEvent } from 'electron';

export interface MaeApi {
	/** Subscribe to a tracked session being registered. Returns an unsubscriber. */
	onSessionRegistered(callback: (payload: unknown) => void): () => void;
	/** Subscribe to a tracked session lifecycle event. Returns an unsubscriber. */
	onSessionEvent(callback: (payload: unknown) => void): () => void;
	/** Subscribe to a tracked session ending. Returns an unsubscriber. */
	onSessionEnded(callback: (payload: unknown) => void): () => void;
}

function subscribe(channel: string, callback: (payload: unknown) => void): () => void {
	const handler = (_event: IpcRendererEvent, payload: unknown): void => callback(payload);
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.removeListener(channel, handler);
	};
}

export function createMaeApi(): MaeApi {
	return {
		onSessionRegistered: (callback) => subscribe('mae:sessionRegistered', callback),
		onSessionEvent: (callback) => subscribe('mae:sessionEvent', callback),
		onSessionEnded: (callback) => subscribe('mae:sessionEnded', callback),
	};
}
