import { BrowserWindow, ipcMain } from 'electron';
import {
	LIBRARY_RUNTIME_EVENT_CHANNEL,
	LIBRARY_RUNTIME_STATUS_CHANNEL,
} from '../../../shared/libraryRuntime';
import type { LibraryRuntimeHost } from '../../library-runtime';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { isWebContentsAvailable } from '../../utils/safe-send';

const LOG_CONTEXT = '[LibraryRuntime]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * `libraryRuntime:status` for every window, and the runtime's events forwarded to every window.
 * Registered whatever the setting says, so the renderer always gets an answer: OFF is
 * `{ hosting: false }`, which is what keeps every existing code path as it was.
 *
 * Returns the function that stops the forwarding.
 */
export function registerLibraryRuntimeHandlers(host: LibraryRuntimeHost): () => void {
	ipcMain.handle(
		LIBRARY_RUNTIME_STATUS_CHANNEL,
		withIpcErrorLogging(handlerOpts('status'), async () => host.status())
	);

	const runtime = host.runtime();
	if (!runtime) return () => undefined;
	return runtime.events.subscribe((event) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (isWebContentsAvailable(window)) {
				window.webContents.send(LIBRARY_RUNTIME_EVENT_CHANNEL, { event });
			}
		}
	});
}
