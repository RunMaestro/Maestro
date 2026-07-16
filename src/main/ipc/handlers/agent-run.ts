import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { createIpcHandler } from '../../utils/ipcHandler';
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
import type {
	AgentRun,
	AgentRunEvent,
	AgentRunStatus,
	AgentRunReviewStatus,
} from '../../../shared/agent-run';
import { assertTransition } from '../../../shared/agent-run/lifecycle';
import type { Campaign, CampaignStatus } from '../../../shared/campaign';
import { broadcastRunUpdated, broadcastEventAppended } from '../../agent-run/broadcast';
import type { ProcessManager } from '../../process-manager';
import { generateUUID } from '../../../shared/uuid';

const LOG_CONTEXT = '[IPC:AgentRun]';

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Dependencies for the AgentRun control-plane handlers. The process manager is
 * needed to kill a running desktop run on cancel (ISC-4.1); the settings store
 * backs the Encore/consent gate that guards destructive actions (ISC-4.9, D2).
 */
export interface AgentRunHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	settingsStore: { get: (key: string) => unknown };
}

/**
 * True only when the destructive-action gate is open. Destructive control
 * actions (cancel/retry/merge) sit behind `encoreFeatures.pianola` per D1/D2,
 * the same gate class as the other autonomous features on this branch. Read on
 * every call so a toggle takes effect without an app restart.
 */
function isDestructiveGateEnabled(settingsStore: { get: (key: string) => unknown }): boolean {
	const ef = (settingsStore.get('encoreFeatures') ?? {}) as Record<string, unknown>;
	return ef.pianola === true;
}

