/**
 * Preload API for Computer History (`window.maestro.computerHistory`).
 *
 * Mirrors the `computerHistory:*` channels in
 * `src/main/ipc/handlers/computerHistory.ts`. Desktop-only by construction:
 * the web-desktop bridge refuses every one of these channels (D15; the store
 * files themselves are guarded by bridgePathGuard.ts) and never
 * forwards the status push.
 */

import { ipcRenderer } from 'electron';
import type { ComputerHistoryConfigPatch } from '../../shared/computer-history/config';
import type { DigestKind } from '../../shared/computer-history/paths';
import type {
	ActivitySummary,
	AppActivity,
	DigestWithBody,
	QueryResult,
} from '../../shared/computer-history/reader';
import type {
	AccessibilityRequestResult,
	ComputerHistoryStatus,
	RuleAddResult,
} from '../../shared/computer-history/status';
import type {
	CaptureRule,
	CaptureRuleAction,
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

export interface ComputerHistoryRangeRequest {
	sinceMs?: number;
	untilMs?: number;
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
		addRule: (
			match: CaptureRuleMatch,
			value: string,
			action: CaptureRuleAction = 'ignore'
		): Promise<RuleAddResult> =>
			ipcRenderer.invoke('computerHistory:addRule', match, value, action),
		removeRule: (idOrValue: string, action?: CaptureRuleAction): Promise<CaptureRule | null> =>
			ipcRenderer.invoke('computerHistory:removeRule', idOrValue, action),
		clear: (options: {
			sinceMs?: number;
			all?: boolean;
		}): Promise<{ deletedSegments: number; freedBytes: number }> =>
			ipcRenderer.invoke('computerHistory:clear', options),
		requestAccessibility: (): Promise<AccessibilityRequestResult> =>
			ipcRenderer.invoke('computerHistory:requestAccessibility'),
		query: (request: ComputerHistoryQueryRequest): Promise<QueryResult> =>
			ipcRenderer.invoke('computerHistory:query', request),
		/** Per-15-minute-window and per-app activity (index-backed). */
		activity: (range: ComputerHistoryRangeRequest): Promise<ActivitySummary> =>
			ipcRenderer.invoke('computerHistory:activity', range),
		/** Apps recorded in the last 30 days plus apps seen this session. */
		knownApps: (): Promise<AppActivity[]> => ipcRenderer.invoke('computerHistory:knownApps'),
		/** Newest digests (agent-written, untrusted) with their markdown bodies. */
		digests: (
			request: ComputerHistoryRangeRequest & { kind?: DigestKind; limit?: number }
		): Promise<DigestWithBody[]> => ipcRenderer.invoke('computerHistory:digests', request),
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
