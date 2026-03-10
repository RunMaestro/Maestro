/**
 * Symphony Runner Service
 *
 * Orchestrates contributions using Auto Run with draft PR claiming.
 */

import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { execFileNoThrow } from '../utils/execFile';
import { ensureForkSetup } from '../utils/symphony-fork';
import type { DocumentReference } from '../../shared/symphony-types';

const LOG_CONTEXT = '[SymphonyRunner]';

/**
 * Clean up local repository directory on failure.
 */
async function cleanupLocalRepo(localPath: string): Promise<void> {
	try {
		await fs.rm(localPath, { recursive: true, force: true });
		logger.info('Cleaned up local repository', LOG_CONTEXT, { localPath });
	} catch (error) {
		logger.warn('Failed to cleanup local repository', LOG_CONTEXT, { localPath, error });
	}
}

export interface SymphonyRunnerOptions {
	contributionId: string;
	repoSlug: string;
	repoUrl: string;
	issueNumber: number;
	issueTitle: string;
	documentPaths: DocumentReference[];
	localPath: string;
	branchName: string;
	onProgress?: (progress: { completedDocuments: number; totalDocuments: number }) => void;
	onStatusChange?: (status: string) => void;
}

/**
 * Clone repository to local path (shallow clone for speed).
 */
async function cloneRepo(repoUrl: string, localPath: string): Promise<boolean> {
	logger.info('Cloning repository', LOG_CONTEXT, { repoUrl, localPath });
	const result = await execFileNoThrow('git', ['clone', '--depth=1', repoUrl, localPath]);
	return result.exitCode === 0;
}

/**
 * Create and checkout a new branch.
 */
async function createBranch(localPath: string, branchName: string): Promise<boolean> {
	const result = await execFileNoThrow('git', ['checkout', '-b', branchName], localPath);
	return result.exitCode === 0;
}

/**
 * Configure git user for commits (required for users without global git config).
 */
async function configureGitUser(localPath: string): Promise<boolean> {
	const nameResult = await execFileNoThrow(
		'git',
		['config', 'user.name', 'Maestro Symphony'],
		localPath
	);
	if (nameResult.exitCode !== 0) {
		logger.warn('Failed to set git user.name', LOG_CONTEXT, { error: nameResult.stderr });
		return false;
	}
	const emailResult = await execFileNoThrow(
		'git',
		['config', 'user.email', 'symphony@runmaestro.ai'],
		localPath
	);
	if (emailResult.exitCode !== 0) {
		logger.warn('Failed to set git user.email', LOG_CONTEXT, { error: emailResult.stderr });
		return false;
	}
	return true;
}

/**
 * Create an empty commit to enable pushing without changes.
 */
async function createEmptyCommit(localPath: string, message: string): Promise<boolean> {
	const result = await execFileNoThrow(
		'git',
		['commit', '--allow-empty', '-m', message],
		localPath
	);
	return result.exitCode === 0;
}

/**
 * Push branch to origin.
 */
async function pushBranch(localPath: string, branchName: string): Promise<boolean> {
	const result = await execFileNoThrow('git', ['push', '-u', 'origin', branchName], localPath);
	return result.exitCode === 0;
}

/**
 * Create a draft PR using GitHub CLI.
 */
async function createDraftPR(
	localPath: string,
	issueNumber: number,
	issueTitle: string,
	upstreamSlug?: string,
	forkOwner?: string
): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
	const title = `[WIP] Symphony: ${issueTitle}`;
	const body = `## Symphony Contribution

This draft PR was created via Maestro Symphony.

Closes #${issueNumber}

---

*Work in progress - will be updated when Auto Run completes*`;

	const args = ['pr', 'create', '--draft', '--title', title, '--body', body];

	if (upstreamSlug) {
		args.push('--repo', upstreamSlug);
	}
	if (upstreamSlug && forkOwner) {
		// For cross-fork PRs, --head must specify the fork owner and branch
		const branchResult = await execFileNoThrow(
			'git',
			['rev-parse', '--abbrev-ref', 'HEAD'],
			localPath
		);
		const branchName = branchResult.stdout.trim();
		if (!branchName || branchResult.exitCode !== 0) {
			return { success: false, error: 'Failed to determine current branch name' };
		}
		args.push('--head', `${forkOwner}:${branchName}`);
	}

	const result = await execFileNoThrow('gh', args, localPath);

	if (result.exitCode !== 0) {
		return { success: false, error: `PR creation failed: ${result.stderr}` };
	}

	const prUrl = result.stdout.trim();
	const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);

	return {
		success: true,
		prUrl,
		prNumber: prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined,
	};
}

