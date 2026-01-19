/**
 * useWorktreeValidation Hook
 *
 * Extracted from BatchRunnerModal.tsx to manage git worktree path validation.
 *
 * This hook encapsulates:
 * - Debounced worktree path validation (500ms)
 * - Git repository detection and status checking
 * - Branch existence and mismatch detection
 * - Same-repo validation (prevents using worktrees from different repos)
 * - Uncommitted changes detection for branch checkout warnings
 *
 * The validation runs when:
 * - worktreeEnabled is true
 * - worktreePath changes
 * - branchName changes
 *
 * Dependencies:
 * - worktreePath: The target worktree directory path
 * - branchName: The target branch for the worktree
 * - worktreeEnabled: Whether worktree feature is enabled
 * - sessionCwd: The session's current working directory (main repo)
 */

import { useState, useEffect } from 'react';
import type { WorktreeValidationState } from '../../types';
import { hasUncommittedChanges } from '../../../shared/gitUtils';

/**
 * Dependencies required by the hook
 */
export interface UseWorktreeValidationDeps {
	/** The target worktree directory path */
	worktreePath: string;
	/** The target branch name for the worktree */
	branchName: string;
	/** Whether worktree feature is enabled */
	worktreeEnabled: boolean;
	/** The session's current working directory (main repo) */
	sessionCwd: string;
	/** SSH remote ID for remote sessions (optional) */
	sshRemoteId?: string;
}

/**
 * Return type for the hook
 */
export interface UseWorktreeValidationReturn {
	/** Current validation state */
	validation: WorktreeValidationState;
}

/** Default initial validation state */
const INITIAL_VALIDATION_STATE: WorktreeValidationState = {
	checking: false,
	exists: false,
	isWorktree: false,
	branchMismatch: false,
	sameRepo: true,
	hasUncommittedChanges: false,
};

/** Debounce delay for validation checks (ms) */
const VALIDATION_DEBOUNCE_MS = 500;

/**
 * Hook for managing git worktree path validation in BatchRunnerModal
 *
 * Provides debounced validation of worktree paths including:
 * - Path existence checking
 * - Git worktree detection
 * - Branch mismatch warnings
 * - Same-repository validation
 * - Uncommitted changes detection
 *
 * @example
 * ```tsx
 * const { validation } = useWorktreeValidation({
 *   worktreePath,
 *   branchName,
 *   worktreeEnabled,
 *   sessionCwd,
 * });
 *
 * // Use validation state in UI
 * {validation.branchMismatch && <Warning>Branch mismatch!</Warning>}
 * {validation.error && <Error>{validation.error}</Error>}
 * ```
 */
export function useWorktreeValidation({
	worktreePath,
	branchName,
	worktreeEnabled,
	sessionCwd,
	sshRemoteId,
}: UseWorktreeValidationDeps): UseWorktreeValidationReturn {
	const [validation, setValidation] = useState<WorktreeValidationState>(INITIAL_VALIDATION_STATE);

	// Validate worktree path when it changes (debounced 500ms)
	useEffect(() => {
		// Reset validation state when worktree is disabled or path is empty
		if (!worktreeEnabled || !worktreePath) {
			setValidation(INITIAL_VALIDATION_STATE);
			return;
		}

		// Set checking state immediately
		setValidation((prev) => ({ ...prev, checking: true }));

		// Debounce the validation check
		const timeoutId = setTimeout(async () => {
			try {
				// Check if the path exists and get worktree info
				const worktreeInfoResult = await window.maestro.git.worktreeInfo(worktreePath, sshRemoteId);

				if (!worktreeInfoResult.success) {
					setValidation({
						checking: false,
						exists: false,
						isWorktree: false,
						branchMismatch: false,
						sameRepo: true,
						hasUncommittedChanges: false,
						error: worktreeInfoResult.error,
					});
					return;
				}

				// If the path doesn't exist, that's fine - it will be created
				if (!worktreeInfoResult.exists) {
					setValidation({
						checking: false,
						exists: false,
						isWorktree: false,
						branchMismatch: false,
						sameRepo: true,
						hasUncommittedChanges: false,
					});
					return;
				}

				// Path exists - check if it's part of the same repo
				// If there's no repoRoot, the directory exists but isn't a git repo - that's fine for a new worktree
				const mainRepoRootResult = await window.maestro.git.getRepoRoot(sessionCwd, sshRemoteId);
				const sameRepo =
					!worktreeInfoResult.repoRoot ||
					(mainRepoRootResult.success && worktreeInfoResult.repoRoot === mainRepoRootResult.root);

				// Check for branch mismatch (only if branch name is provided AND the path is already a git repo)
				// If there's no currentBranch, the directory isn't a git repo yet, so no mismatch
				const branchMismatch =
					branchName !== '' &&
					worktreeInfoResult.currentBranch !== undefined &&
					worktreeInfoResult.currentBranch !== branchName;

				// If there's a branch mismatch and it's the same repo, check for uncommitted changes
				// This helps warn users that checkout will fail if there are uncommitted changes
				let hasChanges = false;
				if (branchMismatch && sameRepo) {
					try {
						// Use git status to check for uncommitted changes in the worktree
						// Pass sshRemoteId to support remote worktree validation
						const statusResult = await window.maestro.git.status(worktreePath, sshRemoteId);
						hasChanges = hasUncommittedChanges(statusResult.stdout);
					} catch {
						// If we can't check, assume no uncommitted changes
						hasChanges = false;
					}
				}

				setValidation({
					checking: false,
					exists: true,
					isWorktree: worktreeInfoResult.isWorktree || false,
					currentBranch: worktreeInfoResult.currentBranch,
					branchMismatch,
					sameRepo,
					hasUncommittedChanges: hasChanges,
					error: !sameRepo ? 'This path contains a worktree for a different repository' : undefined,
				});
			} catch (error) {
				console.error('Failed to validate worktree path:', error);
				setValidation({
					checking: false,
					exists: false,
					isWorktree: false,
					branchMismatch: false,
					sameRepo: true,
					hasUncommittedChanges: false,
					error: 'Failed to validate worktree path',
				});
			}
		}, VALIDATION_DEBOUNCE_MS);

		// Cleanup timeout on unmount or when dependencies change
		return () => clearTimeout(timeoutId);
	}, [worktreePath, branchName, worktreeEnabled, sessionCwd, sshRemoteId]);

	return { validation };
}
