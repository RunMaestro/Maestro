/**
 * Preload API for chain of thought export.
 *
 * Provides `window.maestro.cotExport`, mirroring the `cotExport:*` IPC handlers
 * in `src/main/ipc/handlers/cot-export.ts`. The channel names come from
 * `COT_EXPORT_CHANNELS` so the preload and the handlers cannot drift apart.
 *
 * Only the desktop window may call these. The handlers refuse every other
 * sender, so exposing them here adds no reach for an agent.
 */

import { ipcRenderer } from 'electron';
import { COT_EXPORT_CHANNELS } from '../../shared/cotExport/channels';
import type {
	CotAgentConfig,
	CotAgentStatus,
	CotChainVerifyResult,
	CotFolderValidation,
	CotSetResult,
} from '../../shared/cotExport/types';

export function createCotExportApi() {
	return {
		/** What the person chose for an agent. */
		get: (agentId: string): Promise<CotAgentConfig> =>
			ipcRenderer.invoke(COT_EXPORT_CHANNELS.get, agentId),

		/**
		 * Change what the person chose. Saved when the promise resolves; a refusal
		 * changes nothing and carries the reason.
		 * @param choice - The complete choice: `{ enabled, folder }`
		 */
		set: (
			agentId: string,
			choice: { enabled: boolean; folder: string | null }
		): Promise<CotSetResult> => ipcRenderer.invoke(COT_EXPORT_CHANNELS.set, agentId, choice),

		/** What the Edit Agent dialog shows about an agent's log. */
		status: (agentId: string): Promise<CotAgentStatus> =>
			ipcRenderer.invoke(COT_EXPORT_CHANNELS.status, agentId),

		/** Whether a folder may hold an agent's log. Changes nothing. */
		validateFolder: (agentId: string, folder: string): Promise<CotFolderValidation> =>
			ipcRenderer.invoke(COT_EXPORT_CHANNELS.validateFolder, agentId, folder),

		/**
		 * Walk every chain of an agent and check it. One result per chain, the
		 * current folder first. Rejects when a folder cannot be listed.
		 */
		verify: (agentId: string): Promise<CotChainVerifyResult[]> =>
			ipcRenderer.invoke(COT_EXPORT_CHANNELS.verify, agentId),
	};
}

/**
 * TypeScript type for the cotExport API.
 */
export type CotExportApi = ReturnType<typeof createCotExportApi>;
