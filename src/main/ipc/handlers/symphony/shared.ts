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
 * Validate a contribution ID before it is used to build a filesystem path.
 *
 * Contribution IDs are joined into the Symphony directory by several handlers,
 * so an ID is only ever allowed to be a single path segment. Both generated
 * shapes (`contrib_<base36>_<base36>` and `manual_<issue>_<timestamp>`) fall
 * inside this character set, and dots are excluded entirely so `..` cannot
 * appear at all.
 */
export function validateContributionId(contributionId: string): {
	valid: boolean;
	error?: string;
} {
	if (!contributionId || typeof contributionId !== 'string') {
		return { valid: false, error: 'Contribution ID is required' };
	}
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(contributionId)) {
		return { valid: false, error: `Invalid contribution ID: ${contributionId}` };
	}
	return { valid: true };
}

/**
 * Reduce a document reference name to a safe file name for the documents cache.
 *
 * `validateContributionParams()` already checks `doc.path`, but the name is
 * what gets joined onto the cache directory when an external document is
 * downloaded. The name comes from the link text of a markdown link in a GitHub
 * issue body, so a perfectly ordinary issue can produce "docs/architecture.md".
 * Rejecting separators outright would refuse those real documents, so the last
 * segment is taken instead, which neutralises traversal without losing the
 * document. Both separators are handled explicitly because `path.basename()`
 * only treats a backslash as one on win32.
 *
 * Returns null when no usable file name remains.
 */
export function toSafeDocumentFileName(name: string): string | null {
	if (!name || typeof name !== 'string' || name.includes('\0')) {
		return null;
	}
	const base = name.split(/[/\\]/).pop()?.trim();
	// A leading dot covers "." and ".." as well as hidden files.
	if (!base || base.startsWith('.') || base.length > 255) {
		return null;
	}
	return base;
}

/**
 * Pick a file name that does not collide with one already used in this batch.
 *
 * Reducing names to their last segment means two distinct references such as
 * `docs/architecture.md` and `spec/architecture.md` both arrive here as
 * `architecture.md`. Writing both would silently leave only the second, so the
 * later one is suffixed instead. `used` is mutated to record the result.
 */
export function uniqueDocumentFileName(fileName: string, used: Set<string>): string {
	const key = fileName.toLowerCase();
	if (!used.has(key)) {
		used.add(key);
		return fileName;
	}
	const dot = fileName.lastIndexOf('.');
	const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
	const ext = dot > 0 ? fileName.slice(dot) : '';
	for (let i = 2; i < 1000; i++) {
		const candidate = `${stem}-${i}${ext}`;
		if (!used.has(candidate.toLowerCase())) {
			used.add(candidate.toLowerCase());
			return candidate;
		}
	}
	// Pathological input only. The caller skips the document.
	return '';
}

/**
 * Confirm a recorded local path really is the clone Symphony made for this
 * contribution, before anything deletes it recursively.
 *
 * `localPath` arrives from the renderer and is stored as-is, because a user is
 * allowed to pick their own working directory. That means the path itself
 * cannot be constrained to a known root without breaking the feature, so the
 * destructive operation is guarded instead: a directory is only ever removed
 * when it is a git checkout whose origin points at the repository the
 * contribution is for.
 *
 * The repository name is matched rather than the full slug, because fork setup
 * rewrites origin to the contributor's own fork. The comparison is against the
 * final segment of the origin only: an origin URL also carries the host and the
 * owner, so a substring test would accept an unrelated checkout such as
 * `https://github.com/maestro/some-other-project.git` for slug `owner/maestro`.
 *
 * This predicate authorises a recursive delete, so every unknown case fails
 * closed.
 */
export async function isContributionClone(localPath: string, repoSlug?: string): Promise<boolean> {
	if (!localPath || typeof localPath !== 'string' || !path.isAbsolute(localPath)) {
		return false;
	}
	// A clone always has a .git entry. A plain directory such as a user's
	// Documents folder does not, so it can never reach the removal below.
	try {
		await fs.access(path.join(localPath, '.git'));
	} catch {
		return false;
	}
	const repoName = repoSlug?.split('/')[1]?.toLowerCase();
	if (!repoName) {
		return false;
	}
	const result = await execFileNoThrow('git', ['remote', 'get-url', 'origin'], localPath);
	if (result.exitCode !== 0) {
		return false;
	}
	// Handles both https URLs and scp-style remotes (git@host:owner/repo.git).
	const originRepo = result.stdout
		.trim()
		.replace(/\.git$/i, '')
		.split(/[/:]/)
		.pop()
		?.toLowerCase();
	return !!originRepo && originRepo === repoName;
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
