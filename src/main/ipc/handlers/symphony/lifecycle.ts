import { ipcMain } from 'electron';
import fs from 'fs/promises';
import { logger } from '../../../utils/logger';
import { createSafeSend } from '../../../utils/safe-send';
import { createIpcHandler } from '../../../utils/ipcHandler';
import { execFileNoThrow } from '../../../utils/execFile';
import { getExpandedEnv } from '../../../agents/path-prober';
import { resolveGhPath } from '../../../utils/cliDetection';
import { captureException } from '../../../utils/sentry';
import type {
	ActiveContribution,
	CompletedContribution,
	ContributionStatus,
	CompleteContributionResponse,
} from '../../../../shared/symphony-types';
import {
	LOG_CONTEXT,
	handlerOpts,
	readState,
	writeState,
	broadcastSymphonyUpdate,
	SymphonyHandlerDependencies,
} from './shared';

/**
 * Mark PR as ready for review.
 *
 * Only `complete` (below) calls this - it was originally placed near
 * createDraftPR in the source file but a call-site check showed it's never
 * used by the PR-creation handlers, only by the completion flow.
 */
async function markPRReady(
	repoPath: string,
	prNumber: number,
	upstreamSlug?: string
): Promise<{ success: boolean; error?: string }> {
	const ghCommand = await resolveGhPath();
	const args = ['pr', 'ready', String(prNumber)];
	if (upstreamSlug) {
		args.push('--repo', upstreamSlug);
	}
	const result = await execFileNoThrow(ghCommand, args, repoPath, getExpandedEnv());

	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr };
	}

	return { success: true };
}

/**
 * Post a comment to a PR with Symphony contribution stats.
 *
 * Only `complete` (below) calls this - same call-site correction as
 * markPRReady above.
 */
async function postPRComment(
	repoPath: string,
	prNumber: number,
	stats: {
		inputTokens: number;
		outputTokens: number;
		estimatedCost: number;
		timeSpentMs: number;
		documentsProcessed: number;
		tasksCompleted: number;
	},
	upstreamSlug?: string
): Promise<{ success: boolean; error?: string }> {
	// Format time spent
	const hours = Math.floor(stats.timeSpentMs / 3600000);
	const minutes = Math.floor((stats.timeSpentMs % 3600000) / 60000);
	const seconds = Math.floor((stats.timeSpentMs % 60000) / 1000);
	const timeStr =
		hours > 0
			? `${hours}h ${minutes}m ${seconds}s`
			: minutes > 0
				? `${minutes}m ${seconds}s`
				: `${seconds}s`;

	// Format token counts with commas
	const formatNumber = (n: number) => n.toLocaleString('en-US');

	// Build the comment body
	const commentBody = `## Symphony Contribution Summary

This pull request was created using [Maestro Symphony](https://runmaestro.ai/symphony) - connecting AI-powered contributors with open source projects.

### Contribution Stats
| Metric | Value |
|--------|-------|
| Input Tokens | ${formatNumber(stats.inputTokens)} |
| Output Tokens | ${formatNumber(stats.outputTokens)} |
| Total Tokens | ${formatNumber(stats.inputTokens + stats.outputTokens)} |
| Estimated Cost | $${stats.estimatedCost.toFixed(2)} |
| Time Spent | ${timeStr} |
| Documents Processed | ${stats.documentsProcessed} |
| Tasks Completed | ${stats.tasksCompleted} |

---
*Powered by [Maestro](https://runmaestro.ai) • [Learn about Symphony](https://docs.runmaestro.ai/symphony)*`;

	const ghCommand = await resolveGhPath();
	const commentArgs = ['pr', 'comment', String(prNumber), '--body', commentBody];
	if (upstreamSlug) {
		commentArgs.push('--repo', upstreamSlug);
	}
	const result = await execFileNoThrow(ghCommand, commentArgs, repoPath, getExpandedEnv());

	if (result.exitCode !== 0) {
		return { success: false, error: result.stderr };
	}

	return { success: true };
}

/**
 * Register contribution lifecycle Symphony IPC handlers: registerActive,
 * updateStatus, complete, cancel.
 */
