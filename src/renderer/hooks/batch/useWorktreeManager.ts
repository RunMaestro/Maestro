/**
 * useWorktreeManager - Git worktree operations for batch processing
 *
 * Extracted from useBatchProcessor.ts for modularity. Handles:
 * - Git worktree setup and checkout
 * - Branch mismatch detection and resolution
 * - Pull request creation after batch completion
 */

import { useCallback } from 'react';
import type { BatchDocumentEntry } from '../../types';

/**
 * Configuration for worktree operations
 */
export interface WorktreeConfig {
	/** Whether worktree mode is enabled */
	enabled: boolean;
	/** Path where the worktree should be created */
	path?: string;
	/** Branch name to use for the worktree */
	branchName?: string;
	/** Whether to create a PR on batch completion */
	createPROnCompletion?: boolean;
	/** Target branch for the PR (falls back to default branch) */
	prTargetBranch?: string;
	/** Path to gh CLI binary (if not in PATH) */
	ghPath?: string;
	/** SSH remote ID for remote sessions (optional) */
	sshRemoteId?: string;
}

/**
 * Result of worktree setup operation
 */
export interface WorktreeSetupResult {
	/** Whether the setup was successful */
	success: boolean;
	/** The effective CWD to use for operations */
	effectiveCwd: string;
	/** Whether worktree mode is active */
	worktreeActive: boolean;
	/** Path to the worktree (if active) */
	worktreePath?: string;
	/** Branch name in the worktree (if active) */
	worktreeBranch?: string;
	/** Error message if setup failed */
	error?: string;
}

/**
 * Result of PR creation operation
 */
export interface PRCreationResult {
	/** Whether the PR was created successfully */
	success: boolean;
	/** URL of the created PR */
	prUrl?: string;
	/** Error message if creation failed */
	error?: string;
}

/**
 * Options for creating a PR
 */
export interface CreatePROptions {
	/** The worktree path to create PR from */
	worktreePath: string;
	/** The main repository CWD (for default branch detection) */
	mainRepoCwd: string;
	/** Worktree configuration */
	worktree: WorktreeConfig;
	/** Documents that were processed */
	documents: BatchDocumentEntry[];
	/** Total tasks completed across all documents */
	totalCompletedTasks: number;
}

/**
 * Return type for useWorktreeManager hook
 */
export interface UseWorktreeManagerReturn {
	/** Set up a git worktree for batch processing */
	setupWorktree: (
		sessionCwd: string,
		worktree: WorktreeConfig | undefined
	) => Promise<WorktreeSetupResult>;
	/** Create a pull request after batch completion */
	createPR: (options: CreatePROptions) => Promise<PRCreationResult>;
	/** Generate PR body from document list and task count */
	generatePRBody: (documents: BatchDocumentEntry[], totalTasksCompleted: number) => string;
}

/**
 * Hook for managing git worktree operations during batch processing
 */
