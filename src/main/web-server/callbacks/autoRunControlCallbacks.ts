import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { createRemoteRequest } from './remoteRequest';

export function registerAutoRunControlCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;
	const remoteRequest = createRemoteRequest(getMainWindow);

	// Set up callback for web server to stop Auto Run
	// Fire-and-forget pattern (like interrupt)
	server.setStopAutoRunCallback(async (sessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for stopAutoRun', 'WebServer');
			return false;
		}

		if (!isWebContentsAvailable(mainWindow)) {
			logger.warn('webContents is not available for stopAutoRun', 'WebServer');
			return false;
		}
		mainWindow.webContents.send('remote:stopAutoRun', sessionId);
		return true;
	});

	// Reset all `[x]` checkboxes back to `[ ]` for an Auto Run document.
	// Forwards to the renderer which uses the existing autorun:readDoc / writeDoc IPC
	// (with SSH support) so this works the same locally and on remote sessions.
	server.setResetAutoRunDocTasksCallback(async (sessionId, filename) =>
		remoteRequest<boolean>(
			'resetAutoRunDocTasks',
			'resetAutoRunDocTasks',
			false,
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send(
					'remote:resetAutoRunDocTasks',
					sessionId,
					filename,
					responseChannel
				)
		)
	);

	// Resume / skip / abort an Auto Run that has been paused due to an agent error.
	// These mirror the desktop's AutoRunErrorBanner buttons.
	server.setResumeAutoRunErrorCallback(async (sessionId) =>
		remoteRequest<boolean>(
			'resumeAutoRunError',
			'resumeAutoRunError',
			false,
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send('remote:resumeAutoRunError', sessionId, responseChannel)
		)
	);

	server.setSkipAutoRunDocumentCallback(async (sessionId) =>
		remoteRequest<boolean>(
			'skipAutoRunDocument',
			'skipAutoRunDocument',
			false,
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send('remote:skipAutoRunDocument', sessionId, responseChannel)
		)
	);

	server.setAbortAutoRunErrorCallback(async (sessionId) =>
		remoteRequest<boolean>(
			'abortAutoRunError',
			'abortAutoRunError',
			false,
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send('remote:abortAutoRunError', sessionId, responseChannel)
		)
	);
}
