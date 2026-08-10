import { App, BrowserWindow } from 'electron';
import type Store from 'electron-store';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../../utils/logger';
import { SafeSendFn } from '../../../utils/safe-send';
import type { SessionsData, MaestroSettings } from '../../../stores/types';
import { CreateHandlerOptions } from '../../../utils/ipcHandler';
import { execFileNoThrow } from '../../../utils/execFile';
import { getExpandedEnv } from '../../../agents/path-prober';
import { resolveGhPath } from '../../../utils/cliDetection';
import {
	SYMPHONY_STATE_PATH,
	SYMPHONY_CACHE_PATH,
	SYMPHONY_REPOS_DIR,
	DEFAULT_CONTRIBUTOR_STATS,
} from '../../../../shared/symphony-constants';
import type { SymphonyCache, SymphonyState } from '../../../../shared/symphony-types';

export const LOG_CONTEXT = '[Symphony]';

export interface SymphonyHandlerDependencies {
	app: App;
	getMainWindow: () => BrowserWindow | null;
	sessionsStore: Store<SessionsData>;
	settingsStore: Store<MaestroSettings>;
}

export const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Get the symphony directory path.
 */
export function getSymphonyDir(app: App): string {
	return path.join(app.getPath('userData'), 'symphony');
}

/**
 * Get cache file path.
 */
export function getCachePath(app: App): string {
	return path.join(getSymphonyDir(app), SYMPHONY_CACHE_PATH);
}

/**
 * Get state file path.
 */
export function getStatePath(app: App): string {
	return path.join(getSymphonyDir(app), SYMPHONY_STATE_PATH);
}

/**
 * Get repos directory path.
 */
export function getReposDir(app: App): string {
	return path.join(getSymphonyDir(app), SYMPHONY_REPOS_DIR);
}

/**
 * Ensure symphony directory exists.
 */
export async function ensureSymphonyDir(app: App): Promise<void> {
	const dir = getSymphonyDir(app);
	await fs.mkdir(dir, { recursive: true });
}

/**
 * Write cache to disk.
 */
