import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { requestFromRenderer } from './remoteRequest';
import {
	normalizeWindowCommandResult,
	type WindowCommandRequest,
	type WindowCommandResult,
} from '../../../shared/windowCommands';

/**
 * `maestro-cli window` is a ROUND TRIP to the PRIMARY window. Only the primary
 * subscribes, and it can move any agent because WindowContext's move methods
 * resolve each agent's true owner from the registry rather than assuming the
 * initiating window holds it.
 */
export function registerWindowCommandCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	server.setWindowCommandCallback(async (request: WindowCommandRequest) => {
		const mainWindow = getMainWindow();
		if (!mainWindow || !isWebContentsAvailable(mainWindow)) {
			logger.warn('No main window is available for windowCommand', 'WebServer');
			return { success: false, error: 'Maestro window is not available' };
		}
		return requestFromRenderer<WindowCommandResult>(mainWindow, 'remote:windowCommand', {
			// A move creates a window and serializes one registry transfer per
			// agent, so a large group needs more than the 3s default.
			timeoutMs: 15_000,
			fallback: { success: false, error: 'Maestro did not answer the window request' },
			parse: normalizeWindowCommandResult,
			args: [request],
		});
	});
}
