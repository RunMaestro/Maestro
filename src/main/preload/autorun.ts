/**
 * Preload API for Auto Run operations
 *
 * Provides the window.maestro.autorun, playbooks, and marketplace namespaces for:
 * - Auto Run document management
 * - Playbook CRUD operations
 * - Marketplace playbook browsing and importing
 */

import { ipcRenderer } from 'electron';

/**
 * Playbook document configuration
 */
export interface PlaybookDocument {
	filename: string;
	resetOnCompletion: boolean;
}

/**
 * Worktree settings for playbook
 */
export interface WorktreeSettings {
	branchNameTemplate: string;
	createPROnCompletion: boolean;
	prTargetBranch?: string;
}

/**
 * Playbook definition
 */
export interface Playbook {
	name: string;
	documents: PlaybookDocument[];
	loopEnabled: boolean;
	maxLoops?: number | null;
	prompt: string;
	worktreeSettings?: WorktreeSettings;
}

/**
 * Creates the Auto Run API object for preload exposure
 */
export function createAutorunApi() {
	return {
		listDocs: (folderPath: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('autorun:listDocs', folderPath, sshRemoteId),

		hasDocuments: (folderPath: string): Promise<{ hasDocuments: boolean }> =>
			ipcRenderer.invoke('autorun:hasDocuments', folderPath),

		readDoc: (folderPath: string, filename: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('autorun:readDoc', folderPath, filename, sshRemoteId),

		writeDoc: (folderPath: string, filename: string, content: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('autorun:writeDoc', folderPath, filename, content, sshRemoteId),

		saveImage: (folderPath: string, docName: string, base64Data: string, extension: string) =>
			ipcRenderer.invoke('autorun:saveImage', folderPath, docName, base64Data, extension),

		deleteImage: (folderPath: string, relativePath: string) =>
			ipcRenderer.invoke('autorun:deleteImage', folderPath, relativePath),

		listImages: (folderPath: string, docName: string) =>
			ipcRenderer.invoke('autorun:listImages', folderPath, docName),

		deleteFolder: (projectPath: string) => ipcRenderer.invoke('autorun:deleteFolder', projectPath),

		watchFolder: (
			folderPath: string,
			sshRemoteId?: string
		): Promise<{ isRemote?: boolean; message?: string }> =>
			ipcRenderer.invoke('autorun:watchFolder', folderPath, sshRemoteId),

		unwatchFolder: (folderPath: string) => ipcRenderer.invoke('autorun:unwatchFolder', folderPath),

		onFileChanged: (
			handler: (data: { folderPath: string; filename: string; eventType: string }) => void
		) => {
			const wrappedHandler = (
				_event: Electron.IpcRendererEvent,
				data: { folderPath: string; filename: string; eventType: string }
			) => handler(data);
			ipcRenderer.on('autorun:fileChanged', wrappedHandler);
			return () => ipcRenderer.removeListener('autorun:fileChanged', wrappedHandler);
		},

		createBackup: (folderPath: string, filename: string) =>
			ipcRenderer.invoke('autorun:createBackup', folderPath, filename),

		restoreBackup: (folderPath: string, filename: string) =>
			ipcRenderer.invoke('autorun:restoreBackup', folderPath, filename),

		deleteBackups: (folderPath: string) => ipcRenderer.invoke('autorun:deleteBackups', folderPath),

		createWorkingCopy: (
			folderPath: string,
			filename: string,
			loopNumber: number
		): Promise<{ workingCopyPath: string; originalPath: string }> =>
			ipcRenderer.invoke('autorun:createWorkingCopy', folderPath, filename, loopNumber),
	};
}

/**
 * Creates the Playbooks API object for preload exposure
 */
export function createPlaybooksApi() {
	return {
		list: (sessionId: string) => ipcRenderer.invoke('playbooks:list', sessionId),

		create: (sessionId: string, playbook: Playbook) =>
			ipcRenderer.invoke('playbooks:create', sessionId, playbook),

		update: (
			sessionId: string,
			playbookId: string,
			updates: Partial<Playbook & { updatedAt: number }>
		) => ipcRenderer.invoke('playbooks:update', sessionId, playbookId, updates),

		delete: (sessionId: string, playbookId: string) =>
			ipcRenderer.invoke('playbooks:delete', sessionId, playbookId),

		deleteAll: (sessionId: string) => ipcRenderer.invoke('playbooks:deleteAll', sessionId),

		export: (sessionId: string, playbookId: string, autoRunFolderPath: string) =>
			ipcRenderer.invoke('playbooks:export', sessionId, playbookId, autoRunFolderPath),

		import: (sessionId: string, autoRunFolderPath: string) =>
			ipcRenderer.invoke('playbooks:import', sessionId, autoRunFolderPath),
	};
}

/**
 * Creates the Marketplace API object for preload exposure
 */
export function createMarketplaceApi() {
	return {
		getManifest: () => ipcRenderer.invoke('marketplace:getManifest'),

		refreshManifest: () => ipcRenderer.invoke('marketplace:refreshManifest'),

		getDocument: (playbookPath: string, filename: string) =>
			ipcRenderer.invoke('marketplace:getDocument', playbookPath, filename),

		getReadme: (playbookPath: string) => ipcRenderer.invoke('marketplace:getReadme', playbookPath),

		importPlaybook: (
			playbookId: string,
			targetFolderName: string,
			autoRunFolderPath: string,
			sessionId: string,
			sshRemoteId?: string
		) =>
			ipcRenderer.invoke(
				'marketplace:importPlaybook',
				playbookId,
				targetFolderName,
				autoRunFolderPath,
				sessionId,
				sshRemoteId
			),

		onManifestChanged: (handler: () => void) => {
			const wrappedHandler = () => handler();
			ipcRenderer.on('marketplace:manifestChanged', wrappedHandler);
			return () => ipcRenderer.removeListener('marketplace:manifestChanged', wrappedHandler);
		},
	};
}

export type AutorunApi = ReturnType<typeof createAutorunApi>;
export type PlaybooksApi = ReturnType<typeof createPlaybooksApi>;
export type MarketplaceApi = ReturnType<typeof createMarketplaceApi>;
