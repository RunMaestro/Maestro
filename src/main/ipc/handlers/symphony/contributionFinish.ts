import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../../utils/logger';
import { createSafeSend } from '../../../utils/safe-send';
import { createIpcHandler } from '../../../utils/ipcHandler';
import { execFileNoThrow } from '../../../utils/execFile';
import { captureException } from '../../../utils/sentry';
import type { CompletedContribution } from '../../../../shared/symphony-types';
import {
	LOG_CONTEXT,
	handlerOpts,
	readState,
	writeState,
	broadcastSymphonyUpdate,
	getSymphonyDir,
	checkGhAuthentication,
	getDefaultBranch,
	createDraftPR,
	validateContributionId,
	SymphonyHandlerDependencies,
} from './shared';

/**
 * Register contribution-finish Symphony IPC handlers: createDraftPR,
 * fetchDocumentContent, manualCredit. Handlers that wrap up or credit a
 * contribution, as opposed to contributionStart.ts which begins one.
 */
export function registerContributionFinishHandlers({
	app,
	getMainWindow,
}: SymphonyHandlerDependencies): void {
	const safeSend = createSafeSend(getMainWindow);

	/**
	 * Create draft PR for a contribution (called on first commit).
	 * Reads metadata from the contribution folder, pushes branch, and creates draft PR.
	 */
	ipcMain.handle(
		'symphony:createDraftPR',
		createIpcHandler(
			handlerOpts('createDraftPR'),
			async (params: {
				contributionId: string;
			}): Promise<{
				success: boolean;
				draftPrNumber?: number;
				draftPrUrl?: string;
				error?: string;
			}> => {
				const { contributionId } = params;

				const idValidation = validateContributionId(contributionId);
				if (!idValidation.valid) {
					return { success: false, error: idValidation.error };
				}

				// Read contribution metadata
				const metadataPath = path.join(
					getSymphonyDir(app),
					'contributions',
					contributionId,
					'metadata.json'
				);
				let metadata: {
					contributionId: string;
					sessionId: string;
					repoSlug: string;
					issueNumber: number;
					issueTitle: string;
					branchName: string;
					localPath: string;
					prCreated: boolean;
					draftPrNumber?: number;
					draftPrUrl?: string;
					upstreamDefaultBranch?: string;
					isFork?: boolean;
					forkSlug?: string;
					upstreamSlug?: string;
				};

				try {
					const content = await fs.readFile(metadataPath, 'utf-8');
					metadata = JSON.parse(content);
				} catch (e) {
					void captureException(e);
					logger.error('Failed to read contribution metadata', LOG_CONTEXT, {
						contributionId,
						error: e,
					});
					return { success: false, error: 'Contribution metadata not found' };
				}

				// Check if PR already created
				if (metadata.prCreated && metadata.draftPrUrl) {
					logger.info('Draft PR already exists', LOG_CONTEXT, {
						contributionId,
						prUrl: metadata.draftPrUrl,
					});
					return {
						success: true,
						draftPrNumber: metadata.draftPrNumber,
						draftPrUrl: metadata.draftPrUrl,
					};
				}

				// Check gh CLI authentication
				const authCheck = await checkGhAuthentication();
				if (!authCheck.authenticated) {
					return { success: false, error: authCheck.error };
				}

				const { localPath, issueNumber, issueTitle, sessionId } = metadata;

				// Check if there are any commits on this branch
				// Use rev-list to count commits not in the default branch
				// Prefer persisted upstream default branch (fork setup may have reconfigured origin)
				const baseBranch = metadata.upstreamDefaultBranch ?? (await getDefaultBranch(localPath));
				const commitCheckResult = await execFileNoThrow(
					'git',
					['rev-list', '--count', `${baseBranch}..HEAD`],
					localPath
				);

				if (commitCheckResult.exitCode !== 0) {
					logger.error('Failed to count commits ahead of base branch', LOG_CONTEXT, {
						contributionId,
						baseBranch,
						error: commitCheckResult.stderr,
					});
					return { success: false, error: `Failed to check commits: ${commitCheckResult.stderr}` };
				}

				const commitCount = parseInt(commitCheckResult.stdout.trim(), 10) || 0;
				if (commitCount === 0) {
					// No commits yet - return success but indicate no PR created
					logger.info('No commits yet, skipping PR creation', LOG_CONTEXT, { contributionId });
					return {
						success: true,
						// No PR fields - caller should know PR wasn't created yet
					};
				}

				logger.info('Found commits, creating draft PR', LOG_CONTEXT, {
					contributionId,
					commitCount,
				});

				// Create PR title and body
				const prTitle = `[WIP] Symphony: ${issueTitle} (#${issueNumber})`;
				const prBody = `## Maestro Symphony Contribution

Closes #${issueNumber}

Contributed via [Maestro Symphony](https://runmaestro.ai).

**Status:** In Progress
**Started:** ${new Date().toISOString()}

---

This PR will be updated automatically when the Auto Run completes.`;

				// Create draft PR (this also pushes the branch)
				const metaForkOwner = metadata.isFork ? metadata.forkSlug?.split('/')[0] : undefined;
				if (metadata.isFork || metadata.upstreamSlug) {
					logger.info('Creating cross-fork draft PR', LOG_CONTEXT, {
						upstreamSlug: metadata.upstreamSlug,
						forkSlug: metadata.forkSlug,
						branchName: metadata.branchName,
					});
				}
				const prResult = await createDraftPR(
					localPath,
					baseBranch,
					prTitle,
					prBody,
					metadata.upstreamSlug,
					metaForkOwner
				);
				if (!prResult.success) {
					logger.error('Failed to create draft PR', LOG_CONTEXT, {
						contributionId,
						error: prResult.error,
					});
					return { success: false, error: prResult.error };
				}

				// Update metadata with PR info
				metadata.prCreated = true;
				metadata.draftPrNumber = prResult.prNumber;
				metadata.draftPrUrl = prResult.prUrl;
				await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

				// Also update the active contribution in state with PR info
				// This is critical for checkPRStatuses to find the PR
				const state = await readState(app);
				const activeContrib = state.active.find((c) => c.id === contributionId);
				if (activeContrib) {
					activeContrib.draftPrNumber = prResult.prNumber;
					activeContrib.draftPrUrl = prResult.prUrl;
					await writeState(app, state);
				}

				// Broadcast PR creation event
				safeSend('symphony:prCreated', {
					contributionId,
					sessionId,
					draftPrNumber: prResult.prNumber,
					draftPrUrl: prResult.prUrl,
				});

				logger.info('Draft PR created for Symphony contribution', LOG_CONTEXT, {
					contributionId,
					prNumber: prResult.prNumber,
					prUrl: prResult.prUrl,
				});

				return {
					success: true,
					draftPrNumber: prResult.prNumber,
					draftPrUrl: prResult.prUrl,
				};
			}
		)
	);

	// Handler for fetching document content (from main process to avoid CORS)
	ipcMain.handle(
		'symphony:fetchDocumentContent',
		createIpcHandler(
			handlerOpts('fetchDocumentContent'),
			async (params: {
				url: string;
			}): Promise<{ success: boolean; content?: string; error?: string }> => {
				const { url } = params;

				// Validate URL - only allow GitHub URLs
				try {
					const parsed = new URL(url);
					if (
						!['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'].some(
							(host) => parsed.hostname === host || parsed.hostname.endsWith('.' + host)
						)
					) {
						return { success: false, error: 'Only GitHub URLs are allowed' };
					}
					if (parsed.protocol !== 'https:') {
						return { success: false, error: 'Only HTTPS URLs are allowed' };
					}
				} catch {
					return { success: false, error: 'Invalid URL' };
				}

				try {
					logger.info('Fetching document content', LOG_CONTEXT, { url });
					const response = await fetch(url);
					if (!response.ok) {
						return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
					}
					const content = await response.text();
					return { success: true, content };
				} catch (error) {
					logger.error('Failed to fetch document content', LOG_CONTEXT, { url, error });
					return {
						success: false,
						error: error instanceof Error ? error.message : 'Failed to fetch document',
					};
				}
			}
		)
	);

	/**
	 * Manually credit a contribution (for contributions made outside Symphony workflow).
	 * This allows crediting a user for work done on a PR that wasn't tracked through Symphony.
	 */
	ipcMain.handle(
		'symphony:manualCredit',
		createIpcHandler(
			handlerOpts('manualCredit'),
			async (params: {
				repoSlug: string;
				repoName: string;
				issueNumber: number;
				issueTitle: string;
				prNumber: number;
				prUrl: string;
				startedAt?: string;
				completedAt?: string;
				wasMerged?: boolean;
				mergedAt?: string;
				tokenUsage?: {
					inputTokens?: number;
					outputTokens?: number;
					totalCost?: number;
				};
				timeSpent?: number;
				documentsProcessed?: number;
				tasksCompleted?: number;
			}): Promise<{ contributionId?: string; error?: string }> => {
				const {
					repoSlug,
					repoName,
					issueNumber,
					issueTitle,
					prNumber,
					prUrl,
					startedAt,
					completedAt,
					wasMerged,
					mergedAt,
					tokenUsage,
					timeSpent,
					documentsProcessed,
					tasksCompleted,
				} = params;

				// Validate required fields
				if (!repoSlug || !repoName || !issueNumber || !prNumber || !prUrl) {
					return {
						error: 'Missing required fields: repoSlug, repoName, issueNumber, prNumber, prUrl',
					};
				}
				if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
					return { error: 'Invalid issue number' };
				}
				if (!Number.isInteger(prNumber) || prNumber <= 0) {
					return { error: 'Invalid PR number' };
				}

				const state = await readState(app);

				// Check if this PR is already credited
				const existingContribution = state.history.find(
					(c) => c.repoSlug === repoSlug && c.prNumber === prNumber
				);
				if (existingContribution) {
					return {
						error: `PR #${prNumber} is already credited (contribution: ${existingContribution.id})`,
					};
				}

				const now = new Date().toISOString();
				const contributionId = `manual_${issueNumber}_${Date.now()}`;

				const completed: CompletedContribution = {
					id: contributionId,
					repoSlug,
					repoName,
					issueNumber,
					issueTitle: issueTitle || `Issue #${issueNumber}`,
					startedAt: startedAt || now,
					completedAt: completedAt || now,
					prUrl,
					prNumber,
					tokenUsage: {
						inputTokens: tokenUsage?.inputTokens ?? 0,
						outputTokens: tokenUsage?.outputTokens ?? 0,
						totalCost: tokenUsage?.totalCost ?? 0,
					},
					timeSpent: timeSpent ?? 0,
					documentsProcessed: documentsProcessed ?? 0,
					tasksCompleted: tasksCompleted ?? 1,
					wasMerged: wasMerged ?? false,
					mergedAt: mergedAt,
				};

				// Add to history
				state.history.push(completed);

				// Update stats
				state.stats.totalContributions += 1;
				state.stats.totalDocumentsProcessed += completed.documentsProcessed;
				state.stats.totalTasksCompleted += completed.tasksCompleted;
				state.stats.totalTokensUsed +=
					completed.tokenUsage.inputTokens + completed.tokenUsage.outputTokens;
				state.stats.totalTimeSpent += completed.timeSpent;
				state.stats.estimatedCostDonated += completed.tokenUsage.totalCost;

				if (!state.stats.repositoriesContributed.includes(repoSlug)) {
					state.stats.repositoriesContributed.push(repoSlug);
				}

				if (wasMerged) {
					state.stats.totalMerged = (state.stats.totalMerged || 0) + 1;
					state.stats.totalIssuesResolved = (state.stats.totalIssuesResolved || 0) + 1;
				}

				state.stats.lastContributionAt = completed.completedAt;
				if (!state.stats.firstContributionAt) {
					state.stats.firstContributionAt = completed.completedAt;
				}

				// Update streak
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
					const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
					const previousWeek = getWeekNumber(oneWeekAgo);
					if (lastWeek === previousWeek || lastWeek === currentWeek) {
						if (lastWeek !== currentWeek) {
							state.stats.currentStreak += 1;
						}
					} else {
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

				logger.info('Manual contribution credited', LOG_CONTEXT, {
					contributionId,
					repoSlug,
					prNumber,
					prUrl,
				});

				broadcastSymphonyUpdate(safeSend);

				return { contributionId };
			}
		)
	);
}