export function registerLifecycleHandlers({
	app,
	getMainWindow,
}: SymphonyHandlerDependencies): void {
	const safeSend = createSafeSend(getMainWindow);

	/**
	 * Register an active contribution (called when Symphony session is created).
	 * Creates an entry in the persistent state for tracking in the Active tab.
	 */
	ipcMain.handle(
		'symphony:registerActive',
		createIpcHandler(
			handlerOpts('registerActive'),
			async (params: {
				contributionId: string;
				sessionId: string;
				repoSlug: string;
				repoName: string;
				issueNumber: number;
				issueTitle: string;
				localPath: string;
				branchName: string;
				totalDocuments: number;
				agentType: string;
				draftPrNumber?: number;
				draftPrUrl?: string;
			}): Promise<{ success: boolean; error?: string }> => {
				const {
					contributionId,
					sessionId,
					repoSlug,
					repoName,
					issueNumber,
					issueTitle,
					localPath,
					branchName,
					totalDocuments,
					agentType,
					draftPrNumber,
					draftPrUrl,
				} = params;

				const state = await readState(app);

				// Check if already registered
				const existing = state.active.find((c) => c.id === contributionId);
				if (existing) {
					logger.debug('Contribution already registered', LOG_CONTEXT, { contributionId });
					return { success: true };
				}

				// Create active contribution entry
				const contribution: ActiveContribution = {
					id: contributionId,
					repoSlug,
					repoName,
					issueNumber,
					issueTitle,
					localPath,
					branchName,
					draftPrNumber,
					draftPrUrl,
					startedAt: new Date().toISOString(),
					status: 'running',
					progress: {
						totalDocuments,
						completedDocuments: 0,
						totalTasks: 0,
						completedTasks: 0,
					},
					tokenUsage: {
						inputTokens: 0,
						outputTokens: 0,
						estimatedCost: 0,
					},
					timeSpent: 0,
					sessionId,
					agentType,
				};

				state.active.push(contribution);
				await writeState(app, state);

				logger.info('Active contribution registered', LOG_CONTEXT, {
					contributionId,
					sessionId,
					repoSlug,
					issueNumber,
				});

				broadcastSymphonyUpdate(safeSend);
				return { success: true };
			}
		)
	);

	/**
	 * Update contribution status.
	 */
	ipcMain.handle(
		'symphony:updateStatus',
		createIpcHandler(
			handlerOpts('updateStatus', false),
			async (params: {
				contributionId: string;
				status?: ContributionStatus;
				progress?: Partial<ActiveContribution['progress']>;
				tokenUsage?: Partial<ActiveContribution['tokenUsage']>;
				timeSpent?: number;
				draftPrNumber?: number;
				draftPrUrl?: string;
				error?: string;
			}): Promise<{ updated: boolean }> => {
				const {
					contributionId,
					status,
					progress,
					tokenUsage,
					timeSpent,
					draftPrNumber,
					draftPrUrl,
					error,
				} = params;
				const state = await readState(app);
				const contribution = state.active.find((c) => c.id === contributionId);

				if (!contribution) {
					return { updated: false };
				}

				if (status) contribution.status = status;
				if (progress) contribution.progress = { ...contribution.progress, ...progress };
				if (tokenUsage) contribution.tokenUsage = { ...contribution.tokenUsage, ...tokenUsage };
				if (timeSpent !== undefined) contribution.timeSpent = timeSpent;
				if (draftPrNumber !== undefined) contribution.draftPrNumber = draftPrNumber;
				if (draftPrUrl !== undefined) contribution.draftPrUrl = draftPrUrl;
				if (error) contribution.error = error;

				await writeState(app, state);
				broadcastSymphonyUpdate(safeSend);
				return { updated: true };
			}
		)
	);

	/**
	 * Complete a contribution (mark PR as ready).
	 * Accepts optional stats from the frontend which override stored values.
	 */
	ipcMain.handle(
		'symphony:complete',
		createIpcHandler(
			handlerOpts('complete'),
			async (params: {
				contributionId: string;
				prBody?: string;
				stats?: {
					inputTokens: number;
					outputTokens: number;
					estimatedCost: number;
					timeSpentMs: number;
					documentsProcessed: number;
					tasksCompleted: number;
				};
			}): Promise<Omit<CompleteContributionResponse, 'success'>> => {
				const { contributionId, stats } = params;
				const state = await readState(app);
				const contributionIndex = state.active.findIndex((c) => c.id === contributionId);

				if (contributionIndex === -1) {
					return { error: 'Contribution not found' };
				}

				const contribution = state.active[contributionIndex];

				// Can't complete if there's no draft PR yet
				if (!contribution.draftPrNumber || !contribution.draftPrUrl) {
					return { error: 'No draft PR exists yet. Make a commit to create the PR first.' };
				}

				contribution.status = 'completing';
				await writeState(app, state);

				// Mark PR as ready (use upstreamSlug for fork contributions)
				const upstreamSlug =
					contribution.isFork && contribution.upstreamSlug ? contribution.upstreamSlug : undefined;
				const readyResult = await markPRReady(
					contribution.localPath,
					contribution.draftPrNumber,
					upstreamSlug
				);
				if (!readyResult.success) {
					contribution.status = 'failed';
					contribution.error = readyResult.error;
					await writeState(app, state);
					return { error: readyResult.error };
				}

				// Post PR comment with stats (use provided stats or fall back to stored values)
				const commentStats = stats || {
					inputTokens: contribution.tokenUsage.inputTokens,
					outputTokens: contribution.tokenUsage.outputTokens,
					estimatedCost: contribution.tokenUsage.estimatedCost,
					timeSpentMs: contribution.timeSpent,
					documentsProcessed: contribution.progress.completedDocuments,
					tasksCompleted: contribution.progress.completedTasks,
				};

				const commentResult = await postPRComment(
					contribution.localPath,
					contribution.draftPrNumber,
					commentStats,
					upstreamSlug
				);

				if (!commentResult.success) {
					// Log but don't fail - the PR is already ready, comment is just bonus
					logger.warn('Failed to post PR comment', LOG_CONTEXT, {
						contributionId,
						error: commentResult.error,
					});
				}

				// Use provided stats for the completed record if available
				const finalInputTokens = stats?.inputTokens ?? contribution.tokenUsage.inputTokens;
				const finalOutputTokens = stats?.outputTokens ?? contribution.tokenUsage.outputTokens;
				const finalCost = stats?.estimatedCost ?? contribution.tokenUsage.estimatedCost;
				const finalTimeSpent = stats?.timeSpentMs ?? contribution.timeSpent;
				const finalDocsProcessed =
					stats?.documentsProcessed ?? contribution.progress.completedDocuments;
				const finalTasksCompleted = stats?.tasksCompleted ?? contribution.progress.completedTasks;

				// Move to completed
				const completed: CompletedContribution = {
					id: contribution.id,
					repoSlug: contribution.repoSlug,
					repoName: contribution.repoName,
					issueNumber: contribution.issueNumber,
					issueTitle: contribution.issueTitle,
					startedAt: contribution.startedAt,
					completedAt: new Date().toISOString(),
					prUrl: contribution.draftPrUrl,
					prNumber: contribution.draftPrNumber,
					tokenUsage: {
						inputTokens: finalInputTokens,
						outputTokens: finalOutputTokens,
						totalCost: finalCost,
					},
					timeSpent: finalTimeSpent,
					documentsProcessed: finalDocsProcessed,
					tasksCompleted: finalTasksCompleted,
				};

				// Update state
				state.active.splice(contributionIndex, 1);
				state.history.push(completed);

				// Update stats
				state.stats.totalContributions += 1;
				state.stats.totalDocumentsProcessed += completed.documentsProcessed;
				state.stats.totalTasksCompleted += completed.tasksCompleted;
				state.stats.totalTokensUsed +=
					completed.tokenUsage.inputTokens + completed.tokenUsage.outputTokens;
				state.stats.totalTimeSpent += completed.timeSpent;
				state.stats.estimatedCostDonated += completed.tokenUsage.totalCost;

				if (!state.stats.repositoriesContributed.includes(contribution.repoSlug)) {
					state.stats.repositoriesContributed.push(contribution.repoSlug);
				}

				state.stats.lastContributionAt = completed.completedAt;
				if (!state.stats.firstContributionAt) {
					state.stats.firstContributionAt = completed.completedAt;
				}

				// Update streak by week (check if last contribution was this week or last week)
				const getWeekNumber = (date: Date): string => {
					const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
					const dayNum = d.getUTCDay() || 7;
					d.setUTCDate(d.getUTCDate() + 4 - dayNum);
					const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
					const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
					return `${d.getUTCFullYear()}-W${weekNo}`;
				};
				const currentWeek = getWeekNumber(new Date());
				const lastWeek = state.stats.lastContributionDate;
				if (lastWeek) {
					// Calculate previous week
					const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
					const previousWeek = getWeekNumber(oneWeekAgo);
					if (lastWeek === previousWeek || lastWeek === currentWeek) {
						// Only increment if this is a new week (not same week contribution)
						if (lastWeek !== currentWeek) {
							state.stats.currentStreak += 1;
						}
						// If same week, streak stays the same (already counted this week)
					} else {
						// Gap of more than one week, reset streak
						state.stats.currentStreak = 1;
					}
				} else {
					state.stats.currentStreak = 1;
				}
				state.stats.lastContributionDate = currentWeek;
				if (state.stats.currentStreak > state.stats.longestStreak) {
					state.stats.longestStreak = state.stats.currentStreak;
				}

				await writeState(app, state);

				logger.info('Contribution completed', LOG_CONTEXT, {
					contributionId,
					prUrl: completed.prUrl,
				});

				broadcastSymphonyUpdate(safeSend);

				return {
					prUrl: completed.prUrl,
					prNumber: completed.prNumber,
				};
			}
		)
	);

	/**
	 * Cancel an active contribution.
	 */
	ipcMain.handle(
		'symphony:cancel',
		createIpcHandler(
			handlerOpts('cancel'),
			async (contributionId: string, cleanup?: boolean): Promise<{ cancelled: boolean }> => {
				const state = await readState(app);
				const index = state.active.findIndex((c) => c.id === contributionId);

				if (index === -1) {
					return { cancelled: false };
				}

				const contribution = state.active[index];

				// Optionally cleanup local files
				if (cleanup && contribution.localPath) {
					try {
						await fs.rm(contribution.localPath, { recursive: true, force: true });
					} catch (e) {
						void captureException(e);
						logger.warn('Failed to cleanup contribution directory', LOG_CONTEXT, { error: e });
					}
				}

				// Remove from active
				state.active.splice(index, 1);
				await writeState(app, state);

				logger.info('Contribution cancelled', LOG_CONTEXT, { contributionId });

				broadcastSymphonyUpdate(safeSend);

				return { cancelled: true };
			}
		)
	);
}
