/**
 * Preload API for Computer History (`window.maestro.computerHistory`).
 *
 * Mirrors the `computerHistory:*` channels in
 * `src/main/ipc/handlers/computerHistory.ts`. Desktop-only by construction:
 * the web-desktop bridge refuses every one of these channels (D15) and never
 * forwards the status push.
 */

import { ipcRenderer } from 'electron';
import type { ComputerHistoryConfigPatch } from '../../shared/computer-history/config';
import type { QueryResult } from '../../shared/computer-history/reader';
import type {
	AccessibilityRequestResult,
	ComputerHistoryStatus,
} from '../../shared/computer-history/status';
import type {
	CaptureRule,
	CaptureRuleMatch,
	ComputerHistoryConfig,
	StoredEventKind,
} from '../../shared/computer-history/types';

export interface ComputerHistoryQueryRequest {
	sinceMs?: number;
	untilMs?: number;
	apps?: string[];
	kinds?: StoredEventKind[];
	grep?: string;
	limit?: number;
}

/** Creates the Computer History API object for contextBridge exposure. */
export function createComputerHistoryApi() {
	return {
		status: (): Promise<ComputerHistoryStatus> => ipcRenderer.invoke('computerHistory:status'),
		getConfig: (): Promise<ComputerHistoryConfig> =>
			ipcRenderer.invoke('computerHistory:getConfig'),
		setConfig: (patch: ComputerHistoryConfigPatch): Promise<ComputerHistoryConfig> =>
			ipcRenderer.invoke('computerHistory:setConfig', patch),
		pause: (forMs?: number | null): Promise<ComputerHistoryStatus> =>
			ipcRenderer.invoke('computerHistory:pause', forMs ?? null),
		resume: (): Promise<ComputerHistoryStatus> => ipcRenderer.invoke('computerHistory:resume'),
		listRules: (): Promise<{ rules: CaptureRule[]; builtIn: string[] }> =>
			ipcRenderer.invoke('computerHistory:listRules'),
		addRule: (match: CaptureRuleMatch, value: string): Promise<CaptureRule> =>
			ipcRenderer.invoke('computerHistory:addRule', match, value),
		removeRule: (idOrValue: string): Promise<CaptureRule | null> =>
			ipcRenderer.invoke('computerHistory:removeRule', idOrValue),
		clear: (options: {
			sinceMs?: number;
			all?: boolean;
		}): Promise<{ deletedSegments: number; freedBytes: number }> =>
			ipcRenderer.invoke('computerHistory:clear', options),
		requestAccessibility: (): Promise<AccessibilityRequestResult> =>
			ipcRenderer.invoke('computerHistory:requestAccessibility'),
		query: (request: ComputerHistoryQueryRequest): Promise<QueryResult> =>
			ipcRenderer.invoke('computerHistory:query', request),
		/** Fires on every recorder state change (start, stop, pause, helper status). */
		onStatusChanged: (handler: (status: ComputerHistoryStatus) => void): (() => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, status: ComputerHistoryStatus) =>
				handler(status);
			ipcRenderer.on('computerHistory:statusChanged', wrapped);
			return () => {
				ipcRenderer.removeListener('computerHistory:statusChanged', wrapped);
			};
		},
	};
}

export type ComputerHistoryApi = ReturnType<typeof createComputerHistoryApi>;