export async function writeCache(app: App, cache: SymphonyCache): Promise<void> {
	await ensureSymphonyDir(app);
	await fs.writeFile(getCachePath(app), JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * Read symphony state from disk.
 */
export async function readState(app: App): Promise<SymphonyState> {
	try {
		const content = await fs.readFile(getStatePath(app), 'utf-8');
		return JSON.parse(content) as SymphonyState;
	} catch {
		// Return default state
		return {
			active: [],
			history: [],
			stats: { ...DEFAULT_CONTRIBUTOR_STATS },
		};
	}
}

/**
 * Write symphony state to disk.
 */
export async function writeState(app: App, state: SymphonyState): Promise<void> {
	await ensureSymphonyDir(app);
	await fs.writeFile(getStatePath(app), JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Broadcast symphony state updates to renderer.
 */
export function broadcastSymphonyUpdate(safeSend: SafeSendFn): void {
	safeSend('symphony:updated');
}

/**
 * Check if gh CLI is authenticated.
 */
export async function checkGhAuthentication(): Promise<{ authenticated: boolean; error?: string }> {
	const ghCommand = await resolveGhPath();
	const result = await execFileNoThrow(ghCommand, ['auth', 'status'], undefined, getExpandedEnv());
	if (result.exitCode !== 0) {
		// gh auth status outputs to stderr even on success for some info
		const output = result.stderr + result.stdout;
		if (output.includes('not logged in') || output.includes('no accounts')) {
			return {
				authenticated: false,
				error: 'GitHub CLI is not authenticated. Run "gh auth login" to authenticate.',
			};
		}
		// If gh CLI is not installed
		if (output.includes('command not found') || output.includes('not recognized')) {
			return {
				authenticated: false,
				error: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/',
			};
		}
		return { authenticated: false, error: `GitHub CLI error: ${output}` };
	}
	return { authenticated: true };
}

/**
 * Get the default branch of a repository.
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
	// Try to get the default branch from remote
	const result = await execFileNoThrow(
		'git',
		['symbolic-ref', 'refs/remotes/origin/HEAD'],
		repoPath
	);
	if (result.exitCode === 0) {
		// Output is like "refs/remotes/origin/main"
		const branch = result.stdout.trim().replace('refs/remotes/origin/', '');
		if (branch) return branch;
	}

	// Fallback: try common branch names
	const checkResult = await execFileNoThrow(
		'git',
		['ls-remote', '--heads', 'origin', 'main'],
		repoPath
	);
	if (checkResult.exitCode === 0 && checkResult.stdout.includes('refs/heads/main')) {
		return 'main';
	}

	const masterCheck = await execFileNoThrow(
		'git',
		['ls-remote', '--heads', 'origin', 'master'],
		repoPath
	);
	if (masterCheck.exitCode === 0 && masterCheck.stdout.includes('refs/heads/master')) {
		return 'master';
	}

	// Default to main if we can't determine
	return 'main';
}

/**
 * Push branch and create draft PR using gh CLI.
 *
 * Shared between contributionStart.ts (start, startContribution) and
 * contributionFinish.ts (the createDraftPR handler) - all three call the
 * same helper on the same code path.
 */
export async function createDraftPR(
	repoPath: string,
	baseBranch: string,
	title: string,
	body: string,
	upstreamSlug?: string,
	forkOwner?: string
): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
	// Check gh authentication first
	const authCheck = await checkGhAuthentication();
	if (!authCheck.authenticated) {
		return { success: false, error: authCheck.error };
	}

	// Get current branch name
	const branchResult = await execFileNoThrow(
		'git',
		['rev-parse', '--abbrev-ref', 'HEAD'],
		repoPath
	);
	const branchName = branchResult.stdout.trim();
	if (!branchName || branchResult.exitCode !== 0) {
		return { success: false, error: 'Failed to determine current branch' };
	}

	// First push the branch
	const pushResult = await execFileNoThrow('git', ['push', '-u', 'origin', branchName], repoPath);

	if (pushResult.exitCode !== 0) {
		return { success: false, error: `Failed to push: ${pushResult.stderr}` };
	}

	// Create draft PR using gh CLI (use --head to explicitly specify the branch)
	const prArgs = [
		'pr',
		'create',
		'--draft',
		'--base',
		baseBranch,
		'--head',
		// For fork contributions, use "forkOwner:branchName" to specify the fork's branch
		upstreamSlug && forkOwner ? `${forkOwner}:${branchName}` : branchName,
		'--title',
		title,
		'--body',
		body,
	];

	// For fork contributions, target the upstream repo
	if (upstreamSlug) {
		prArgs.push('--repo', upstreamSlug);
	}

	const ghCommand = await resolveGhPath();
	const prResult = await execFileNoThrow(ghCommand, prArgs, repoPath, getExpandedEnv());

	if (prResult.exitCode !== 0) {
		// If PR creation failed after push, try to delete the remote branch.
		// Note: In fork mode, `origin` points to the user's fork (set by ensureForkSetup),
		// so this correctly deletes the branch from the fork, not the upstream repo.
		logger.warn('PR creation failed, attempting to clean up remote branch', LOG_CONTEXT);
		await execFileNoThrow('git', ['push', 'origin', '--delete', branchName], repoPath);
		return { success: false, error: `Failed to create PR: ${prResult.stderr}` };
	}

	// Parse PR URL from output
	const prUrl = prResult.stdout.trim();
	const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
	const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;

	return { success: true, prUrl, prNumber };
}

/**
 * Log that symphony handlers were registered. Called once, from the composer,
 * after every domain's registerXHandlers() has run.
 */
export function logHandlersRegistered(): void {
	logger.info('Symphony handlers registered', LOG_CONTEXT);
}
