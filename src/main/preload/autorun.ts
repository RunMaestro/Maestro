/**
 * Preload API for Auto Run operations
 *
 * Provides the window.maestro.autorun, playbooks, and marketplace namespaces for:
 * - Auto Run document management
 * - Playbook CRUD operations
 * - Marketplace playbook browsing and importing
 */

import { ipcRenderer } from 'electron';
import type { PlaybookStatus, PlaybookUpdate, Playbook as SavedPlaybook } from '../../shared/types';
import { AUTORUN_DELEGATION_CHANNEL } from '../../shared/autoRunDelegation';
import { PLAYBOOKS_CHANGED_CHANNEL } from '../../shared/playbooksChanged';
import type { DiskEvidence } from '../../shared/playbookRunReport';
import type { RunEvidenceSnapshot } from '../../shared/runEvidence';

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
	taskSelectionMode?: 'task' | 'document';
	worktreeSettings?: WorktreeSettings;
	parameterValues?: SavedPlaybook['parameterValues'];
	parameterOverlay?: SavedPlaybook['parameterOverlay'];
	interaction?: SavedPlaybook['interaction'];
	scope?: SavedPlaybook['scope'];
	report?: SavedPlaybook['report'];
	provenance?: SavedPlaybook['provenance'];
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

		replaceImage: (
			folderPath: string,
			relativePath: string,
			base64Data: string,
			sshRemoteId?: string
		) =>
			ipcRenderer.invoke('autorun:replaceImage', folderPath, relativePath, base64Data, sshRemoteId),

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

		// Watch .maestro/STATUS.json for live playbook progress. Returns the
		// current status (if the file already exists) so the panel can populate
		// immediately; subsequent updates arrive via onStatusChanged.
		watchStatus: (
			projectPath: string,
			subscriberId: string,
			isRemote?: boolean
		): Promise<{
			status: PlaybookStatus | null;
			watching: boolean;
			isRemote?: boolean;
			message?: string;
		}> => ipcRenderer.invoke('autorun:watchStatus', projectPath, subscriberId, isRemote),

		unwatchStatus: (projectPath: string, subscriberId: string): Promise<Record<string, never>> =>
			ipcRenderer.invoke('autorun:unwatchStatus', projectPath, subscriberId),

		onStatusChanged: (
			handler: (data: { projectPath: string; status: PlaybookStatus | null }) => void
		) => {
			const wrappedHandler = (
				_event: Electron.IpcRendererEvent,
				data: { projectPath: string; status: PlaybookStatus | null }
			) => handler(data);
			ipcRenderer.on('autorun:statusChanged', wrappedHandler);
			return () => ipcRenderer.removeListener('autorun:statusChanged', wrappedHandler);
		},

		/**
		 * Lifecycle of work an Auto Run task handed to another agent with
		 * `maestro-cli dispatch`. Broadcast to every client; the one whose run loop
		 * owns the event's `autoRunId` acts on it. The payload is untrusted over
		 * the bridge, so callers narrow it with `parseAutoRunDelegationEvent`.
		 */
		onDelegation: (handler: (event: unknown) => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, data: unknown) => handler(data);
			ipcRenderer.on(AUTORUN_DELEGATION_CHANNEL, wrappedHandler);
			return () => ipcRenderer.removeListener(AUTORUN_DELEGATION_CHANNEL, wrappedHandler);
		},

		/**
		 * Snapshot an agent's folder at run start for the run report's disk
		 * evidence (git, or an mtime scan outside a repository).
		 */
		evidenceStart: (
			cwd: string,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ success: boolean; snapshot?: RunEvidenceSnapshot | null; error?: string }> =>
			ipcRenderer.invoke('autorun:evidenceStart', cwd, sshRemoteId, remoteCwd),

		/** Diff the folder at run end against the snapshot `evidenceStart` returned. */
		evidenceEnd: (
			cwd: string,
			snapshot: RunEvidenceSnapshot,
			sshRemoteId?: string,
			remoteCwd?: string
		): Promise<{ success: boolean; evidence?: DiskEvidence | null; error?: string }> =>
			ipcRenderer.invoke('autorun:evidenceEnd', cwd, snapshot, sshRemoteId, remoteCwd),
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

		update: (sessionId: string, playbookId: string, updates: PlaybookUpdate) =>
			ipcRenderer.invoke('playbooks:update', sessionId, playbookId, updates),

		delete: (sessionId: string, playbookId: string) =>
			ipcRenderer.invoke('playbooks:delete', sessionId, playbookId),

		deleteAll: (sessionId: string) => ipcRenderer.invoke('playbooks:deleteAll', sessionId),

		export: (sessionId: string, playbookId: string, autoRunFolderPath: string) =>
			ipcRenderer.invoke('playbooks:export', sessionId, playbookId, autoRunFolderPath),

		import: (sessionId: string, autoRunFolderPath: string) =>
			ipcRenderer.invoke('playbooks:import', sessionId, autoRunFolderPath),

		/** The local facts pack for an agent (git, gh, python3, Encore, Cue). Never fails on a missing tool. */
		gatherFacts: (sessionId: string) => ipcRenderer.invoke('playbooks:gatherFacts', sessionId),

		/** Fires with the agent id after any write to that agent's playbook records. */
		onChanged: (handler: (sessionId: string) => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, sessionId: string) =>
				handler(sessionId);
			ipcRenderer.on(PLAYBOOKS_CHANGED_CHANNEL, wrappedHandler);
			return () => ipcRenderer.removeListener(PLAYBOOKS_CHANGED_CHANNEL, wrappedHandler);
		},
	};
}

/**
 * Creates the Marketplace API object for preload exposure
 */
export function createMarketplaceApi() {
	return {
		getManifest: () => ipcRenderer.invoke('marketplace:getManifest'),

		refreshManifest: () => ipcRenderer.invoke('marketplace:refreshManifest'),

		getHealth: (forceRefresh?: boolean) =>
			ipcRenderer.invoke('marketplace:getHealth', forceRefresh),

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

		/**
		 * Update the record this agent already holds for an Exchange entry:
		 * re-fetch its documents into the record's own folder, refresh the
		 * pristine copies, and keep the parameter answers.
		 */
		updatePlaybook: (
			playbookId: string,
			autoRunFolderPath: string,
			sessionId: string,
			sshRemoteId?: string
		) =>
			ipcRenderer.invoke(
				'marketplace:importPlaybook',
				playbookId,
				'',
				autoRunFolderPath,
				sessionId,
				sshRemoteId,
				{ update: true }
			),

		/** Classify every playbook the agent installed from the Exchange. */
		checkUpdates: (sessionId: string, autoRunFolderPath: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('marketplace:checkUpdates', sessionId, autoRunFolderPath, sshRemoteId),

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
