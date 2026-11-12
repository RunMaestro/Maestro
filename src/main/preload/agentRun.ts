import { ipcRenderer } from 'electron';
import type { AgentRun, AgentRunEvent, AgentRunStatus } from '../../shared/agent-run';
import type { Campaign, CampaignStatus } from '../../shared/campaign';

export interface AgentRunListOptions {
	status?: AgentRunStatus;
	campaign?: string;
	limit?: number;
	offset?: number;
}

export interface CampaignListOptions {
	status?: CampaignStatus;
	limit?: number;
}

export interface AgentRunListResponse {
	success: boolean;
	runs?: AgentRun[];
	error?: string;
}

export interface AgentRunRecordResponse {
	success: boolean;
	run?: AgentRun;
	error?: string;
}
export interface AgentRunShowResponse {
	success: boolean;
	run?: AgentRun;
	error?: string;
}

export interface AgentRunEventsResponse {
	success: boolean;
	events?: AgentRunEvent[];
	error?: string;
}

export interface AgentRunEventRecordResponse {
	success: boolean;
	event?: AgentRunEvent;
	error?: string;
}

export interface CampaignListResponse {
	success: boolean;
	campaigns?: Campaign[];
	error?: string;
}

export interface CampaignShowResponse {
	success: boolean;
	campaign?: Campaign;
	error?: string;
}

export interface CampaignRecordResponse {
	success: boolean;
	campaign?: Campaign;
	error?: string;
}

export interface AgentRunActionResponse {
	success: boolean;
	run?: AgentRun;
	error?: string;
}

export function createAgentRunApi() {
	return {
		list: (options?: AgentRunListOptions): Promise<AgentRunListResponse> =>
			ipcRenderer.invoke('agentRun:list', options),
		record: (run: AgentRun): Promise<AgentRunRecordResponse> =>
			ipcRenderer.invoke('agentRun:record', run),
		show: (runId: string): Promise<AgentRunShowResponse> =>
			ipcRenderer.invoke('agentRun:show', runId),
		events: (runId: string): Promise<AgentRunEventsResponse> =>
			ipcRenderer.invoke('agentRun:events', runId),
		appendEvent: (event: AgentRunEvent): Promise<AgentRunEventRecordResponse> =>
			ipcRenderer.invoke('agentRun:event', event),
		cancel: (runId: string): Promise<AgentRunActionResponse> =>
			ipcRenderer.invoke('agentRun:cancel', runId),
		retry: (runId: string): Promise<AgentRunActionResponse> =>
			ipcRenderer.invoke('agentRun:retry', runId),
		resolveFinding: (
			runId: string,
			findingIndex: number,
			status: 'fixed' | 'dismissed'
		): Promise<AgentRunActionResponse> =>
			ipcRenderer.invoke('agentRun:resolveFinding', runId, findingIndex, status),
		merge: (runId: string): Promise<AgentRunActionResponse> =>
			ipcRenderer.invoke('agentRun:merge', runId),
		onUpdated: (listener: (run: AgentRun) => void): (() => void) => {
			const handler = (_event: unknown, run: AgentRun): void => listener(run);
			ipcRenderer.on('agentRun:updated', handler);
			return () => ipcRenderer.removeListener('agentRun:updated', handler);
		},
		onEventAppended: (listener: (event: AgentRunEvent) => void): (() => void) => {
			const handler = (_event: unknown, appended: AgentRunEvent): void => listener(appended);
			ipcRenderer.on('agentRun:eventAppended', handler);
			return () => ipcRenderer.removeListener('agentRun:eventAppended', handler);
		},
		campaigns: {
			list: (options?: CampaignListOptions): Promise<CampaignListResponse> =>
				ipcRenderer.invoke('campaign:list', options),
			record: (campaign: Campaign): Promise<CampaignRecordResponse> =>
				ipcRenderer.invoke('campaign:record', campaign),
			show: (campaignId: string): Promise<CampaignShowResponse> =>
				ipcRenderer.invoke('campaign:show', campaignId),
		},
	};
}

export type AgentRunApi = ReturnType<typeof createAgentRunApi>;
