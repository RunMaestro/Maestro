/**
 * Utility functions for batch processing of markdown task documents.
 * Extracted from useBatchProcessor.ts for reusability.
 */

import { autorunDefaultPrompt } from '../../../prompts';
import {
	countCheckedMarkdownTasks,
	countUncheckedMarkdownTasks,
	uncheckAllMarkdownTasks,
} from '../../../shared/markdownTasks';

// Default batch processing prompt (exported for use by BatchRunnerModal and playbook management)
export const DEFAULT_BATCH_PROMPT = autorunDefaultPrompt;

/**
 * Count unchecked tasks in markdown content
 * Matches lines like: - [ ] task description
 */
export function countUnfinishedTasks(content: string): number {
	return countUncheckedMarkdownTasks(content);
}

/**
 * Count checked tasks in markdown content
 * Matches lines like: - [x] task description
 */
export function countCheckedTasks(content: string): number {
	return countCheckedMarkdownTasks(content);
}

/**
 * Uncheck all markdown checkboxes in content (for reset-on-completion)
 * Converts all - [x] to - [ ] (case insensitive)
 */
export function uncheckAllTasks(content: string): string {
	return uncheckAllMarkdownTasks(content);
}

/**
 * Validates that an agent prompt contains references to Markdown tasks.
 * Uses regex heuristics to check for common patterns indicating the prompt
 * instructs the agent to process checkbox-style Markdown tasks.
 *
 * Returns true if the prompt is valid (contains task references).
 */
export function validateAgentPromptHasTaskReference(prompt: string): boolean {
	if (!prompt || !prompt.trim()) return false;

	const patterns = [
		/markdown\s+task/i, // "markdown task", "Markdown Tasks", etc.
		/- \[ \]/, // literal checkbox syntax
		/- \[x\]/i, // checked checkbox syntax
		/unchecked\s+task/i, // "unchecked task"
		/checkbox/i, // "checkbox"
		/check\s*off\s+task/i, // "check off task"
		/task.*\bcompleted?\b.*\[/i, // "task completed [" or "task complete ["
		/\btask.*- \[/i, // "task ... - [" (task followed by checkbox)
	];

	return patterns.some((pattern) => pattern.test(prompt));
}
