import { ipcRenderer } from 'electron';
import {
	LIBRARY_RUNTIME_COMMAND_CHANNEL,
	LIBRARY_RUNTIME_EVENT_CHANNEL,
	LIBRARY_RUNTIME_FOLD_CHANNEL,
	LIBRARY_RUNTIME_SNAPSHOT_CHANNEL,
	LIBRARY_RUNTIME_STATUS_CHANNEL,
	type LibraryRuntimeCommandAnswer,
	type LibraryRuntimeCommandRequest,
	type LibraryRuntimeEventMessage,
	type LibraryRuntimeFoldAnswer,
	type LibraryRuntimeStatus,
} from '../../shared/libraryRuntime';
import type {
	DesktopFold,
	DesktopSnapshot,
} from '../../shared/maestro-lib/agents/desktop-fold-types';

export type { LibraryRuntimeEventMessage };

export interface LibraryRuntimeApi {
	/** Fixed for the run: whether main hosts the maestro-lib runtime, and why not when it does not. */
	status: () => Promise<LibraryRuntimeStatus>;
	/** Runtime events, as main stamps and forwards them. Returns the unsubscribe function. */
	onEvent: (listener: (message: LibraryRuntimeEventMessage) => void) => () => void;
	/** The stored records with transcripts and the revisions to guard later events with. Null when main hosts no runtime. */
	snapshot: () => Promise<DesktopSnapshot | null>;
	/** One repository command. The answer holds the result and the stamped events it caused. */
	command: (request: LibraryRuntimeCommandRequest) => Promise<LibraryRuntimeCommandAnswer>;
	/** The desktop fold: this window's desktop-owned state, batched. */
	fold: (fold: DesktopFold) => Promise<LibraryRuntimeFoldAnswer>;
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
		snapshot: () => ipcRenderer.invoke(LIBRARY_RUNTIME_SNAPSHOT_CHANNEL),
		command: (request) => ipcRenderer.invoke(LIBRARY_RUNTIME_COMMAND_CHANNEL, request),
		fold: (fold) => ipcRenderer.invoke(LIBRARY_RUNTIME_FOLD_CHANNEL, fold),
	};
}
