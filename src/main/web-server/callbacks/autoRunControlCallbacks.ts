import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { createRemoteRequest, requestFromRenderer } from './remoteRequest';
import {
	normalizeSteeringCommandResult,
	type SteeringCommandRequest,
	type SteeringCommandResult,
} from '../../../shared/autoRunSteeringCommands';

export function registerAutoRunControlCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow' | 'getWindowForSession'>
): void {
	const { getMainWindow, getWindowForSession } = deps;
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

	// Steering verbs are a ROUND TRIP: the caller is waiting to be told which
	// note was parked, or what the run said back. The request goes to the window
	// that owns the agent, because the notes are that renderer's state and its
	// run loop is the one that reads them - a note parked in any other window
	// would sit there and never reach a task.
	server.setAutoRunSteeringCommandCallback(async (request: SteeringCommandRequest) => {
		const targetWindow = getWindowForSession?.(request.sessionId) ?? getMainWindow();
		if (!targetWindow || !isWebContentsAvailable(targetWindow)) {
			logger.warn('No window is available for autoRunSteeringCommand', 'WebServer');
			return { success: false, error: 'Maestro window is not available' };
		}
		return requestFromRenderer<SteeringCommandResult>(
			targetWindow,
			'remote:autoRunSteeringCommand',
			{
				// A miss RESOLVES rather than rejecting: the caller is a CLI process,
				// and a thrown error there reads as a broken command rather than as
				// the renderer never answering.
				fallback: { success: false, error: 'Maestro did not answer the steering request' },
				parse: normalizeSteeringCommandResult,
				args: [request],
			}
		);
	});
}
