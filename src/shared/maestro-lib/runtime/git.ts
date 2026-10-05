/**
 * The few local git reads and the one write a headless Auto Run needs: the branch for template
 * variables, whether a folder is a repository, and the checkpoint commit after a goal iteration.
 *
 * Local only. An agent on an SSH remote runs Auto Run on the desktop for now (the runtime refuses
 * it), so nothing here has a remote form.
 */

import { execFileNoThrow } from '../launch/exec-file';

/** The current branch, or `undefined` outside a repository or on a detached head with no name. */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
	const result = await execFileNoThrow('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
	if (result.exitCode !== 0) return undefined;
	return result.stdout.trim() || undefined;
}

export async function isGitRepository(cwd: string): Promise<boolean> {
	const result = await execFileNoThrow('git', ['rev-parse', '--is-inside-work-tree'], cwd);
	return result.exitCode === 0 && result.stdout.trim() === 'true';
}

export interface CommitAllResult {
	committed: boolean;
	commitHash?: string;
	/** Why nothing was committed when that was not simply "nothing changed". */
	error?: string;
}

/**
 * Stage everything and commit it. A clean tree is a quiet `committed: false`; a failed commit (no
 * git identity, a failing hook) is reported in `error`. Never throws.
 */
export async function commitAll(cwd: string, message: string): Promise<CommitAllResult> {
	const fail = (step: string, stderr: string): CommitAllResult => ({
		committed: false,
		error: `${step} failed: ${stderr.trim() || 'no output'}`,
	});
	const add = await execFileNoThrow('git', ['add', '-A'], cwd);
	if (add.exitCode !== 0) return fail('git add', add.stderr);
	const status = await execFileNoThrow('git', ['status', '--porcelain'], cwd);
	if (status.exitCode !== 0) return fail('git status', status.stderr);
	if (!status.stdout.trim()) return { committed: false };
	const commit = await execFileNoThrow('git', ['commit', '-m', message], cwd);
	if (commit.exitCode !== 0) return fail('git commit', commit.stderr || commit.stdout);
	const head = await execFileNoThrow('git', ['rev-parse', '--short', 'HEAD'], cwd);
	const commitHash = head.exitCode === 0 ? head.stdout.trim() : '';
	return { committed: true, ...(commitHash ? { commitHash } : {}) };
}
