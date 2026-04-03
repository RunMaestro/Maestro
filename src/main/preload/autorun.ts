/**
 * Preload API for Auto Run operations
 *
 * Provides the window.maestro.autorun, playbooks, and marketplace namespaces for:
 * - Auto Run document management
 * - Playbook CRUD operations
 * - Marketplace playbook browsing and importing
 */

import { ipcRenderer } from 'electron';
import type {
	PlaybookDocumentEntry as SharedPlaybookDocument,
	Playbook as SharedSavedPlaybook,
	PlaybookDraft as SharedPlaybookDraft,
	PlaybookUpdate as SharedPlaybookUpdate,
	PlaybookWorktreeSettings as SharedWorktreeSettings,
} from '../../shared/types';
import type {
	GetDocumentResponse,
	GetManifestResponse,
	GetReadmeResponse,
	ImportPlaybookResponse,
} from '../../shared/marketplace-types';

/**
 * Playbook document configuration
 */
export type PlaybookDocument = SharedPlaybookDocument;

/**
 * Worktree settings for playbook
 */
export type WorktreeSettings = SharedWorktreeSettings;

/**
 * Persisted playbook definition
 */
export type Playbook = SharedSavedPlaybook;
export type PlaybookDraft = SharedPlaybookDraft;

type IpcInvokeResult<T extends object> = Promise<
	(T & { success: true }) | { success: false; error: string }
>;

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

		saveImage: (
			folderPath: string,
			docName: string,
			base64Data: string,
			extension: string,
			sshRemoteId?: string
		) =>
			ipcRenderer.invoke(
				'autorun:saveImage',
				folderPath,
				docName,
				base64Data,
				extension,
				sshRemoteId
			),

		deleteImage: (folderPath: string, relativePath: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('autorun:deleteImage', folderPath, relativePath, sshRemoteId),

		listImages: (folderPath: string, docName: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('autorun:listImages', folderPath, docName, sshRemoteId),

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

		createBackup: (folderPath: string, filename: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('autorun:createBackup', folderPath, filename, sshRemoteId),

		restoreBackup: (folderPath: string, filename: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('autorun:restoreBackup', folderPath, filename, sshRemoteId),

		deleteBackups: (folderPath: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('autorun:deleteBackups', folderPath, sshRemoteId),

		createWorkingCopy: (
			folderPath: string,
			filename: string,
			loopNumber: number,
			sshRemoteId?: string
		): Promise<{ workingCopyPath: string; originalPath: string }> =>
			ipcRenderer.invoke(
				'autorun:createWorkingCopy',
				folderPath,
				filename,
				loopNumber,
				sshRemoteId
			),
	};
}

/**
 * Creates the Playbooks API object for preload exposure
 */
export function createPlaybooksApi() {
	return {
		list: (sessionId: string): IpcInvokeResult<{ playbooks: Playbook[] }> =>
			ipcRenderer.invoke('playbooks:list', sessionId),

		create: (sessionId: string, playbook: PlaybookDraft): IpcInvokeResult<{ playbook: Playbook }> =>
			ipcRenderer.invoke('playbooks:create', sessionId, playbook),

		update: (
			sessionId: string,
			playbookId: string,
			updates: SharedPlaybookUpdate
		): IpcInvokeResult<{ playbook: Playbook }> =>
			ipcRenderer.invoke('playbooks:update', sessionId, playbookId, updates),

		delete: (sessionId: string, playbookId: string): IpcInvokeResult<Record<string, never>> =>
			ipcRenderer.invoke('playbooks:delete', sessionId, playbookId),

		deleteAll: (sessionId: string): IpcInvokeResult<Record<string, never>> =>
			ipcRenderer.invoke('playbooks:deleteAll', sessionId),

		export: (
			sessionId: string,
			playbookId: string,
			autoRunFolderPath: string
		): IpcInvokeResult<{ filePath: string }> =>
			ipcRenderer.invoke('playbooks:export', sessionId, playbookId, autoRunFolderPath),

		import: (
			sessionId: string,
			autoRunFolderPath: string
		): IpcInvokeResult<ImportPlaybookResponse> =>
			ipcRenderer.invoke('playbooks:import', sessionId, autoRunFolderPath),
	};
}

/**
 * Creates the Marketplace API object for preload exposure
 */
export function createMarketplaceApi() {
	return {
		getManifest: (): IpcInvokeResult<GetManifestResponse> =>
			ipcRenderer.invoke('marketplace:getManifest'),

		refreshManifest: (): IpcInvokeResult<Omit<GetManifestResponse, 'cacheAge'>> =>
			ipcRenderer.invoke('marketplace:refreshManifest'),

		getDocument: (playbookPath: string, filename: string): IpcInvokeResult<GetDocumentResponse> =>
			ipcRenderer.invoke('marketplace:getDocument', playbookPath, filename),

		getReadme: (playbookPath: string): IpcInvokeResult<GetReadmeResponse> =>
			ipcRenderer.invoke('marketplace:getReadme', playbookPath),

		importPlaybook: (
			playbookId: string,
			targetFolderName: string,
			autoRunFolderPath: string,
			sessionId: string,
			sshRemoteId?: string
		): IpcInvokeResult<ImportPlaybookResponse> =>
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