/**
 * Download a file from a URL.
 */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
	try {
		const response = await fetch(url);
		if (!response.ok) {
			logger.error('Failed to download file', LOG_CONTEXT, { url, status: response.status });
			return false;
		}
		const buffer = await response.arrayBuffer();
		await fs.writeFile(destPath, Buffer.from(buffer));
		return true;
	} catch (error) {
		logger.error('Error downloading file', LOG_CONTEXT, { url, error });
		return false;
	}
}

/**
 * Copy or download Auto Run documents to local Auto Run Docs folder.
 * Handles both repo-relative paths and external URLs (GitHub attachments).
 */
async function setupAutoRunDocs(
	localPath: string,
	documentPaths: DocumentReference[]
): Promise<string> {
	const autoRunPath = path.posix.join(localPath, 'Auto Run Docs');
	await fs.mkdir(autoRunPath, { recursive: true });

	for (const doc of documentPaths) {
		const destPath = path.posix.join(autoRunPath, doc.name);

		if (doc.isExternal) {
			// Download external file (GitHub attachment)
			logger.info('Downloading external document', LOG_CONTEXT, { name: doc.name, url: doc.path });
			const success = await downloadFile(doc.path, destPath);
			if (!success) {
				logger.warn('Failed to download document, skipping', LOG_CONTEXT, { name: doc.name });
			}
		} else {
			// Copy from repo using Node.js fs API
			const sourcePath = path.posix.join(localPath, doc.path);
			try {
				await fs.copyFile(sourcePath, destPath);
			} catch (error) {
				logger.warn('Failed to copy document', LOG_CONTEXT, {
					name: doc.name,
					source: sourcePath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	return autoRunPath;
}

/**
 * Start a Symphony contribution.
 *
 * Flow:
 * 1. Clone the repository (shallow)
 * 2. Create a new branch
 * 3. Create an empty commit
 * 4. Push the branch
 * 5. Create a draft PR (claims the issue via "Closes #N")
 * 6. Set up Auto Run documents
 */
export async function startContribution(options: SymphonyRunnerOptions): Promise<{
	success: boolean;
	draftPrUrl?: string;
	draftPrNumber?: number;
	autoRunPath?: string;
	isFork?: boolean;
	forkSlug?: string;
	error?: string;
}> {
	const {
		repoSlug,
		repoUrl,
		localPath,
		branchName,
		issueNumber,
		issueTitle,
		documentPaths,
		onStatusChange,
	} = options;

	try {
		// 1. Clone
		onStatusChange?.('cloning');
		if (!(await cloneRepo(repoUrl, localPath))) {
			return { success: false, error: 'Clone failed' };
		}

		// 2. Create branch
		onStatusChange?.('setting_up');
		if (!(await createBranch(localPath, branchName))) {
			await cleanupLocalRepo(localPath);
			return { success: false, error: 'Branch creation failed' };
		}

		// 2.5. Fork setup — detect if user needs a fork for push access
		logger.info('Checking fork requirements', LOG_CONTEXT, { repoSlug });
		const forkResult = await ensureForkSetup(localPath, repoSlug);
		if (forkResult.error) {
			await cleanupLocalRepo(localPath);
			return { success: false, error: `Fork setup failed: ${forkResult.error}` };
		}
		if (forkResult.isFork) {
			logger.info('Using fork for contribution', LOG_CONTEXT, {
				forkSlug: forkResult.forkSlug,
				upstreamSlug: repoSlug,
			});
		} else {
			logger.info('User has push access, no fork needed', LOG_CONTEXT, { repoSlug });
		}

		// 2.6. Configure git user for commits
		await configureGitUser(localPath);

		// 3. Empty commit
		const commitMessage = `[Symphony] Start contribution for #${issueNumber}`;
		if (!(await createEmptyCommit(localPath, commitMessage))) {
			await cleanupLocalRepo(localPath);
			return { success: false, error: 'Empty commit failed' };
		}

		// 4. Push branch
		if (!(await pushBranch(localPath, branchName))) {
			await cleanupLocalRepo(localPath);
			return { success: false, error: 'Push failed' };
		}

		// 5. Create draft PR (cross-fork if needed)
		const forkOwner =
			forkResult.isFork && forkResult.forkSlug ? forkResult.forkSlug.split('/')[0] : undefined;
		if (forkResult.isFork) {
			logger.info('Creating cross-fork draft PR', LOG_CONTEXT, {
				upstreamSlug: repoSlug,
				forkSlug: forkResult.forkSlug,
				branchName,
			});
		}
		const prResult = await createDraftPR(
			localPath,
			issueNumber,
			issueTitle,
			forkResult.isFork ? repoSlug : undefined,
			forkOwner
		);
		if (!prResult.success) {
			await cleanupLocalRepo(localPath);
			return { success: false, error: prResult.error };
		}

		// 6. Setup Auto Run docs
		const autoRunPath = await setupAutoRunDocs(localPath, documentPaths);

		// Ready - actual Auto Run processing happens via session
		onStatusChange?.('running');

		return {
			success: true,
			draftPrUrl: prResult.prUrl,
			draftPrNumber: prResult.prNumber,
			autoRunPath,
			isFork: forkResult.isFork,
			forkSlug: forkResult.forkSlug,
		};
	} catch (error) {
		await cleanupLocalRepo(localPath);
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error',
		};
	}
}

/**
 * Finalize a contribution by converting draft PR to ready for review.
 */
export async function finalizeContribution(
	localPath: string,
	prNumber: number,
	issueNumber: number,
	issueTitle: string,
	upstreamSlug?: string
): Promise<{ success: boolean; prUrl?: string; error?: string }> {
	// Configure git user for commits (in case not already configured)
	await configureGitUser(localPath);

	// Commit all changes
	await execFileNoThrow('git', ['add', '-A'], localPath);

	const commitMessage = `[Symphony] Complete contribution for #${issueNumber}

Processed all Auto Run documents for: ${issueTitle}`;

	const commitResult = await execFileNoThrow('git', ['commit', '-m', commitMessage], localPath);
	if (commitResult.exitCode !== 0 && !commitResult.stderr.includes('nothing to commit')) {
		return { success: false, error: `Commit failed: ${commitResult.stderr}` };
	}

	// Push changes (origin points to fork if ensureForkSetup ran)
	const pushResult = await execFileNoThrow('git', ['push'], localPath);
	if (pushResult.exitCode !== 0) {
		return { success: false, error: `Push failed: ${pushResult.stderr}` };
	}

	// Convert draft to ready for review
	const readyArgs = ['pr', 'ready', prNumber.toString()];
	if (upstreamSlug) readyArgs.push('--repo', upstreamSlug);
	const readyResult = await execFileNoThrow('gh', readyArgs, localPath);
	if (readyResult.exitCode !== 0) {
		return { success: false, error: `Failed to mark PR ready: ${readyResult.stderr}` };
	}

	// Update PR body with completion summary
	const body = `## Symphony Contribution

This PR was created via Maestro Symphony.

Closes #${issueNumber}

---

**Task:** ${issueTitle}

*Contributed by the Maestro Symphony community* 🎵`;

	const editArgs = ['pr', 'edit', prNumber.toString(), '--body', body];
	if (upstreamSlug) editArgs.push('--repo', upstreamSlug);
	await execFileNoThrow('gh', editArgs, localPath);

	// Get final PR URL
	const viewArgs = ['pr', 'view', prNumber.toString(), '--json', 'url', '-q', '.url'];
	if (upstreamSlug) viewArgs.push('--repo', upstreamSlug);
	const prInfoResult = await execFileNoThrow('gh', viewArgs, localPath);

	return {
		success: true,
		prUrl: prInfoResult.stdout.trim(),
	};
}

/**
 * Cancel a contribution by closing the draft PR and cleaning up.
 */
export async function cancelContribution(
	localPath: string,
	prNumber: number,
	cleanup: boolean = true,
	upstreamSlug?: string
): Promise<{ success: boolean; error?: string }> {
	// Close the draft PR
	const closeArgs = ['pr', 'close', prNumber.toString()];
	if (!upstreamSlug) {
		// Only delete branch for non-fork PRs — cross-fork delete-branch fails due to permissions
		closeArgs.push('--delete-branch');
	} else {
		closeArgs.push('--repo', upstreamSlug);
	}
	const closeResult = await execFileNoThrow('gh', closeArgs, localPath);
	if (closeResult.exitCode !== 0) {
		logger.warn('Failed to close PR', LOG_CONTEXT, { prNumber, error: closeResult.stderr });
		return {
			success: false,
			error: `Failed to close PR #${prNumber}: ${closeResult.stderr || closeResult.stdout}`,
		};
	}

	// Clean up local directory using Node.js fs API
	if (cleanup) {
		await cleanupLocalRepo(localPath);
	}

	return { success: true };
}
