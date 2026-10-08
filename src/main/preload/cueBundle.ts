/**
 * Preload API for Cue bundles
 *
 * Exposes window.maestro.cueBundle.* - export a pipeline or an agent,
 * inspect a bundle, plan or run an import - plus the round trip main uses to
 * hand imported agents to the renderer, which owns them.
 */

import { ipcRenderer } from 'electron';
import type { SessionInfo } from '../../shared/types';
import type {
	CueBundleExportOutcome,
	CueBundleExportRequest,
	CueBundleImportOutcome,
	CueBundleImportRequest,
	CueBundleInspectOutcome,
} from '../cue-bundle-service';

/** Agents an import adds (`created`) and replaces by id (`updated`). */
export interface CueBundleAgentChange {
	created: SessionInfo[];
	updated: SessionInfo[];
}

export function createCueBundleApi() {
	return {
		export: (request: CueBundleExportRequest): Promise<CueBundleExportOutcome> =>
			ipcRenderer.invoke('cueBundle:export', request),

		/** Open dialog for a bundle zip. Null when cancelled. */
		chooseFile: (): Promise<string | null> => ipcRenderer.invoke('cueBundle:chooseFile'),

		inspect: (bundlePath: string): Promise<CueBundleInspectOutcome> =>
			ipcRenderer.invoke('cueBundle:inspect', { bundlePath }),

		import: (request: CueBundleImportRequest): Promise<CueBundleImportOutcome> =>
			ipcRenderer.invoke('cueBundle:import', request),

		/** Main asks the renderer to add the agents an import brings. */
		onApplyAgents: (
			callback: (change: CueBundleAgentChange, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, change: CueBundleAgentChange, responseChannel: string) =>
				callback(change, responseChannel);
			ipcRenderer.on('cueBundle:applyAgents', handler);
			return () => ipcRenderer.removeListener('cueBundle:applyAgents', handler);
		},

		sendApplyAgentsResponse: (
			responseChannel: string,
			result: { ok: true } | { ok: false; error: string }
		): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}

export type CueBundleApi = ReturnType<typeof createCueBundleApi>;
