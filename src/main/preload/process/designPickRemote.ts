import { ipcRenderer } from 'electron';
import type {
	DesignPickCommandRequest,
	DesignPickCommandResult,
} from '../../../shared/designPickCommands';

/**
 * Remote Design Mode chip verbs (`maestro-cli browser-picks`), answered by the
 * renderer that holds the chips staged in the agent's composer.
 */
export function createDesignPickRemoteApi() {
	return {
		/**
		 * Subscribe to a remote Design Mode chip verb and answer it with the
		 * callback's result. A round trip rather than a fire-and-forget send: the
		 * caller is told which chips are staged, or which one it removed. A throw
		 * is answered as a failure first, so the CLI is not left waiting out its
		 * timeout, then rethrown for Sentry.
		 */
		onRemoteDesignPickCommand: (
			callback: (request: DesignPickCommandRequest) => DesignPickCommandResult
		): (() => void) => {
			const handler = (_: unknown, request: DesignPickCommandRequest, responseChannel: string) => {
				try {
					ipcRenderer.send(responseChannel, callback(request));
				} catch (error) {
					ipcRenderer.send(responseChannel, {
						success: false,
						error: error instanceof Error ? error.message : String(error),
					});
					throw error;
				}
			};
			ipcRenderer.on('remote:designPickCommand', handler);
			return () => ipcRenderer.removeListener('remote:designPickCommand', handler);
		},
	};
}