export function useWorktreeManager(): UseWorktreeManagerReturn {
	/**
	 * Generate PR body from completed tasks
	 */
	const generatePRBody = useCallback(
		(documents: BatchDocumentEntry[], totalTasksCompleted: number): string => {
			const docList = documents.map((d) => `- ${d.filename}`).join('\n');
			return `## Auto Run Summary

**Documents processed:**
${docList}

**Total tasks completed:** ${totalTasksCompleted}

---
*This PR was automatically created by Maestro Auto Run.*`;
		},
		[]
	);

	/**
	 * Set up a git worktree for batch processing
	 *
	 * - If worktree is not enabled or missing config, returns the session CWD
	 * - If worktree exists but on different branch, checks out the requested branch
	 * - Returns the effective CWD to use for operations
	 */
	const setupWorktree = useCallback(
		async (
			sessionCwd: string,
			worktree: WorktreeConfig | undefined
		): Promise<WorktreeSetupResult> => {
			// Default result when worktree is not enabled
			const defaultResult: WorktreeSetupResult = {
				success: true,
				effectiveCwd: sessionCwd,
				worktreeActive: false,
			};

			// If worktree is not enabled, return session CWD
			if (!worktree?.enabled) {
				return defaultResult;
			}

			// If worktree is enabled but missing path or branch, log warning and return session CWD
			if (!worktree.path || !worktree.branchName) {
				window.maestro.logger.log(
					'warn',
					'Worktree enabled but missing configuration',
					'WorktreeManager',
					{
						hasPath: !!worktree.path,
						hasBranchName: !!worktree.branchName,
					}
				);
				return defaultResult;
			}

			console.log(
				'[WorktreeManager] Setting up worktree at',
				worktree.path,
				'with branch',
				worktree.branchName
			);
			window.maestro.logger.log('info', 'Setting up worktree', 'WorktreeManager', {
				worktreePath: worktree.path,
				branchName: worktree.branchName,
				sessionCwd,
			});

			try {
				// Set up or reuse the worktree
				const setupResult = await window.maestro.git.worktreeSetup(
					sessionCwd,
					worktree.path,
					worktree.branchName,
					worktree.sshRemoteId
				);

				window.maestro.logger.log('info', 'worktreeSetup result', 'WorktreeManager', {
					success: setupResult.success,
					error: setupResult.error,
					branchMismatch: setupResult.branchMismatch,
				});

				if (!setupResult.success) {
					console.error('[WorktreeManager] Failed to set up worktree:', setupResult.error);
					window.maestro.logger.log('error', 'Failed to set up worktree', 'WorktreeManager', {
						error: setupResult.error,
					});
					return {
						success: false,
						effectiveCwd: sessionCwd,
						worktreeActive: false,
						error: setupResult.error || 'Failed to set up worktree',
					};
				}

				// If worktree exists but on different branch, checkout the requested branch
				if (setupResult.branchMismatch) {
					console.log(
						'[WorktreeManager] Worktree exists with different branch, checking out',
						worktree.branchName
					);
					window.maestro.logger.log(
						'info',
						'Worktree branch mismatch, checking out requested branch',
						'WorktreeManager',
						{ branchName: worktree.branchName }
					);

					const checkoutResult = await window.maestro.git.worktreeCheckout(
						worktree.path,
						worktree.branchName,
						true, // createIfMissing
						worktree.sshRemoteId
					);

					window.maestro.logger.log('info', 'worktreeCheckout result', 'WorktreeManager', {
						success: checkoutResult.success,
						error: checkoutResult.error,
						hasUncommittedChanges: checkoutResult.hasUncommittedChanges,
					});

					if (!checkoutResult.success) {
						if (checkoutResult.hasUncommittedChanges) {
							console.error('[WorktreeManager] Cannot checkout: worktree has uncommitted changes');
							window.maestro.logger.log(
								'error',
								'Cannot checkout: worktree has uncommitted changes',
								'WorktreeManager',
								{ worktreePath: worktree.path }
							);
							return {
								success: false,
								effectiveCwd: sessionCwd,
								worktreeActive: false,
								error: 'Worktree has uncommitted changes - cannot checkout branch',
							};
						} else {
							console.error('[WorktreeManager] Failed to checkout branch:', checkoutResult.error);
							window.maestro.logger.log('error', 'Failed to checkout branch', 'WorktreeManager', {
								error: checkoutResult.error,
							});
							return {
								success: false,
								effectiveCwd: sessionCwd,
								worktreeActive: false,
								error: checkoutResult.error || 'Failed to checkout branch',
							};
						}
					}
				}

				// Worktree is ready - return the worktree path as effective CWD
				console.log('[WorktreeManager] Worktree ready at', worktree.path);
				window.maestro.logger.log('info', 'Worktree ready', 'WorktreeManager', {
					effectiveCwd: worktree.path,
					worktreeBranch: worktree.branchName,
				});

				return {
					success: true,
					effectiveCwd: worktree.path,
					worktreeActive: true,
					worktreePath: worktree.path,
					worktreeBranch: worktree.branchName,
				};
			} catch (error) {
				console.error('[WorktreeManager] Error setting up worktree:', error);
				window.maestro.logger.log('error', 'Exception setting up worktree', 'WorktreeManager', {
					error: String(error),
				});
				return {
					success: false,
					effectiveCwd: sessionCwd,
					worktreeActive: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		[]
	);

	/**
	 * Create a pull request after batch completion
	 *
	 * - Gets default branch if prTargetBranch not specified
	 * - Generates PR body with document list and task count
	 * - Creates the PR using gh CLI
	 */
	const createPR = useCallback(
		async (options: CreatePROptions): Promise<PRCreationResult> => {
			const { worktreePath, mainRepoCwd, worktree, documents, totalCompletedTasks } = options;

			console.log('[WorktreeManager] Creating PR from worktree branch', worktree.branchName);

			try {
				// Use the user-selected target branch, or fall back to default branch detection
				let baseBranch = worktree.prTargetBranch;
				if (!baseBranch) {
					const defaultBranchResult = await window.maestro.git.getDefaultBranch(mainRepoCwd);
					baseBranch =
						defaultBranchResult.success && defaultBranchResult.branch
							? defaultBranchResult.branch
							: 'main';
				}

				// Generate PR title and body
				const prTitle = `Auto Run: ${documents.length} document(s) processed`;
				const prBody = generatePRBody(documents, totalCompletedTasks);

				// Create the PR (pass ghPath if configured)
				const prResult = await window.maestro.git.createPR(
					worktreePath,
					baseBranch,
					prTitle,
					prBody,
					worktree.ghPath
				);

				if (prResult.success) {
					console.log('[WorktreeManager] PR created successfully:', prResult.prUrl);
					return {
						success: true,
						prUrl: prResult.prUrl,
					};
				} else {
					console.warn('[WorktreeManager] PR creation failed:', prResult.error);
					return {
						success: false,
						error: prResult.error,
					};
				}
			} catch (error) {
				console.error('[WorktreeManager] Error creating PR:', error);
				return {
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				};
			}
		},
		[generatePRBody]
	);

	return {
		setupWorktree,
		createPR,
		generatePRBody,
	};
}
