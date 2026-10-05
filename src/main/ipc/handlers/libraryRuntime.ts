import { BrowserWindow, ipcMain } from 'electron';
import {
	LIBRARY_RUNTIME_COMMAND_CHANNEL,
	LIBRARY_RUNTIME_EVENT_CHANNEL,
	LIBRARY_RUNTIME_FOLD_CHANNEL,
	LIBRARY_RUNTIME_SNAPSHOT_CHANNEL,
	LIBRARY_RUNTIME_STATUS_CHANNEL,
	type LibraryRuntimeCommandRequest,
	type LibraryRuntimeEventMessage,
} from '../../../shared/libraryRuntime';
import type { DesktopFold } from '../../../shared/maestro-lib/agents/desktop-fold-types';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { projectWebSession } from '../../stores/deferred-session-content';
import type { StoredSession } from '../../stores/types';
import type { DesktopBinding } from '../../library-runtime/desktop-binding';
import type { LibraryRuntimeHost } from '../../library-runtime';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { broadcastBridgeEvent } from '../../web-server/handlers/bridgeHandlers';

const LOG_CONTEXT = '[LibraryRuntime]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/** Send one stamped event to every window and to the web-desktop clients behind the bridge. */
function forwardEvent(message: LibraryRuntimeEventMessage): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (isWebContentsAvailable(window)) {
			window.webContents.send(LIBRARY_RUNTIME_EVENT_CHANNEL, message);
		}
	}
	broadcastBridgeEvent(LIBRARY_RUNTIME_EVENT_CHANNEL, [message]);
}

/**
 * The `libraryRuntime:*` channels. `status` is registered whatever the setting says, so the renderer
 * always gets an answer: OFF is `{ hosting: false }`, which is what keeps every existing code path as it
 * was. The other four exist only while a runtime is hosted, and the renderer never calls them otherwise.
 *
 * `binding` is the host's desktop binding: stamped events, commands, the fold, and a healed snapshot
 * (image relocation and tool output compaction, as `sessions:getAll` does on load).
 *
 * Returns the function that stops the forwarding.
 */
export function registerLibraryRuntimeHandlers(
	host: LibraryRuntimeHost,
	binding?: DesktopBinding
): () => void {
	ipcMain.handle(
		LIBRARY_RUNTIME_STATUS_CHANNEL,
		withIpcErrorLogging(handlerOpts('status'), async () => host.status())
	);

	if (!binding) return () => undefined;

	// Not wrapped by `withIpcErrorLogging`: it strips the event, and the snapshot has to tell a window
	// (which has a sender) from a web-desktop call (the bridge's synthetic event has none).
	ipcMain.handle(
		LIBRARY_RUNTIME_SNAPSHOT_CHANNEL,
		async (event: { sender?: unknown } | undefined) => {
			try {
				const snapshot = await binding.loadSnapshot();
				// A browser boots from the thin projection and fetches a transcript when its tab is selected, as today.
				if (event?.sender) return snapshot;
				return {
					...snapshot,
					agents: snapshot.agents.map(
						(agent) =>
							projectWebSession(agent as unknown as StoredSession) as unknown as AgentRecord
					),
				};
			} catch (error) {
				logger.error('snapshot error', LOG_CONTEXT, error);
				throw error;
			}
		}
	);
	ipcMain.handle(
		LIBRARY_RUNTIME_COMMAND_CHANNEL,
		withIpcErrorLogging(handlerOpts('command'), async (request: LibraryRuntimeCommandRequest) =>
			binding.command(request)
		)
	);
	ipcMain.handle(
		LIBRARY_RUNTIME_FOLD_CHANNEL,
		withIpcErrorLogging(handlerOpts('fold'), async (fold: DesktopFold) => binding.fold(fold))
	);

	return binding.onEvent(forwardEvent);
}