export function registerAgentRunHandlers(deps: AgentRunHandlerDependencies): void {
	const { getProcessManager, settingsStore } = deps;
	ipcMain.handle(
		'agentRun:list',
		createIpcHandler(
			{
				context: LOG_CONTEXT,
				operation: 'list agent runs',
				logSuccess: false,
				formatError: toErrorMessage,
			},
			async (options?: {
				status?: AgentRunStatus;
				campaign?: string;
				limit?: number;
				offset?: number;
			}) => {
				const { campaign, ...storeOptions } = options ?? {};
				return {
					runs: listAgentRuns({
						...storeOptions,
						...(campaign ? { campaignId: campaign } : {}),
					}),
				};
			}
		)
	);

	ipcMain.handle('agentRun:record', async (_event, run: AgentRun) => {
		try {
			const saved = upsertAgentRun(run);
			broadcastRunUpdated(saved);
			return { success: true, run: saved };
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

	ipcMain.handle(
		'agentRun:events',
		createIpcHandler(
			{
				context: LOG_CONTEXT,
				operation: 'read agent run events',
				logSuccess: false,
				formatError: toErrorMessage,
			},
			async (runId: string) => ({ events: readAgentRunEvents(runId) })
		)
	);

	ipcMain.handle('agentRun:event', async (_event, event: AgentRunEvent) => {
		try {
			const saved = appendAgentRunEvent(event);
			broadcastEventAppended(saved);
			const run = getAgentRun(saved.runId);
			if (run) broadcastRunUpdated(run);
			return { success: true, event: saved };
		} catch (error) {
			logger.error(`Failed to append agent run event: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	ipcMain.handle(
		'campaign:list',
		createIpcHandler(
			{
				context: LOG_CONTEXT,
				operation: 'list campaigns',
				logSuccess: false,
				formatError: toErrorMessage,
			},
			async (options?: { status?: CampaignStatus; limit?: number }) => ({
				campaigns: listCampaigns(options ?? {}),
			})
		)
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

	// ISC-4.1 / ISC-4.10: cancel a run. Gated (D2). A running desktop run has its
	// tracked ProcessManager process killed; a CLI/SSH run with no tracked process
	// records a cancel-requested metadata flag instead of silently no-opping.
	ipcMain.handle('agentRun:cancel', async (_event, runId: string) => {
		try {
			if (!isDestructiveGateEnabled(settingsStore)) {
				return { success: false, error: 'gated' };
			}
			const run = getAgentRun(runId);
			if (!run) return { success: false, error: `Run not found: ${runId}` };
			if (run.status !== 'running') {
				return { success: false, error: `Cannot cancel a run in status ${run.status}` };
			}
			const nextStatus = assertTransition(run.status, 'cancelled', { audited: true });
			const processManager = getProcessManager();
			const killed = run.sessionId ? (processManager?.kill(run.sessionId) ?? false) : false;
			const now = Date.now();
			const updated: AgentRun = {
				...run,
				status: nextStatus,
				updatedAt: now,
				// When no live desktop process was terminated (CLI/SSH or already
				// gone), leave a clear cancel-requested marker so a CLI-side reader
				// can honor the request rather than assume a silent no-op (ISC-4.10).
				metadata: {
					...(run.metadata ?? {}),
					cancelRequestedAt: now,
					cancelKilledProcess: killed,
				},
			};
			const saved = upsertAgentRun(updated);
			broadcastRunUpdated(saved);
			return { success: true, run: saved };
		} catch (error) {
			logger.error(`Failed to cancel agent run ${runId}: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	// ISC-4.2: retry a failed run. Gated (D2). Creates a NEW queued run linked to
	// the original via metadata.retryOf; if the original belongs to a native
	// campaign, the new run id is appended to that campaign's runIds.
	ipcMain.handle('agentRun:retry', async (_event, runId: string) => {
		try {
			if (!isDestructiveGateEnabled(settingsStore)) {
				return { success: false, error: 'gated' };
			}
			const run = getAgentRun(runId);
			if (!run) return { success: false, error: `Run not found: ${runId}` };
			if (run.status !== 'failed') {
				return { success: false, error: `Cannot retry a run in status ${run.status}` };
			}
			const now = Date.now();
			const retry: AgentRun = {
				...run,
				id: generateUUID(),
				status: 'queued',
				createdAt: now,
				updatedAt: now,
				artifacts: [],
				touchedFiles: [],
				checks: [],
				reviews: [],
				pullRequest: undefined,
				merge: undefined,
				usage: undefined,
				nextAction: undefined,
				metadata: { ...(run.metadata ?? {}), retryOf: run.id },
			};
			const savedRetry = upsertAgentRun(retry);
			broadcastRunUpdated(savedRetry);
			// Link the retry to the owning campaign when the original belonged to one
			// (source or metadata.campaignId). Pianola adapter campaigns are
			// read-only, so getCampaign returns undefined / upsert would reject them.
			const campaignId =
				typeof run.metadata?.campaignId === 'string' ? run.metadata.campaignId : run.source;
			if (campaignId && !campaignId.startsWith('pianola:')) {
				const campaign = getCampaign(campaignId);
				if (campaign && !campaign.runIds.includes(savedRetry.id)) {
					upsertCampaign({
						...campaign,
						runIds: [...campaign.runIds, savedRetry.id],
						updatedAt: now,
					});
				}
			}
			return { success: true, run: savedRetry };
		} catch (error) {
			logger.error(`Failed to retry agent run ${runId}: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	// ISC-4.3 / ISC-4.4: mark a review finding fixed or dismissed. Not gated
	// (D2: resolving a finding is a passive annotation, not a side effect).
	ipcMain.handle(
		'agentRun:resolveFinding',
		async (_event, runId: string, findingIndex: number, status: AgentRunReviewStatus) => {
			try {
				if (status !== 'fixed' && status !== 'dismissed') {
					return { success: false, error: `Invalid finding status: ${status}` };
				}
				const run = getAgentRun(runId);
				if (!run) return { success: false, error: `Run not found: ${runId}` };
				if (findingIndex < 0 || findingIndex >= run.reviews.length) {
					return { success: false, error: `Finding index out of range: ${findingIndex}` };
				}
				const reviews = run.reviews.map((finding, index) =>
					index === findingIndex ? { ...finding, status } : finding
				);
				const saved = upsertAgentRun({ ...run, reviews, updatedAt: Date.now() });
				broadcastRunUpdated(saved);
				return { success: true, run: saved };
			} catch (error) {
				logger.error(
					`Failed to resolve finding on agent run ${runId}: ${toErrorMessage(error)}`,
					LOG_CONTEXT
				);
				return { success: false, error: toErrorMessage(error) };
			}
		}
	);

	// ISC-4.5: trigger a merge. Gated (D2). No git-merge IPC path is reachable
	// from the control plane (git.ts exposes status/diff/commit/createPR but no
	// branch merge), so this records an AgentRunMergeOutcome with status 'skipped'
	// and a reason rather than fabricating a merge.
	ipcMain.handle('agentRun:merge', async (_event, runId: string) => {
		try {
			if (!isDestructiveGateEnabled(settingsStore)) {
				return { success: false, error: 'gated' };
			}
			const run = getAgentRun(runId);
			if (!run) return { success: false, error: `Run not found: ${runId}` };
			if (run.status !== 'completed' && run.status !== 'needs_review') {
				return { success: false, error: `Cannot merge a run in status ${run.status}` };
			}
			const now = Date.now();
			const merge = {
				status: 'skipped' as const,
				error: 'No git-merge path reachable from the AgentRun control plane; merge not attempted.',
				metadata: { requestedAt: now },
			};
			const saved = upsertAgentRun({ ...run, merge, updatedAt: now });
			broadcastRunUpdated(saved);
			return { success: true, run: saved };
		} catch (error) {
			logger.error(`Failed to merge agent run ${runId}: ${toErrorMessage(error)}`, LOG_CONTEXT);
			return { success: false, error: toErrorMessage(error) };
		}
	});

	logger.info('AgentRun IPC handlers registered', LOG_CONTEXT);
}
