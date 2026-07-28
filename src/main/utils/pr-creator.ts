/**
 * GitHub pull request creation from a worktree branch.
 *
 * This is the ONE gh-CLI PR implementation. The body was lifted out of the
 * `git:createPR` IPC handler so it can be called from places that are not an
 * IPC handler (the Board's per-card "open PR when done" option) - the handler
 * now delegates to it, so there is no second copy of the push + `gh pr create`
 * logic to keep in sync.
 *
 * The `git:createPR` handler always passes an explicit target branch (its
 * renderer caller resolves the default branch itself), so target resolution
 * lives here for callers that do NOT have a renderer: explicit value, else the
 * repository default branch, else `main`. {@link resolveDefaultBranch} is the
 * same logic the `git:getDefaultBranch` handler serves, exported here so both
 * paths share one implementation.
 *
 * Deliberately Electron-free (only `child_process` via {@link execFileNoThrow})
 * so the main process can call it outside the IPC layer. Logging and warning
 * reporting are injected sinks rather than direct `logger` / Sentry imports.
 */

import { execFileNoThrow } from './execFile';
import { resolveGhPath } from './cliDetection';
import { getShellPath } from '../runtime/getShellPath';

/** Optional log sink so callers keep their existing debug output. */
export type PrLog = (message: string) => void;

/** Options for {@link createPullRequest}. */
export interface CreatePullRequestOptions {
	/** Worktree directory whose branch is pushed and turned into a PR. */
	worktreePath: string;
	/**
	 * Main repository checkout, used only to resolve the default branch when
	 * `targetBranch` is omitted. Falls back to `worktreePath` when absent.
	 */
	mainRepoCwd?: string;
	/** Explicit PR base branch. When omitted the repo default branch is used. */
	targetBranch?: string;
	/** PR title. */
	title: string;
	/** PR body. */
	body: string;
	/** Custom path to the `gh` binary. Detection is used when omitted. */
	ghPath?: string;
	/** Debug log sink. */
	log?: PrLog;
	/** Non-fatal warning sink (Sentry in the IPC handler, logger elsewhere). */
	warn?: PrLog;
}

/** Result of {@link createPullRequest}. */
export interface CreatePullRequestResult {
	success: boolean;
	/** URL of the created PR, when `success`. */
	prUrl?: string;
	/** Branch the PR was opened against, once resolved. */
	targetBranch?: string;
	/** Failure reason when `success` is false. */
	error?: string;
}

/**
 * Resolve a repository's default branch: ask the remote first, then fall back
 * to a local `main` or `master`. Returns null when none of those answer.
 */
export async function resolveDefaultBranch(cwd: string): Promise<string | null> {
	// First try to get the default branch from remote
	const remoteResult = await execFileNoThrow('git', ['remote', 'show', 'origin'], cwd);
	if (remoteResult.exitCode === 0) {
		// Parse "HEAD branch: main" from the output
		const match = remoteResult.stdout.match(/HEAD branch:\s*(\S+)/);
		if (match) {
			return match[1];
		}
	}

	// Fallback: check if main or master exists locally
	const mainResult = await execFileNoThrow('git', ['rev-parse', '--verify', 'main'], cwd);
	if (mainResult.exitCode === 0) {
		return 'main';
	}

	const masterResult = await execFileNoThrow('git', ['rev-parse', '--verify', 'master'], cwd);
	if (masterResult.exitCode === 0) {
		return 'master';
	}

	return null;
}

/**
 * Push the worktree's current branch to origin and open a PR with the gh CLI.
 * Never throws for expected failures (missing gh, push rejected, gh error) -
 * those come back as `{ success: false, error }`.
 */
export async function createPullRequest(
	options: CreatePullRequestOptions
): Promise<CreatePullRequestResult> {
	const { worktreePath, mainRepoCwd, title, body, ghPath, log, warn } = options;

	// Resolve the base branch: explicit value, else the repo default, else main
	let targetBranch = options.targetBranch;
	if (!targetBranch) {
		targetBranch = (await resolveDefaultBranch(mainRepoCwd || worktreePath)) || 'main';
	}

	// Resolve gh CLI path (uses cached detection or custom path)
	const ghCommand = await resolveGhPath(ghPath);
	log?.(`Using gh CLI at: ${ghCommand}`);

	// Build env with the user's full shell PATH so git hooks
	// (e.g. Husky pre-push running npm) can find Node/npm binaries
	let shellEnv: NodeJS.ProcessEnv | undefined;
	try {
		const shellPath = await getShellPath();
		if (shellPath) {
			shellEnv = { ...process.env, PATH: shellPath };
		}
	} catch (error) {
		warn?.(
			`createPullRequest falling back to default PATH: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	// First, push the current branch to origin
	const pushResult = await execFileNoThrow(
		'git',
		['push', '-u', 'origin', 'HEAD'],
		worktreePath,
		shellEnv
	);
	if (pushResult.exitCode !== 0) {
		return { success: false, targetBranch, error: `Failed to push branch: ${pushResult.stderr}` };
	}

	// Create the PR using gh CLI
	const prResult = await execFileNoThrow(
		ghCommand,
		['pr', 'create', '--base', targetBranch, '--title', title, '--body', body],
		worktreePath,
		shellEnv
	);

	if (prResult.exitCode !== 0) {
		// Check if gh CLI is not installed
		if (
			prResult.stderr.includes('command not found') ||
			prResult.stderr.includes('not recognized')
		) {
			return {
				success: false,
				targetBranch,
				error: 'GitHub CLI (gh) is not installed. Please install it to create PRs.',
			};
		}
		return { success: false, targetBranch, error: prResult.stderr || 'Failed to create PR' };
	}

	// The PR URL is typically in stdout
	const prUrl = prResult.stdout.trim();
	return { success: true, prUrl, targetBranch };
}
