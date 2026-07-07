import type { AgentRun, AgentRunEvent, AgentRunStatus } from '../../shared/agent-run';
import type { Campaign, CampaignStatus } from '../../shared/campaign';
import { createIpcMethod } from './ipcWrapper';

export interface AgentRunListOptions {
	status?: AgentRunStatus;
	campaign?: string;
	limit?: number;
	// ISC-7.2: offset threads through the opaque pass-through (service -> preload
	// -> IPC `...storeOptions` -> store `listAgentRuns`, which already accepts offset)
	// without editing the hook/preload/IPC that the F3 live-push wave owns.
	// TODO(F7): mirror `offset` on the preload/IPC AgentRunListOptions type annotations
	// once F3 lands, so the boundary is typed end-to-end (functionally already works).
	offset?: number;
}

export interface CampaignListOptions {
	status?: CampaignStatus;
	limit?: number;
}

function requireSuccess<T extends { success: boolean; error?: string }>(
	response: T,
	fallbackMessage: string
): T {
	if (!response.success) {
		throw new Error(response.error || fallbackMessage);
	}
	return response;
}

export const agentRunService = {
	async list(options?: AgentRunListOptions): Promise<AgentRun[]> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.list(options),
			errorContext: 'AgentRun list',
			defaultValue: { success: false, runs: [], error: 'Failed to list agent runs' },
		});

		return requireSuccess(response, 'Failed to list agent runs').runs ?? [];
	},

	async record(run: AgentRun): Promise<AgentRun> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.record(run),
			errorContext: 'AgentRun record',
			defaultValue: { success: false, error: `Failed to record agent run ${run.id}` },
		});

		const recorded = requireSuccess(response, `Failed to record agent run ${run.id}`).run;
		if (!recorded) throw new Error(`Failed to record agent run ${run.id}`);
		return recorded;
	},

	async show(runId: string): Promise<AgentRun | null> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.show(runId),
			errorContext: 'AgentRun show',
			defaultValue: { success: false, error: `Failed to show agent run ${runId}` },
		});

		return requireSuccess(response, `Failed to show agent run ${runId}`).run ?? null;
	},

	async events(runId: string): Promise<AgentRunEvent[]> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.events(runId),
			errorContext: 'AgentRun events',
			defaultValue: { success: false, events: [], error: `Failed to read events for ${runId}` },
		});

		return requireSuccess(response, `Failed to read events for ${runId}`).events ?? [];
	},

	async appendEvent(event: AgentRunEvent): Promise<AgentRunEvent> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.appendEvent(event),
			errorContext: 'AgentRun append event',
			defaultValue: { success: false, error: `Failed to append event ${event.id}` },
		});

		const recorded = requireSuccess(response, `Failed to append event ${event.id}`).event;
		if (!recorded) throw new Error(`Failed to append event ${event.id}`);
		return recorded;
	},

	async cancel(runId: string): Promise<AgentRun> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.cancel(runId),
			errorContext: 'AgentRun cancel',
			defaultValue: { success: false, error: `Failed to cancel run ${runId}` },
		});
		const run = requireSuccess(response, `Failed to cancel run ${runId}`).run;
		if (!run) throw new Error(`Failed to cancel run ${runId}`);
		return run;
	},

	async retry(runId: string): Promise<AgentRun> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.retry(runId),
			errorContext: 'AgentRun retry',
			defaultValue: { success: false, error: `Failed to retry run ${runId}` },
		});
		const run = requireSuccess(response, `Failed to retry run ${runId}`).run;
		if (!run) throw new Error(`Failed to retry run ${runId}`);
		return run;
	},

	async resolveFinding(
		runId: string,
		findingIndex: number,
		status: 'fixed' | 'dismissed'
	): Promise<AgentRun> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.resolveFinding(runId, findingIndex, status),
			errorContext: 'AgentRun resolve finding',
			defaultValue: { success: false, error: `Failed to resolve finding on run ${runId}` },
		});
		const run = requireSuccess(response, `Failed to resolve finding on run ${runId}`).run;
		if (!run) throw new Error(`Failed to resolve finding on run ${runId}`);
		return run;
	},

	async merge(runId: string): Promise<AgentRun> {
		const response = await createIpcMethod({
			call: () => window.maestro.agentRun.merge(runId),
			errorContext: 'AgentRun merge',
			defaultValue: { success: false, error: `Failed to merge run ${runId}` },
		});
		const run = requireSuccess(response, `Failed to merge run ${runId}`).run;
		if (!run) throw new Error(`Failed to merge run ${runId}`);
		return run;
	},

	campaigns: {
		async list(options?: CampaignListOptions): Promise<Campaign[]> {
			const response = await createIpcMethod({
				call: () => window.maestro.agentRun.campaigns.list(options),
				errorContext: 'Campaign list',
				defaultValue: { success: false, campaigns: [], error: 'Failed to list campaigns' },
			});

			return requireSuccess(response, 'Failed to list campaigns').campaigns ?? [];
		},

		async record(campaign: Campaign): Promise<Campaign> {
			const response = await createIpcMethod({
				call: () => window.maestro.agentRun.campaigns.record(campaign),
				errorContext: 'Campaign record',
				defaultValue: { success: false, error: `Failed to record campaign ${campaign.id}` },
			});

			const recorded = requireSuccess(
				response,
				`Failed to record campaign ${campaign.id}`
			).campaign;
			if (!recorded) throw new Error(`Failed to record campaign ${campaign.id}`);
			return recorded;
		},

		async show(campaignId: string): Promise<Campaign | null> {
			const response = await createIpcMethod({
				call: () => window.maestro.agentRun.campaigns.show(campaignId),
				errorContext: 'Campaign show',
				defaultValue: { success: false, error: `Failed to show campaign ${campaignId}` },
			});

			return requireSuccess(response, `Failed to show campaign ${campaignId}`).campaign ?? null;
		},
	},
};
