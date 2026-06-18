import { useMemo } from 'react';
import { useGitBranch, useGitDetail, useGitFileStatus } from '../../contexts/GitStatusContext';
import type { Session } from '../../types';

export interface GitInfo {
	branch: string;
	remote: string;
	behind: number;
	ahead: number;
	uncommittedChanges: number;
}

/**
 * Consolidates git status from focused contexts into a single gitInfo object.
 *
 * Uses separate context hooks (branch, file status, detail) to minimize
 * cascade re-renders — branch info rarely changes, file counts change on
 * file operations, detail info is only for the active session.
 */
export function useGitInfo(activeSession: Session | null) {
	// Git status from focused contexts (reduces cascade re-renders)
	// Branch info: branch name, remote, ahead/behind - rarely changes
	const { getBranchInfo } = useGitBranch();
	// File counts: file count per session - changes on file operations
	const { getFileCount } = useGitFileStatus();
	// Detail info: detailed file changes, refreshGitStatus - only for active session
	const { refreshGitStatus } = useGitDetail();

	// Derive gitInfo format from focused context data for backward compatibility
	const branchInfo = activeSession ? getBranchInfo(activeSession.id) : undefined;
	const fileCount = activeSession ? getFileCount(activeSession.id) : 0;
	const gitInfo = useMemo<GitInfo | null>(
		() =>
			branchInfo && activeSession?.isGitRepo
				? {
						branch: branchInfo.branch || '',
						remote: branchInfo.remote || '',
						behind: branchInfo.behind,
						ahead: branchInfo.ahead,
						uncommittedChanges: fileCount,
					}
				: null,
		[
			branchInfo?.branch,
			branchInfo?.remote,
			branchInfo?.behind,
			branchInfo?.ahead,
			activeSession?.isGitRepo,
			fileCount,
		]
	);

	return { gitInfo, refreshGitStatus };
}
