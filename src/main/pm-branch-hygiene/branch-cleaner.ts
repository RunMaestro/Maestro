/**
 * Branch Hygiene — sweepMergedBranches (#435)
 *
 * Finds local branches whose tip is already reachable from the default branch
 * (i.e. merged), and whose last commit is older than `graceDays` days.
 * Protected branches and the current HEAD are always skipped.
 *
 * The function is side-effect free when `dryRun: true`; callers in production
 * pass `dryRun: false` to actually delete.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─── Public surface ───────────────────────────────────────────────────────────

export interface BranchCleanerOptions {
	/** Branches younger than this many days are left alone. Default: 14. */
	graceDays?: number;
	/** Branches that must never be deleted. Default: ['main', 'rc', 'humpf-dev']. */
	protectedBranches?: string[];
	/** When true, log what would be deleted but do not run `git branch -D`. Default: false. */
	dryRun?: boolean;
}

export interface SweepResult {
	deleted: string[];
	skipped: { branch: string; reason: string }[];
}

/**
 * Delete local branches that are:
 *   1. fully merged into `defaultBranch` (`git branch --merged`), AND
 *   2. whose last commit is older than `graceDays` days.
 *
 * Protected branches and the current HEAD are always skipped.
 */
export async function sweepMergedBranches(
	repoPath: string,
	defaultBranch: string,
	opts: BranchCleanerOptions = {}
): Promise<SweepResult> {
	const graceDays = opts.graceDays ?? 14;
	const protected_ = new Set(opts.protectedBranches ?? ['main', 'rc', 'humpf-dev']);
	const dryRun = opts.dryRun ?? false;

	const result: SweepResult = { deleted: [], skipped: [] };

	// ── 1. Find branches merged into defaultBranch ──────────────────────────
	const mergedRaw = await git(repoPath, ['branch', '--merged', defaultBranch]);
	if (mergedRaw === null) {
		// git failed (e.g. not a git repo, or defaultBranch doesn't exist) — skip silently
		return result;
	}

	const mergedBranches = mergedRaw
		.split('\n')
		.map((l) => l.replace(/^\*?\s+/, '').trim())
		.filter(Boolean);

	// ── 2. Determine the current HEAD branch so we never delete it ──────────
	const headRef = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
	const headBranch = headRef?.trim() ?? '';

	// ── 3. Evaluate each candidate ──────────────────────────────────────────
	const graceCutoffSecs = Math.floor(Date.now() / 1000) - graceDays * 86400;

	for (const branch of mergedBranches) {
		if (!branch) continue;

		// Skip protected names
		if (protected_.has(branch)) {
			result.skipped.push({ branch, reason: 'protected' });
			continue;
		}

		// Skip the default branch itself (it will always appear in --merged)
		if (branch === defaultBranch) {
			result.skipped.push({ branch, reason: 'default-branch' });
			continue;
		}

		// Skip current HEAD
		if (branch === headBranch) {
			result.skipped.push({ branch, reason: 'current-head' });
			continue;
		}

		// ── Grace period check ─────────────────────────────────────────────
		const committerDateRaw = await git(repoPath, [
			'for-each-ref',
			`--format=%(committerdate:unix)`,
			`refs/heads/${branch}`,
		]);

		const committerDateSecs = parseInt(committerDateRaw?.trim() ?? '0', 10);
		if (!committerDateSecs || committerDateSecs > graceCutoffSecs) {
			result.skipped.push({ branch, reason: 'within-grace-period' });
			continue;
		}

		// ── Delete ─────────────────────────────────────────────────────────
		if (!dryRun) {
			const deleteResult = await git(repoPath, ['branch', '-D', branch]);
			if (deleteResult === null) {
				result.skipped.push({ branch, reason: 'delete-failed' });
				continue;
			}
		}

		result.deleted.push(branch);
	}

	return result;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Run a git command, returning stdout on success or `null` on failure.
 * Errors are swallowed so callers can handle them gracefully without crashing
 * the cron loop.
 */
async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
		return stdout;
	} catch {
		return null;
	}
}
