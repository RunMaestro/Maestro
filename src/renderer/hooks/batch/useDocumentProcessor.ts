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
import {
	countUnfinishedTasks,
	countCheckedTasks,
	getPlaybookPromptForExecution,
} from './batchUtils';
import { normalizeOpenClawSessionId } from '../../../shared/openclawSessionId';
import {
	buildActiveTaskDocumentContext,
	revertNewlyCheckedTasks,
} from '../../../shared/markdownTaskUtils';
import type { ToolType } from '../../types';
import type {
	PlaybookDocumentContextMode,
	PlaybookPromptProfile,
	PlaybookSkillPromptMode,
} from '../../../shared/types';

const PLAN_STEP_INSTRUCTION = `You are the planning step for an Auto Run task.

Produce a short implementation plan for the first unchecked task only.
Do not claim the task is complete. Do not describe unrelated follow-up work.`;

const EXECUTE_STEP_INSTRUCTION = `You are the execution step for an Auto Run task.

Use the planner output to complete the first unchecked task in the document.`;

const VERIFY_STEP_INSTRUCTION = `You are the verification step for an Auto Run task.

Review the task outcome, call out any gap against the task, and state PASS or FAIL first.`;

const AUTORUN_CONTEXT_AND_IMPACT_INSTRUCTION = `Before making any non-trivial code change, follow the repository's context-and-impact workflow:
- use GitNexus/context to inspect the target symbol or file
- use GitNexus/impact to check upstream blast radius
- if GitNexus misses the symbol, say so and fall back to focused local code search before editing`;

function buildDefinitionOfDoneSection(definitionOfDone: string[] = []): string {
	if (definitionOfDone.length === 0) {
		return '';
	}

	return `## Definition of Done\n${definitionOfDone.map((item) => `- ${item}`).join('\n')}`;
}

function buildVerificationStepsSection(verificationSteps: string[] = []): string {
	if (verificationSteps.length === 0) {
		return '';
	}

	return `## Verification Steps\n${verificationSteps.map((item) => `- ${item}`).join('\n')}`;
}

function getDocumentPromptSection(
	docFilePath: string,
	content: string,
	mode: PlaybookDocumentContextMode = 'active-task-only'
): string {
	const modeNote =
		mode === 'full'
			? 'The full document is inlined below.'
			: 'Only the active unchecked task and minimal nearby context are inlined below; open the document on disk if you need anything else.';

	return `---\n\n# Current Document: ${docFilePath}\n\nProcess tasks from this document and save changes back to the file above.\n${modeNote}\n\n${content}`;
}

function buildRequestedSkillsSection(
	skills: string[] = [],
	mode: PlaybookSkillPromptMode = 'brief'
): string {
	const normalizedSkills = skills.map((skill) => skill.trim()).filter(Boolean);
	if (normalizedSkills.length === 0) {
		return '';
	}

	const guidance =
		mode === 'full'
			? 'Load and apply these project or user skills if they are available in the workspace or user skill directories before editing.'
			: 'Use these skills if they are available in the workspace or user skill directories.';

	return `## Requested Skills\n${guidance}\n${normalizedSkills.map((skill) => `- ${skill}`).join('\n')}`;
}

function getVerifierVerdict(response?: string): 'PASS' | 'WARN' | 'FAIL' | null {
	const firstNonEmptyLine = response
		?.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean)
		?.toUpperCase();

	if (
		firstNonEmptyLine === 'PASS' ||
		firstNonEmptyLine === 'WARN' ||
		firstNonEmptyLine === 'FAIL'
	) {
		return firstNonEmptyLine;
	}

	return null;
}

