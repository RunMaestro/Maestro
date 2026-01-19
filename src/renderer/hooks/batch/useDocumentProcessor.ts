/**
 * useDocumentProcessor - Document processing logic hook for batch processing
 *
 * This hook extracts the core document reading and task processing logic from
 * useBatchProcessor, providing a reusable interface for:
 * - Reading documents and counting tasks
 * - Processing individual tasks with template variable substitution
 * - Spawning agents and tracking results
 * - Generating synopses for completed tasks
 *
 * The hook is designed to be used by useBatchProcessor for orchestration
 * while encapsulating the document-specific processing logic.
 */

import { useCallback } from 'react';
import type { Session, UsageStats } from '../../types';
import { substituteTemplateVariables, TemplateContext } from '../../utils/templateVariables';
import { countUnfinishedTasks, countCheckedTasks } from './batchUtils';

/**
 * Configuration for document processing
 */
export interface DocumentProcessorConfig {
	/**
	 * Folder path containing the Auto Run documents
	 */
	folderPath: string;

	/**
	 * Session to process documents for
	 */
	session: Session;

	/**
	 * Current git branch (for template variable substitution)
	 */
	gitBranch?: string;

	/**
	 * Session group name (for template variable substitution)
	 */
	groupName?: string;

	/**
	 * Current loop iteration (1-indexed, for template variables)
	 */
	loopIteration: number;

	/**
	 * Effective current working directory (may be worktree path)
	 */
	effectiveCwd: string;

	/**
	 * Custom prompt to use for task processing
	 */
	customPrompt: string;

	/**
	 * SSH remote ID for remote file operations (when session is SSH-enabled)
	 */
	sshRemoteId?: string;
}

/**
 * Result of processing a single task
 */
export interface TaskResult {
	/**
	 * Whether the task completed successfully
	 */
	success: boolean;

	/**
	 * Agent session ID from the spawn result
	 */
	agentSessionId?: string;

	/**
	 * Token usage statistics from the agent run
	 */
	usageStats?: UsageStats;

	/**
	 * Time elapsed processing this task (ms)
	 */
	elapsedTimeMs: number;

	/**
	 * Number of tasks completed in this run (can be 0 if stalled)
	 */
	tasksCompletedThisRun: number;

	/**
	 * Number of remaining unchecked tasks after this run
	 */
	newRemainingTasks: number;

	/**
	 * Short summary of work done (for history entry)
	 */
	shortSummary: string;

	/**
	 * Full synopsis of work done (for history entry)
	 */
	fullSynopsis: string;

	/**
	 * Whether the document content changed during processing
	 */
	documentChanged: boolean;

	/**
	 * The content of the document after processing
	 */
	contentAfterTask: string;

	/**
	 * New count of checked tasks
	 */
	newCheckedCount: number;

	/**
	 * Number of new unchecked tasks that were added during processing
	 */
	addedUncheckedTasks: number;

	/**
	 * Net change in total tasks (checked + unchecked) during processing.
	 * Can be negative if tasks were removed, positive if tasks were added.
	 * This correctly accounts for both completed tasks and newly added tasks.
	 */
	totalTasksChange: number;
}

/**
 * Document read result with task count
 */
export interface DocumentReadResult {
	/**
	 * The document content
	 */
	content: string;

	/**
	 * Number of unchecked tasks in the document
	 */
	taskCount: number;

	/**
	 * Number of checked tasks in the document
	 */
	checkedCount: number;
}

/**
 * Callbacks required for document processing
 */
export interface DocumentProcessorCallbacks {
	/**
	 * Spawn an agent with a prompt
	 */
	onSpawnAgent: (
		sessionId: string,
		prompt: string,
		cwdOverride?: string
	) => Promise<{
		success: boolean;
		response?: string;
		agentSessionId?: string;
		usageStats?: UsageStats;
	}>;
}

/**
 * Return type for the useDocumentProcessor hook
 */
