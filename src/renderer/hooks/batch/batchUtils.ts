/**
 * Utility functions for batch processing of markdown task documents.
 * Extracted from useBatchProcessor.ts for reusability.
 */

// Module-level prompt cache (loaded once via IPC)
let cachedAutorunDefaultPrompt = '';
let cachedAutorunSynopsisPrompt = '';
let batchPromptsLoaded = false;

/**
 * Load batch/autorun prompts from disk via IPC.
 * Called once at startup before components mount.
 */
export async function loadBatchPrompts(): Promise<void> {
	if (batchPromptsLoaded) return;

	const [defaultResult, synopsisResult] = await Promise.all([
		window.maestro.prompts.get('autorun-default'),
		window.maestro.prompts.get('autorun-synopsis'),
	]);

	if (defaultResult.success && defaultResult.content) {
		cachedAutorunDefaultPrompt = defaultResult.content;
		DEFAULT_BATCH_PROMPT = defaultResult.content;
	}
	if (synopsisResult.success && synopsisResult.content) {
		cachedAutorunSynopsisPrompt = synopsisResult.content;
	}
	batchPromptsLoaded = true;
}

/**
 * Get the autorun synopsis prompt (from cache).
 */
export function getAutorunSynopsisPrompt(): string {
	return cachedAutorunSynopsisPrompt;
}

// Default batch processing prompt (exported for use by BatchRunnerModal and playbook management)
// Updated via loadBatchPrompts() at startup; live ES module binding ensures importers see the value.
// eslint-disable-next-line import/no-mutable-exports
export let DEFAULT_BATCH_PROMPT = '';

// Regex to count unchecked markdown checkboxes: - [ ] task (also * [ ])
const UNCHECKED_TASK_REGEX = /^[\s]*[-*]\s*\[\s*\]\s*.+$/gm;

// Regex to count checked markdown checkboxes: - [x] task (also * [x])
const CHECKED_TASK_COUNT_REGEX = /^[\s]*[-*]\s*\[[xX✓✔]\]\s*.+$/gm;

// Regex to match checked markdown checkboxes for reset-on-completion
// Matches both [x] and [X] with various checkbox formats (standard and GitHub-style)
const CHECKED_TASK_REGEX = /^(\s*[-*]\s*)\[[xX✓✔]\]/gm;

/**
 * Count unchecked tasks in markdown content
 * Matches lines like: - [ ] task description
 */
export function countUnfinishedTasks(content: string): number {
	const matches = content.match(UNCHECKED_TASK_REGEX);
	return matches ? matches.length : 0;
}

/**
 * Count checked tasks in markdown content
 * Matches lines like: - [x] task description
 */
export function countCheckedTasks(content: string): number {
	const matches = content.match(CHECKED_TASK_COUNT_REGEX);
	return matches ? matches.length : 0;
}

/**
 * Uncheck all markdown checkboxes in content (for reset-on-completion)
 * Converts all - [x] to - [ ] (case insensitive)
 */
export function uncheckAllTasks(content: string): string {
	return content.replace(CHECKED_TASK_REGEX, '$1[ ]');
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
