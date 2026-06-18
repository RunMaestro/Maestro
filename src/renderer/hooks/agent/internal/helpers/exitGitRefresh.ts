/**
 * Re-fetch git branches/tags after a shell command that may have moved refs.
 *
 * Returns the new branches/tags or `null` when no refresh was warranted (the
 * last shell command was not a ref-mutating git command, or the session is
 * not a git repo). The caller decides whether to write back to the store.
 *
 * Skipping the write when arrays are referentially equal is the caller's
 * responsibility (so it can compare against the previous state inside its
 * own setSessions reducer).
 */

import { gitService } from '../../../../services/git';
import type { Session } from '../../../../types';

const GIT_REF_COMMANDS = [
	'git branch',
	'git checkout',
	'git switch',
	'git fetch',
	'git pull',
	'git tag',
	'git merge',
	'git rebase',
	'git reset',
];

export interface GitRefRefreshResult {
	gitBranches: Awaited<ReturnType<typeof gitService.getBranches>>;
	gitTags: Awaited<ReturnType<typeof gitService.getTags>>;
}

export function isGitRefMutatingCommand(command: string): boolean {
	const trimmed = command.trim().toLowerCase();
	return GIT_REF_COMMANDS.some((cmd) => trimmed.startsWith(cmd));
}

export async function refreshGitRefsAfterTerminalExit(
	session: Pick<
		Session,
		'isGitRepo' | 'cwd' | 'shellLogs' | 'sshRemoteId' | 'sessionSshRemoteConfig'
	>
): Promise<GitRefRefreshResult | null> {
	if (!session.isGitRepo) return null;

	const userLogs = session.shellLogs.filter((log) => log.source === 'user');
	const lastCommand = userLogs[userLogs.length - 1]?.text ?? '';

	if (!isGitRefMutatingCommand(lastCommand)) return null;

	const sshRemoteId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId || undefined;

	const [gitBranches, gitTags] = await Promise.all([
		gitService.getBranches(session.cwd, sshRemoteId),
		gitService.getTags(session.cwd, sshRemoteId),
	]);

	return { gitBranches, gitTags };
}