export interface UseDocumentProcessorReturn {
	/**
	 * Read a document and count its tasks
	 * @param folderPath - Folder containing the document
	 * @param filename - Document filename (without .md extension)
	 * @param sshRemoteId - Optional SSH remote ID for remote file operations
	 * @returns Document content and task counts
	 */
	readDocAndCountTasks: (
		folderPath: string,
		filename: string,
		sshRemoteId?: string
	) => Promise<DocumentReadResult>;

	/**
	 * Process a single task in a document
	 * @param config - Document processing configuration
	 * @param filename - Document filename (without .md extension)
	 * @param previousCheckedCount - Number of checked tasks before this run
	 * @param previousRemainingTasks - Number of remaining tasks before this run
	 * @param contentBeforeTask - Document content before processing
	 * @param callbacks - Callbacks for agent spawning
	 * @returns Result of the task processing
	 */
	processTask: (
		config: DocumentProcessorConfig,
		filename: string,
		previousCheckedCount: number,
		previousRemainingTasks: number,
		contentBeforeTask: string,
		callbacks: DocumentProcessorCallbacks
	) => Promise<TaskResult>;
}

/**
 * Hook for document processing operations in batch processing
 *
 * This hook provides reusable document processing logic that was previously
 * embedded directly in useBatchProcessor. It handles:
 * - Reading documents and counting tasks
 * - Template variable expansion in prompts and documents
 * - Spawning agents to process tasks
 * - Generating synopses for completed work
 *
 * Usage:
 * ```typescript
 * const { readDocAndCountTasks, processTask } = useDocumentProcessor();
 *
 * // Read document and count tasks
 * const { content, taskCount, checkedCount } = await readDocAndCountTasks(folderPath, 'phase-1');
 *
 * // Process a task
 * const result = await processTask(config, 'phase-1', checkedCount, taskCount, content, callbacks);
 * ```
 */
