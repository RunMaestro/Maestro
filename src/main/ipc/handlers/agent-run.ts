import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import {
	appendAgentRunEvent,
	getAgentRun,
	getCampaign,
	listAgentRuns,
	listCampaigns,
	readAgentRunEvents,
	upsertAgentRun,
	upsertCampaign,
} from '../../../cli/services/agent-run-store';
import type { AgentRun, AgentRunEvent, AgentRunStatus } from '../../../shared/agent-run';
import type { Campaign, CampaignStatus } from '../../../shared/campaign';

const LOG_CONTEXT = '[IPC:AgentRun]';

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerAgentRunHandlers(): void {
	ipcMain.handle(
		'agentRun:list',
		async (_event, options?: { status?: AgentRunStatus; campaign?: string; limit?: number }) => {
			try {
				const { campaign, ...storeOptions } = options ?? {};
				return {
					success: true,
					runs: listAgentRuns({ ...storeOptions, ...(campaign ? { campaignId: campaign } : {}) }),
				};
			} catch (error) {
				logger.error(`Failed to list agent runs: ${toErrorMessage(error)}`, LOG_CONTEXT);
				return { success: false, error: toErrorMessage(error) };
			}
		}
	);

	ipcMain.handle('agentRun:record', async (_event, run: AgentRun) => {
		try {
			return { success: true, run: upsertAgentRun(run) };
		} catch (error) {
			logger.error(`Failed to record agent run: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle('agentRun:show', async (_event, runId: string) => {
		try {
			const run = getAgentRun(runId);
			return run ? { success: true, run } : { success: false, error: `Run not found: ${runId}` };
		} catch (error) {
			logger.error(`Failed to show agent run ${runId}: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle('agentRun:events', async (_event, runId: string) => {
		try {
			return { success: true, events: readAgentRunEvents(runId) };
		} catch (error) {
			logger.error(
				`Failed to read agent run events ${runId}: ${toErrorMessage(error)}`,
				LOG_CONTEXT
			);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle('agentRun:event', async (_event, event: AgentRunEvent) => {
		try {
			return { success: true, event: appendAgentRunEvent(event) };
		} catch (error) {
			logger.error(`Failed to append agent run event: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle(
		'campaign:list',
		async (_event, options?: { status?: CampaignStatus; limit?: number }) => {
			try {
				return { success: true, campaigns: listCampaigns(options ?? {}) };
			} catch (error) {
				logger.error(`Failed to list campaigns: ${toErrorMessage(error)}`, LOG_CONTEXT);
				return { success: false, error: toErrorMessage(error) };
			}
		}
	);

	ipcMain.handle('campaign:record', async (_event, campaign: Campaign) => {
		try {
			return { success: true, campaign: upsertCampaign(campaign) };
		} catch (error) {
			logger.error(`Failed to record campaign: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle('campaign:show', async (_event, campaignId: string) => {
		try {
			const campaign = getCampaign(campaignId);
			return campaign
				? { success: true, campaign }
				: { success: false, error: `Campaign not found: ${campaignId}` };
		} catch (error) {
			logger.error(`Failed to show campaign ${campaignId}: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	logger.info('AgentRun IPC handlers registered', LOG_CONTEXT);
}
