import { ipcRenderer } from 'electron';

type IpcPayloadListener<Args extends unknown[]> = (...args: Args) => void;

/**
 * Subscribes to one IPC channel while hiding Electron's event argument.
 *
 * The active guard rejects a queued callback after unsubscribe, and the
 * captured wrapper ensures this subscription removes only its own listener.
 */
export function subscribeIpc<Args extends unknown[]>(
	channel: string,
	listener: IpcPayloadListener<Args>
): () => void {
	let active = true;
	const wrappedListener = (_event: Electron.IpcRendererEvent, ...args: Args): void => {
		if (active) {
			listener(...args);
		}
	};

	ipcRenderer.on(channel, wrappedListener);

	return (): void => {
		if (!active) {
			return;
		}

		active = false;
		ipcRenderer.removeListener(channel, wrappedListener);
	};
}