export function useDocumentProcessor(): UseDocumentProcessorReturn {
	/**
	 * Read a document and count its tasks
	 */
	const readDocAndCountTasks = useCallback(
		async (
			folderPath: string,
			filename: string,
			sshRemoteId?: string
		): Promise<DocumentReadResult> => {
			const result = await window.maestro.autorun.readDoc(
				folderPath,
				filename + '.md',
				sshRemoteId
			);

			if (!result.success || !result.content) {
				return { content: '', taskCount: 0, checkedCount: 0 };
			}

			return {
				content: result.content,
				taskCount: countUnfinishedTasks(result.content),
				checkedCount: countCheckedTasks(result.content),
			};
		},
		[]
	);

	/**
	 * Process a single task in a document
	 */
	const processTask = useCallback(
		async (
			config: DocumentProcessorConfig,
			filename: string,
			previousCheckedCount: number,
			previousRemainingTasks: number,
			contentBeforeTask: string,
			callbacks: DocumentProcessorCallbacks
		): Promise<TaskResult> => {
			const {
				folderPath,
				session,
				gitBranch,
				groupName,
				loopIteration,
				effectiveCwd,
				customPrompt,
				sshRemoteId,
			} = config;

			const docFilePath = `${folderPath}/${filename}.md`;

			// Read document content (passes sshRemoteId for remote file operations)
			const docReadResult = await window.maestro.autorun.readDoc(
				folderPath,
				filename + '.md',
				sshRemoteId
			);

			// Build template context for this task
			const templateContext: TemplateContext = {
				session,
				gitBranch,
				groupName,
				autoRunFolder: folderPath,
				loopNumber: loopIteration, // Already 1-indexed from caller
				documentName: filename,
				documentPath: docFilePath,
			};

			if (docReadResult.success && docReadResult.content) {
				const expandedDocContent = substituteTemplateVariables(
					docReadResult.content,
					templateContext
				);

				// Write the expanded content back to the document temporarily
				// (Agent will read this file, so it needs the expanded variables)
				if (expandedDocContent !== docReadResult.content) {
					await window.maestro.autorun.writeDoc(
						folderPath,
						filename + '.md',
						expandedDocContent,
						sshRemoteId
					);
				}
			}

			// Substitute template variables in the prompt
			const finalPrompt = substituteTemplateVariables(customPrompt, templateContext);

			// Capture start time for elapsed time tracking
			const taskStartTime = Date.now();

			// Spawn agent with the prompt, using effective cwd (may be worktree path)
			const result = await callbacks.onSpawnAgent(
				session.id,
				finalPrompt,
				effectiveCwd !== session.cwd ? effectiveCwd : undefined
			);

			// Capture elapsed time
			const elapsedTimeMs = Date.now() - taskStartTime;

			// Register agent session origin for Auto Run tracking
			if (result.agentSessionId) {
				// Use effectiveCwd (worktree path when active) so session can be found later
				window.maestro.agentSessions
					.registerSessionOrigin(effectiveCwd, result.agentSessionId, 'auto')
					.catch((err) =>
						console.error('[DocumentProcessor] Failed to register session origin:', err)
					);
			}

			// Re-read document to get updated task count and content
			const afterResult = await readDocAndCountTasks(folderPath, filename, sshRemoteId);
			const {
				content: contentAfterTask,
				taskCount: newRemainingTasks,
				checkedCount: newCheckedCount,
			} = afterResult;

			// Calculate tasks completed based on newly checked tasks
			// This remains accurate even if new unchecked tasks are added
			const tasksCompletedThisRun = Math.max(0, newCheckedCount - previousCheckedCount);

			// Calculate the actual change in total tasks (checked + unchecked)
			// This correctly handles cases where tasks are both completed and added
			const previousTotal = previousRemainingTasks + previousCheckedCount;
			const newTotal = newRemainingTasks + newCheckedCount;
			const totalTasksChange = newTotal - previousTotal;

			// For backwards compatibility, still track unchecked additions separately
			const addedUncheckedTasks = Math.max(0, newRemainingTasks - previousRemainingTasks);

			// Detect if document content changed
			const documentChanged = contentBeforeTask !== contentAfterTask;

			// Generate synopsis for successful tasks
			// The autorun prompt instructs the agent to start with a specific synopsis,
			// so we extract it from the task response rather than making a separate call
			let shortSummary = `[${filename}] Task completed`;
			let fullSynopsis = shortSummary;

			if (result.success && result.response) {
				// Extract synopsis from the task response (first paragraph is the synopsis per prompt instructions)
				const responseText = result.response.trim();
				if (responseText) {
					// Use the first paragraph as the short summary
					const paragraphs = responseText.split(/\n\n+/);
					const firstParagraph = paragraphs[0]?.trim() || '';

					// Clean up the first paragraph - remove markdown formatting for summary
					const cleanFirstParagraph = firstParagraph
						.replace(/^\*\*Summary:\*\*\s*/i, '') // Remove **Summary:** prefix if present
						.replace(/^#+\s*/, '') // Remove heading markers
						.replace(/\*\*/g, '') // Remove bold markers
						.trim();

					if (cleanFirstParagraph && cleanFirstParagraph.length > 10) {
						// Use first sentence or first 150 chars as short summary
						// Match sentence-ending punctuation followed by space+capital, newline, or end of string
						// This avoids splitting on periods in file extensions like "file.tsx"
						const firstSentenceMatch = cleanFirstParagraph.match(
							/^.+?[.!?](?=\s+[A-Z]|\s*\n|\s*$)/
						);
						shortSummary = firstSentenceMatch
							? firstSentenceMatch[0].trim()
							: cleanFirstParagraph.substring(0, 150) +
								(cleanFirstParagraph.length > 150 ? '...' : '');

						// Full synopsis is the complete response
						fullSynopsis = responseText;
					}
				}
			} else if (!result.success) {
				shortSummary = `[${filename}] Task failed`;
				fullSynopsis = result.response || shortSummary;
			}

			return {
				success: result.success,
				agentSessionId: result.agentSessionId,
				usageStats: result.usageStats,
				elapsedTimeMs,
				tasksCompletedThisRun,
				newRemainingTasks,
				shortSummary,
				fullSynopsis,
				documentChanged,
				contentAfterTask,
				newCheckedCount,
				addedUncheckedTasks,
				totalTasksChange,
			};
		},
		[readDocAndCountTasks]
	);

	return {
		readDocAndCountTasks,
		processTask,
	};
}
