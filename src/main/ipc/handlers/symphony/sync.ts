import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../../utils/logger';
import { createSafeSend } from '../../../utils/safe-send';
import { createIpcHandler } from '../../../utils/ipcHandler';
import { fetchWithTimeout } from '../../../utils/fetchWithTimeout';
import { GITHUB_API_BASE } from '../../../../shared/symphony-constants';
import type { CompletedContribution } from '../../../../shared/symphony-types';
import {
	LOG_CONTEXT,
	handlerOpts,
	readState,
	writeState,
	writeCache,
	broadcastSymphonyUpdate,
	getSymphonyDir,
	SymphonyHandlerDependencies,
	SYMPHONY_GITHUB_API_TIMEOUT_MS,
} from './shared';

/**
 * Discover an existing PR for a branch by querying GitHub API.
 * This handles cases where PRs were created manually (via gh CLI or GitHub UI)
 * but not tracked in Symphony metadata.
 */
async function discoverPRByBranch(
	repoSlug: string,
	branchName: string,
	headOwner?: string
): Promise<{ prNumber?: number; prUrl?: string }> {
	try {
		// Query GitHub API for PRs with this head branch
		// API: GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all
		// For cross-fork PRs, headOwner is the fork owner (branch lives on fork, PR targets upstream)
		const [owner] = repoSlug.split('/');
		const headRef = `${headOwner || owner}:${branchName}`;
		const apiUrl = `${GITHUB_API_BASE}/repos/${repoSlug}/pulls?head=${encodeURIComponent(headRef)}&state=all&per_page=1`;

		const response = await fetchWithTimeout(
			apiUrl,
			{
				headers: {
					Accept: 'application/vnd.github.v3+json',
					'User-Agent': 'Maestro-Symphony',
				},
			},
			SYMPHONY_GITHUB_API_TIMEOUT_MS
		);

		if (!response.ok) {
			logger.warn('Failed to query GitHub for PRs by branch', LOG_CONTEXT, {
				repoSlug,
				branchName,
				status: response.status,
			});
			return {};
		}

		const prs = (await response.json()) as Array<{
			number: number;
			html_url: string;
			state: string;
		}>;

		if (prs.length > 0) {
			const pr = prs[0];
			logger.info('Discovered existing PR for branch', LOG_CONTEXT, {
				repoSlug,
				branchName,
				prNumber: pr.number,
				state: pr.state,
			});
			return {
				prNumber: pr.number,
				prUrl: pr.html_url,
			};
		}

		return {};
	} catch (error) {
		logger.warn('Error discovering PR by branch', LOG_CONTEXT, {
			repoSlug,
			branchName,
			error: error instanceof Error ? error.message : String(error),
		});
		return {};
	}
}

/**
 * Register sync Symphony IPC handlers: checkPRStatuses, syncContribution, clearCache.
 */