function applyVerifierVerdictToSummary(
	summary: string,
	verdict: 'PASS' | 'WARN' | 'FAIL' | null
): string {
	if (!summary || !verdict || verdict === 'PASS') {
		return summary;
	}

	return `[${verdict}] ${summary}`;
}

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
	promptProfile?: PlaybookPromptProfile;
	documentContextMode?: PlaybookDocumentContextMode;
	skillPromptMode?: PlaybookSkillPromptMode;
	skills?: string[];

	/**
	 * Execution strategy for the task
	 */
	agentStrategy?: 'single' | 'plan-execute-verify';

	/**
	 * Completion criteria used by the verifier step
	 */
	definitionOfDone?: string[];

	/**
	 * Explicit checks the verifier should always perform
	 */
	verificationSteps?: string[];

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
	 * Verifier verdict for plan-execute-verify runs
	 */
	verifierVerdict?: 'PASS' | 'WARN' | 'FAIL' | null;

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
		cwdOverride?: string,
		options?: {
			resumeAgentSessionId?: string;
		}
	) => Promise<{
		success: boolean;
		response?: string;
		agentSessionId?: string;
		usageStats?: UsageStats;
	}>;

	/**
	 * Resume an existing provider session in the background
	 */
	onSpawnBackgroundSynopsis?: (
		sessionId: string,
		cwd: string,
		resumeAgentSessionId: string,
		prompt: string,
		toolType?: ToolType,
		sessionConfig?: {
			customPath?: string;
			customArgs?: string;
			customEnvVars?: Record<string, string>;
			customModel?: string;
			customContextWindow?: number;
			sessionSshRemoteConfig?: {
				enabled: boolean;
				remoteId: string | null;
				workingDirOverride?: string;
			};
		}
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
	const mergeUsageStats = useCallback(
		(current: UsageStats | undefined, next: UsageStats | undefined): UsageStats | undefined => {
			if (!next) return current;
			if (!current) return next;
			return {
				...next,
				inputTokens: current.inputTokens + next.inputTokens,
				outputTokens: current.outputTokens + next.outputTokens,
				cacheReadInputTokens: current.cacheReadInputTokens + next.cacheReadInputTokens,
				cacheCreationInputTokens: current.cacheCreationInputTokens + next.cacheCreationInputTokens,
				totalCostUsd: current.totalCostUsd + next.totalCostUsd,
				contextWindow: Math.max(current.contextWindow, next.contextWindow),
				reasoningTokens:
					current.reasoningTokens || next.reasoningTokens
						? (current.reasoningTokens || 0) + (next.reasoningTokens || 0)
						: undefined,
			};
		},
		[]
	);

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
				promptProfile,
				documentContextMode,
				skillPromptMode,
				skills,
				agentStrategy,
				definitionOfDone,
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

			const expandedDocContent =
				docReadResult.success && docReadResult.content
					? substituteTemplateVariables(docReadResult.content, templateContext)
					: '';
			const promptDocContent =
				documentContextMode === 'full'
					? expandedDocContent
					: buildActiveTaskDocumentContext(expandedDocContent);
			const basePrompt = substituteTemplateVariables(
				getPlaybookPromptForExecution(customPrompt, promptProfile),
				templateContext
			);
			const finalPrompt = [
				AUTORUN_CONTEXT_AND_IMPACT_INSTRUCTION,
				basePrompt,
				buildRequestedSkillsSection(skills, skillPromptMode),
				getDocumentPromptSection(docFilePath, promptDocContent, documentContextMode),
			]
				.filter(Boolean)
				.join('\n\n');

			// Capture start time for elapsed time tracking
			const taskStartTime = Date.now();

			const cwdOverride = effectiveCwd !== session.cwd ? effectiveCwd : undefined;
			let result;
			let verifierVerdict: 'PASS' | 'WARN' | 'FAIL' | null = null;
			if (agentStrategy === 'plan-execute-verify') {
				const plannerPrompt = `${PLAN_STEP_INSTRUCTION}\n\n## Task Prompt\n${finalPrompt}`;
				const plannerResult = await callbacks.onSpawnAgent(session.id, plannerPrompt, cwdOverride);
				let mergedUsageStats = mergeUsageStats(undefined, plannerResult.usageStats);
				const plannerSummary = plannerResult.response?.trim() || '';

				const executorPrompt = `${EXECUTE_STEP_INSTRUCTION}\n\n## Task Prompt\n${finalPrompt}${
					plannerSummary ? `\n\n## Planner Output\n${plannerSummary}` : ''
				}`;
				const executorResumeAgentSessionId =
					session.toolType === 'codex' ? undefined : plannerResult.agentSessionId;

				const executorResult = await callbacks.onSpawnAgent(
					session.id,
					executorPrompt,
					cwdOverride,
					executorResumeAgentSessionId
						? {
								resumeAgentSessionId: executorResumeAgentSessionId,
							}
						: undefined
				);

				mergedUsageStats = mergeUsageStats(mergedUsageStats, executorResult.usageStats);

				const verifierPrompt = `${VERIFY_STEP_INSTRUCTION}\n\n## Task Prompt\n${finalPrompt}${
					plannerSummary ? `\n\n## Planner Output\n${plannerSummary}` : ''
				}${
					executorResult.response?.trim()
						? `\n\n## Executor Output\n${executorResult.response.trim()}`
						: ''
				}${config.verificationSteps && config.verificationSteps.length > 0 ? `\n\n${buildVerificationStepsSection(config.verificationSteps)}` : ''}${
					definitionOfDone && definitionOfDone.length > 0
						? `\n\n${buildDefinitionOfDoneSection(definitionOfDone)}`
						: ''
				}`;
				const verifierResult = await callbacks.onSpawnAgent(
					session.id,
					verifierPrompt,
					cwdOverride
				);
				mergedUsageStats = mergeUsageStats(mergedUsageStats, verifierResult.usageStats);
				verifierVerdict = getVerifierVerdict(verifierResult.response);

				result = {
					...executorResult,
					success:
						executorResult.success &&
						verifierResult.success !== false &&
						verifierVerdict !== 'FAIL',
					usageStats: mergedUsageStats,
					response: verifierResult.response?.trim()
						? `${executorResult.response || ''}\n\nVerifier:\n${verifierResult.response.trim()}`
						: executorResult.response,
				};
			} else {
				// Spawn agent with the prompt, using effective cwd (may be worktree path)
				result = await callbacks.onSpawnAgent(session.id, finalPrompt, cwdOverride);
			}

			// Capture elapsed time
			const elapsedTimeMs = Date.now() - taskStartTime;

			// Register agent session origin for Auto Run tracking
			if (result.agentSessionId) {
				const normalizedAgentSessionId =
					session.toolType === 'openclaw'
						? normalizeOpenClawSessionId(result.agentSessionId) || result.agentSessionId
						: result.agentSessionId;

				// Use effectiveCwd (worktree path when active) so session can be found later
				window.maestro.agentSessions
					.registerSessionOrigin(session.toolType, effectiveCwd, normalizedAgentSessionId, 'auto')
					.catch((err) =>
						console.error('[DocumentProcessor] Failed to register session origin:', err)
					);
			}

			// Re-read document to get updated task count and content
			let afterResult = await readDocAndCountTasks(folderPath, filename, sshRemoteId);
			let {
				content: contentAfterTask,
				taskCount: newRemainingTasks,
				checkedCount: newCheckedCount,
			} = afterResult;

			// Calculate tasks completed based on newly checked tasks
			// This remains accurate even if new unchecked tasks are added
			let tasksCompletedThisRun = Math.max(0, newCheckedCount - previousCheckedCount);

			if (!result.success && tasksCompletedThisRun > 0) {
				const revertedContent = revertNewlyCheckedTasks(contentBeforeTask, contentAfterTask);
				if (revertedContent !== contentAfterTask) {
					await window.maestro.autorun.writeDoc(
						folderPath,
						filename + '.md',
						revertedContent,
						sshRemoteId
					);
					afterResult = {
						content: revertedContent,
						taskCount: countUnfinishedTasks(revertedContent),
						checkedCount: countCheckedTasks(revertedContent),
					};
					contentAfterTask = afterResult.content;
					newRemainingTasks = afterResult.taskCount;
					newCheckedCount = afterResult.checkedCount;
					tasksCompletedThisRun = Math.max(0, newCheckedCount - previousCheckedCount);
				}
			}

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

			shortSummary = applyVerifierVerdictToSummary(shortSummary, verifierVerdict);

			return {
				success: result.success,
				agentSessionId: result.agentSessionId,
				usageStats: result.usageStats,
				elapsedTimeMs,
				tasksCompletedThisRun,
				newRemainingTasks,
				shortSummary,
				fullSynopsis,
				verifierVerdict,
				documentChanged,
				contentAfterTask,
				newCheckedCount,
				addedUncheckedTasks,
				totalTasksChange,
			};
		},
		[mergeUsageStats, readDocAndCountTasks]
	);

	return {
		readDocAndCountTasks,
		processTask,
	};
}
