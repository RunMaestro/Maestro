import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import type { WebPlaybook } from '../types';
import { createRemoteRequest } from './remoteRequest';

export function registerPlaybookCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const remoteRequest = createRemoteRequest(deps.getMainWindow);

	// Playbook CRUD callbacks - list / create / update / delete.
	// All forward to the renderer which calls window.maestro.playbooks.* IPC.
	server.setListPlaybooksCallback(async (sessionId) =>
		remoteRequest<WebPlaybook[]>(
			'listPlaybooks',
			'listPlaybooks',
			[],
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send('remote:listPlaybooks', sessionId, responseChannel)
		)
	);

	server.setCreatePlaybookCallback(async (sessionId, playbook) =>
		remoteRequest<WebPlaybook | null>(
			'createPlaybook',
			'createPlaybook',
			null,
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send('remote:createPlaybook', sessionId, playbook, responseChannel)
		)
	);

	server.setUpdatePlaybookCallback(async (sessionId, playbookId, updates) =>
		remoteRequest<WebPlaybook | null>(
			'updatePlaybook',
			'updatePlaybook',
			null,
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send(
					'remote:updatePlaybook',
					sessionId,
					playbookId,
					updates,
					responseChannel
				)
		)
	);

	server.setDeletePlaybookCallback(async (sessionId, playbookId) =>
		remoteRequest<boolean>(
			'deletePlaybook',
			'deletePlaybook',
			false,
			(mainWindow, responseChannel) =>
				mainWindow.webContents.send('remote:deletePlaybook', sessionId, playbookId, responseChannel)
		)
	);
}
