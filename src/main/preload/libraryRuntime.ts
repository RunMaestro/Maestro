import { ipcRenderer } from 'electron';
import {
	LIBRARY_RUNTIME_EVENT_CHANNEL,
	LIBRARY_RUNTIME_STATUS_CHANNEL,
	type LibraryRuntimeStatus,
} from '../../shared/libraryRuntime';
import type { MaestroEvent } from '../../shared/maestro-lib/client/types';

export interface LibraryRuntimeEventMessage {
	event: MaestroEvent;
}

export interface LibraryRuntimeApi {
	/** Fixed for the run: whether main hosts the maestro-lib runtime, and why not when it does not. */
	status: () => Promise<LibraryRuntimeStatus>;
	/** Runtime events, as main forwards them. Returns the unsubscribe function. */
	onEvent: (listener: (message: LibraryRuntimeEventMessage) => void) => () => void;
}

export function createLibraryRuntimeApi(): LibraryRuntimeApi {
	return {
		status: () => ipcRenderer.invoke(LIBRARY_RUNTIME_STATUS_CHANNEL),
		onEvent: (listener) => {
			const handler = (_event: Electron.IpcRendererEvent, message: LibraryRuntimeEventMessage) =>
				listener(message);
			ipcRenderer.on(LIBRARY_RUNTIME_EVENT_CHANNEL, handler);
			return () => ipcRenderer.removeListener(LIBRARY_RUNTIME_EVENT_CHANNEL, handler);
		},
	};
}