export function registerSyncHandlers({ app, getMainWindow }: SymphonyHandlerDependencies): void {
	const safeSend = createSafeSend(getMainWindow);

	/**
	 * Check PR statuses for all completed contributions and update merged status.
	 * Moves PRs that are merged/closed from active to history (for ready_for_review PRs).
	 * Returns summary of what changed.
	 */
	ipcMain.handle(
		'symphony:checkPRStatuses',
		createIpcHandler(
			handlerOpts('checkPRStatuses'),
			async (): Promise<{
				checked: number;
				merged: number;
				closed: number;
				errors: string[];
			}> => {
				const state = await readState(app);
				const results = {
					checked: 0,
					merged: 0,
					closed: 0,
					errors: [] as string[],
				};

				// Check history entries that might have been merged
				for (const completed of state.history) {
					if (!completed.prNumber || !completed.repoSlug) continue;
					if (completed.wasMerged) continue; // Already tracked as merged

					results.checked++;

					try {
						// Fetch PR status from GitHub API
						const prUrl = `${GITHUB_API_BASE}/repos/${completed.repoSlug}/pulls/${completed.prNumber}`;
						const response = await fetchWithTimeout(
							prUrl,
							{
								headers: {
									Accept: 'application/vnd.github.v3+json',
									'User-Agent': 'Maestro-Symphony',
								},
							},
							SYMPHONY_GITHUB_API_TIMEOUT_MS
						);

						if (!response.ok) {
							results.errors.push(`Failed to check PR #${completed.prNumber}: ${response.status}`);
							continue;
						}

						const pr = (await response.json()) as {
							state: string;
							merged: boolean;
							merged_at: string | null;
						};

						if (pr.merged) {
							// PR was merged - update history entry and stats
							completed.wasMerged = true;
							completed.mergedAt = pr.merged_at || new Date().toISOString();
							state.stats.totalMerged += 1;
							results.merged++;

							logger.info('PR merged detected', LOG_CONTEXT, {
								prNumber: completed.prNumber,
								repoSlug: completed.repoSlug,
							});
						} else if (pr.state === 'closed') {
							// PR was closed without merge
							completed.wasClosed = true;
							results.closed++;

							logger.info('PR closed detected', LOG_CONTEXT, {
								prNumber: completed.prNumber,
								repoSlug: completed.repoSlug,
							});
						}
					} catch (error) {
						const errMsg = error instanceof Error ? error.message : String(error);
						results.errors.push(`Error checking PR #${completed.prNumber}: ${errMsg}`);
					}
				}

				// First, sync PR info and fork info from metadata.json for active contributions
				// This handles cases where PR was created but state.json wasn't updated (migration)
				let prInfoSynced = false;
				for (const contribution of state.active) {
					// Skip if both PR info and fork info are already synced
					if (contribution.draftPrNumber && contribution.isFork !== undefined) {
						continue;
					}
					try {
						const metadataPath = path.join(
							getSymphonyDir(app),
							'contributions',
							contribution.id,
							'metadata.json'
						);
						const metadataContent = await fs.readFile(metadataPath, 'utf-8');
						const metadata = JSON.parse(metadataContent) as {
							prCreated?: boolean;
							draftPrNumber?: number;
							draftPrUrl?: string;
							isFork?: boolean;
							forkSlug?: string;
							upstreamSlug?: string;
						};
						if (!contribution.draftPrNumber && metadata.prCreated && metadata.draftPrNumber) {
							// Sync PR info from metadata to state
							contribution.draftPrNumber = metadata.draftPrNumber;
							contribution.draftPrUrl = metadata.draftPrUrl;
							prInfoSynced = true;
							logger.info('Synced PR info from metadata to state', LOG_CONTEXT, {
								contributionId: contribution.id,
								draftPrNumber: metadata.draftPrNumber,
							});
						}
						// Sync fork info from metadata to state (independent of PR info)
						if (
							metadata.isFork &&
							metadata.forkSlug &&
							metadata.upstreamSlug &&
							!contribution.isFork
						) {
							contribution.isFork = metadata.isFork;
							contribution.forkSlug = metadata.forkSlug;
							contribution.upstreamSlug = metadata.upstreamSlug;
						}
					} catch {
						// Metadata file might not exist - that's okay
					}
				}

				// Second, try to discover PRs by branch name for contributions still missing PR info
				// This handles PRs created manually via gh CLI or GitHub UI
				for (const contribution of state.active) {
					if (!contribution.draftPrNumber && contribution.branchName && contribution.repoSlug) {
						const forkHeadOwner = contribution.isFork
							? contribution.forkSlug?.split('/')[0]
							: undefined;
						const discovered = await discoverPRByBranch(
							contribution.repoSlug,
							contribution.branchName,
							forkHeadOwner
						);
						if (discovered.prNumber) {
							contribution.draftPrNumber = discovered.prNumber;
							contribution.draftPrUrl = discovered.prUrl;
							prInfoSynced = true;
							logger.info('Discovered PR from branch during status check', LOG_CONTEXT, {
								contributionId: contribution.id,
								branchName: contribution.branchName,
								draftPrNumber: discovered.prNumber,
							});
						}
					}
				}

				// Also check active contributions that have a draft PR
				// These might have been merged/closed externally
				const activeToMove: number[] = [];
				for (let i = 0; i < state.active.length; i++) {
					const contribution = state.active[i];
					// Check any active contribution with a PR (not just ready_for_review)
					if (!contribution.draftPrNumber) continue;

					results.checked++;

					try {
						const prUrl = `${GITHUB_API_BASE}/repos/${contribution.repoSlug}/pulls/${contribution.draftPrNumber}`;
						const response = await fetchWithTimeout(
							prUrl,
							{
								headers: {
									Accept: 'application/vnd.github.v3+json',
									'User-Agent': 'Maestro-Symphony',
								},
							},
							SYMPHONY_GITHUB_API_TIMEOUT_MS
						);

						if (!response.ok) {
							results.errors.push(
								`Failed to check PR #${contribution.draftPrNumber}: ${response.status}`
							);
							continue;
						}

						const pr = (await response.json()) as {
							state: string;
							merged: boolean;
							merged_at: string | null;
						};

						if (pr.merged || pr.state === 'closed') {
							// Move to history
							const completed: CompletedContribution = {
								id: contribution.id,
								repoSlug: contribution.repoSlug,
								repoName: contribution.repoName,
								issueNumber: contribution.issueNumber,
								issueTitle: contribution.issueTitle,
								documentsProcessed: contribution.progress.completedDocuments,
								tasksCompleted: contribution.progress.completedTasks,
								timeSpent: contribution.timeSpent,
								startedAt: contribution.startedAt,
								completedAt: new Date().toISOString(),
								prUrl: contribution.draftPrUrl || '',
								prNumber: contribution.draftPrNumber,
								tokenUsage: {
									inputTokens: contribution.tokenUsage.inputTokens,
									outputTokens: contribution.tokenUsage.outputTokens,
									totalCost: contribution.tokenUsage.estimatedCost,
								},
								wasMerged: pr.merged,
								mergedAt: pr.merged ? pr.merged_at || new Date().toISOString() : undefined,
								wasClosed: pr.state === 'closed' && !pr.merged,
							};

							state.history.push(completed);
							activeToMove.push(i);

							if (pr.merged) {
								state.stats.totalMerged += 1;
								results.merged++;
							} else {
								results.closed++;
							}

							logger.info('Active contribution moved to history', LOG_CONTEXT, {
								contributionId: contribution.id,
								merged: pr.merged,
								closed: pr.state === 'closed',
							});
						}
					} catch (error) {
						const errMsg = error instanceof Error ? error.message : String(error);
						results.errors.push(`Error checking PR #${contribution.draftPrNumber}: ${errMsg}`);
					}
				}

				// Remove moved contributions from active (in reverse order to preserve indices)
				for (let i = activeToMove.length - 1; i >= 0; i--) {
					state.active.splice(activeToMove[i], 1);
				}

				await writeState(app, state);

				if (results.merged > 0 || results.closed > 0 || prInfoSynced) {
					broadcastSymphonyUpdate(safeSend);
				}

				logger.info('PR status check complete', LOG_CONTEXT, { ...results, prInfoSynced });

				return results;
			}
		)
	);

	/**
	 * Sync a single contribution's status with GitHub.
	 * Checks for PR status, syncs metadata, and attempts recovery if needed.
	 */
	ipcMain.handle(
		'symphony:syncContribution',
		createIpcHandler(
			handlerOpts('syncContribution'),
			async (
				contributionId: string
			): Promise<{
				success: boolean;
				message?: string;
				prCreated?: boolean;
				prMerged?: boolean;
				prClosed?: boolean;
				error?: string;
			}> => {
				const state = await readState(app);
				const contribution = state.active.find((c) => c.id === contributionId);

				if (!contribution) {
					return { success: false, error: 'Contribution not found' };
				}

				let message = '';
				let prCreated = false;
				let prMerged = false;
				let prClosed = false;

				try {
					// Step 1: Check if we have PR info or fork info in metadata but not in state
					if (!contribution.draftPrNumber || !contribution.isFork) {
						const metadataPath = path.join(
							getSymphonyDir(app),
							'contributions',
							contribution.id,
							'metadata.json'
						);
						try {
							const metadataContent = await fs.readFile(metadataPath, 'utf-8');
							const metadata = JSON.parse(metadataContent) as {
								prCreated?: boolean;
								draftPrNumber?: number;
								draftPrUrl?: string;
								isFork?: boolean;
								forkSlug?: string;
								upstreamSlug?: string;
							};
							if (!contribution.draftPrNumber && metadata.prCreated && metadata.draftPrNumber) {
								contribution.draftPrNumber = metadata.draftPrNumber;
								contribution.draftPrUrl = metadata.draftPrUrl;
								prCreated = true;
								message = `Synced PR #${metadata.draftPrNumber} from metadata`;
								logger.info('Synced PR info from metadata', LOG_CONTEXT, {
									contributionId,
									draftPrNumber: metadata.draftPrNumber,
								});
							}
							// Sync fork info from metadata to state (independent of PR info)
							if (
								metadata.isFork &&
								metadata.forkSlug &&
								metadata.upstreamSlug &&
								!contribution.isFork
							) {
								contribution.isFork = metadata.isFork;
								contribution.forkSlug = metadata.forkSlug;
								contribution.upstreamSlug = metadata.upstreamSlug;
							}
						} catch {
							// Metadata file might not exist - that's okay, we'll try to create PR
						}
					}

					// Step 2: If still no PR, try to discover it from GitHub by branch name
					// This handles PRs created manually via gh CLI or GitHub UI
					if (!contribution.draftPrNumber && contribution.branchName && contribution.repoSlug) {
						const forkHeadOwner = contribution.isFork
							? contribution.forkSlug?.split('/')[0]
							: undefined;
						const discovered = await discoverPRByBranch(
							contribution.repoSlug,
							contribution.branchName,
							forkHeadOwner
						);
						if (discovered.prNumber) {
							contribution.draftPrNumber = discovered.prNumber;
							contribution.draftPrUrl = discovered.prUrl;
							prCreated = true;
							message = `Discovered PR #${discovered.prNumber} from branch ${contribution.branchName}`;
							logger.info('Discovered PR from branch', LOG_CONTEXT, {
								contributionId,
								branchName: contribution.branchName,
								draftPrNumber: discovered.prNumber,
							});
						}
					}

					// Step 3: If still no PR, log info for manual intervention
					if (!contribution.draftPrNumber && contribution.localPath) {
						try {
							// Check if local path exists
							await fs.access(contribution.localPath);
							// Local path exists but no PR - user may need to trigger PR creation
							logger.info(
								'Contribution has no PR - user may need to trigger PR creation manually',
								LOG_CONTEXT,
								{ contributionId }
							);
							if (!message) {
								message = 'No PR exists yet - contribution may still be in progress';
							}
						} catch {
							// Local path doesn't exist
							logger.warn('Local path not accessible for contribution', LOG_CONTEXT, {
								contributionId,
								localPath: contribution.localPath,
							});
						}
					}

					// Step 4: If we have a PR, check its status
					if (contribution.draftPrNumber) {
						const prUrl = `${GITHUB_API_BASE}/repos/${contribution.repoSlug}/pulls/${contribution.draftPrNumber}`;
						const response = await fetchWithTimeout(
							prUrl,
							{
								headers: {
									Accept: 'application/vnd.github.v3+json',
									'User-Agent': 'Maestro-Symphony',
								},
							},
							SYMPHONY_GITHUB_API_TIMEOUT_MS
						);

						if (response.ok) {
							const pr = (await response.json()) as {
								state: string;
								merged: boolean;
								merged_at: string | null;
								draft: boolean;
							};

							if (pr.merged) {
								// PR was merged - move to history
								prMerged = true;
								const completed: CompletedContribution = {
									id: contribution.id,
									repoSlug: contribution.repoSlug,
									repoName: contribution.repoName,
									issueNumber: contribution.issueNumber,
									issueTitle: contribution.issueTitle,
									documentsProcessed: contribution.progress.completedDocuments,
									tasksCompleted: contribution.progress.completedTasks,
									timeSpent: contribution.timeSpent,
									startedAt: contribution.startedAt,
									completedAt: pr.merged_at || new Date().toISOString(),
									prUrl: contribution.draftPrUrl || '',
									prNumber: contribution.draftPrNumber,
									tokenUsage: {
										inputTokens: contribution.tokenUsage.inputTokens,
										outputTokens: contribution.tokenUsage.outputTokens,
										totalCost: contribution.tokenUsage.estimatedCost,
									},
									wasMerged: true,
									mergedAt: pr.merged_at || new Date().toISOString(),
								};

								// Remove from active, add to history
								const index = state.active.findIndex((c) => c.id === contributionId);
								if (index !== -1) {
									state.active.splice(index, 1);
								}
								state.history.push(completed);
								state.stats.totalMerged += 1;
								message = `PR #${contribution.draftPrNumber} was merged!`;
							} else if (pr.state === 'closed') {
								// PR was closed without merge
								prClosed = true;
								const completed: CompletedContribution = {
									id: contribution.id,
									repoSlug: contribution.repoSlug,
									repoName: contribution.repoName,
									issueNumber: contribution.issueNumber,
									issueTitle: contribution.issueTitle,
									documentsProcessed: contribution.progress.completedDocuments,
									tasksCompleted: contribution.progress.completedTasks,
									timeSpent: contribution.timeSpent,
									startedAt: contribution.startedAt,
									completedAt: new Date().toISOString(),
									prUrl: contribution.draftPrUrl || '',
									prNumber: contribution.draftPrNumber,
									tokenUsage: {
										inputTokens: contribution.tokenUsage.inputTokens,
										outputTokens: contribution.tokenUsage.outputTokens,
										totalCost: contribution.tokenUsage.estimatedCost,
									},
									wasClosed: true,
								};

								const index = state.active.findIndex((c) => c.id === contributionId);
								if (index !== -1) {
									state.active.splice(index, 1);
								}
								state.history.push(completed);
								message = `PR #${contribution.draftPrNumber} was closed`;
							} else if (!pr.draft && contribution.status === 'running') {
								// PR is no longer draft but status shows running - update to ready_for_review
								contribution.status = 'ready_for_review';
								message = `PR #${contribution.draftPrNumber} is ready for review`;
							} else if (!message) {
								message = `PR #${contribution.draftPrNumber} synced (${pr.draft ? 'draft' : 'ready'})`;
							}
						} else {
							logger.warn('Failed to fetch PR status', LOG_CONTEXT, {
								contributionId,
								prNumber: contribution.draftPrNumber,
								status: response.status,
							});
							if (!message) {
								message = `Could not check PR status (HTTP ${response.status})`;
							}
						}
					}

					// Save updated state
					await writeState(app, state);
					broadcastSymphonyUpdate(safeSend);

					return {
						success: true,
						message: message || 'Synced successfully',
						prCreated,
						prMerged,
						prClosed,
					};
				} catch (error) {
					logger.error('Failed to sync contribution', LOG_CONTEXT, { contributionId, error });
					return {
						success: false,
						error: error instanceof Error ? error.message : 'Unknown error',
					};
				}
			}
		)
	);

	/**
	 * Clear cache.
	 */
	ipcMain.handle(
		'symphony:clearCache',
		createIpcHandler(handlerOpts('clearCache'), async (): Promise<{ cleared: boolean }> => {
			await writeCache(app, { issues: {} });
			return { cleared: true };
		})
	);
}
