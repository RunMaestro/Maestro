/**
 * Utility functions for batch processing of markdown task documents.
 * Extracted from useBatchProcessor.ts for reusability.
 */

import type { TaskSelectionMode } from '../../types';

let cachedAutorunDefaultPrompt: string = '';
let cachedAutorunPerTaskBlock: string = '';
let cachedAutorunPerDocumentBlock: string = '';
let batchUtilsPromptsLoaded = false;

export async function loadBatchUtilsPrompts(force = false): Promise<void> {
	if (batchUtilsPromptsLoaded && !force) return;

	const [defaultResult, perTaskResult, perDocResult] = await Promise.all([
		window.maestro.prompts.get('autorun-default'),
		window.maestro.prompts.get('autorun-per-task'),
		window.maestro.prompts.get('autorun-per-document'),
	]);
	if (!defaultResult.success) {
		throw new Error(`Failed to load autorun-default prompt: ${defaultResult.error}`);
	}
	if (!perTaskResult.success) {
		throw new Error(`Failed to load autorun-per-task prompt: ${perTaskResult.error}`);
	}
	if (!perDocResult.success) {
		throw new Error(`Failed to load autorun-per-document prompt: ${perDocResult.error}`);
	}
	cachedAutorunDefaultPrompt = defaultResult.content!;
	cachedAutorunPerTaskBlock = perTaskResult.content!;
	cachedAutorunPerDocumentBlock = perDocResult.content!;
	batchUtilsPromptsLoaded = true;
	// Update the exported binding so consumers see the loaded value
	DEFAULT_BATCH_PROMPT = cachedAutorunDefaultPrompt;
}

function getAutorunDefaultPrompt(): string {
	return cachedAutorunDefaultPrompt;
}

/**
 * Return the cached task-selection block content for the requested mode. Strips
 * trailing newlines so substituting into the prompt doesn't introduce extra
 * blank lines around the swapped block. Falls back to the per-task block if a
 * caller passes an unrecognized value.
 */
export function getTaskSelectionBlock(mode: TaskSelectionMode | undefined): string {
	const content = mode === 'document' ? cachedAutorunPerDocumentBlock : cachedAutorunPerTaskBlock;
	return content.replace(/\s+$/, '');
}

// Default batch processing prompt (exported for use by BatchRunnerModal and playbook management)
// Uses `let` so the binding can be updated after async IPC load completes
export let DEFAULT_BATCH_PROMPT: string = getAutorunDefaultPrompt();

// Regex to count unchecked markdown checkboxes: - [ ] task (also * [ ] or + [ ])
const UNCHECKED_TASK_REGEX = /^[\s]*[-*+]\s*\[\s*\]\s*.+$/;

// Regex to count checked markdown checkboxes: - [x] task (also * [x] or + [x])
const CHECKED_TASK_COUNT_REGEX = /^[\s]*[-*+]\s*\[[xX✓✔]\]\s*.+$/;

// Regex to match a HITL gate marker: <!-- MAESTRO:HITL reason="..." artifact="..." -->
// The marker may span multiple lines in source, but we treat a single line as the unit
// because playbook authors place it on its own line per the documented convention.
const HITL_MARKER_REGEX = /<!--\s*MAESTRO:HITL\b([^]*?)-->/;

// Regex to match checked markdown checkboxes for reset-on-completion
// Matches both [x] and [X] with various checkbox formats (standard and GitHub-style)
const CHECKED_TASK_REGEX = /^(\s*[-*+]\s*)\[[xX✓✔]\]/gm;

export interface MarkdownTaskCounts {
	checked: number;
	unchecked: number;
	total: number;
}

/**
 * Count markdown checkbox tasks while ignoring fenced code blocks.
 * This prevents example snippets from affecting Auto Run progress.
 */
export function countMarkdownTasks(content: string): MarkdownTaskCounts {
	const normalizedContent = content.replace(/\r\n?/g, '\n');
	let checked = 0;
	let unchecked = 0;
	let inFencedCode = false;
	let fenceChar: '`' | '~' | null = null;
	let openFenceLength = 0;

	for (const line of normalizedContent.split('\n')) {
		const trimmed = line.trimStart();
		const fenceMatch = trimmed.match(/^([`~]{3,})/);
		if (fenceMatch) {
			const currentFenceChar = fenceMatch[1][0] as '`' | '~';
			if (!inFencedCode) {
				inFencedCode = true;
				fenceChar = currentFenceChar;
				openFenceLength = fenceMatch[1].length;
				continue;
			}
			if (fenceChar === currentFenceChar && fenceMatch[1].length >= openFenceLength) {
				inFencedCode = false;
				fenceChar = null;
				openFenceLength = 0;
				continue;
			}
		}

		if (inFencedCode) continue;

		if (CHECKED_TASK_COUNT_REGEX.test(line)) {
			checked++;
		} else if (UNCHECKED_TASK_REGEX.test(line)) {
			unchecked++;
		}
	}

	return {
		checked,
		unchecked,
		total: checked + unchecked,
	};
}

/**
 * Count unchecked tasks in markdown content
 * Matches lines like: - [ ] task description
 */
export function countUnfinishedTasks(content: string): number {
	return countMarkdownTasks(content).unchecked;
}

/**
 * Count checked tasks in markdown content
 * Matches lines like: - [x] task description
 */
export function countCheckedTasks(content: string): number {
	return countMarkdownTasks(content).checked;
}

/**
 * Uncheck all markdown checkboxes in content (for reset-on-completion)
 * Converts all - [x] to - [ ] (case insensitive)
 */
export function uncheckAllTasks(content: string): string {
	return content.replace(CHECKED_TASK_REGEX, '$1[ ]');
}

export interface HitlGate {
	reason: string;
	artifact?: string;
	/** 0-indexed line number of the marker within the document */
	line: number;
}

/**
 * Detect a pending HITL (human-in-the-loop) gate in playbook content.
 *
 * A gate is "pending" when an unchecked task appears below a HITL marker
 * with no checked task between them - the human hasn't acknowledged the
 * gate yet by ticking the approval checkbox. Once the user checks the box
 * (or any task between the marker and the next unchecked task), the marker
 * is considered "consumed" and the next call returns null.
 *
 * Markers inside fenced code blocks are ignored so playbook authors can
 * document the syntax without triggering pauses.
 *
 * Returns the first marker in a pending chain (when multiple markers
 * appear before a single unchecked task), and null otherwise.
 */
export function findPendingHitlGate(content: string): HitlGate | null {
	const normalizedContent = content.replace(/\r\n?/g, '\n');
	const lines = normalizedContent.split('\n');
	let firstMarkerInPendingChain: HitlGate | null = null;
	let inFencedCode = false;
	let fenceChar: '`' | '~' | null = null;
	let openFenceLength = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trimStart();

		const fenceMatch = trimmed.match(/^([`~]{3,})/);
		if (fenceMatch) {
			const currentFenceChar = fenceMatch[1][0] as '`' | '~';
			if (!inFencedCode) {
				inFencedCode = true;
				fenceChar = currentFenceChar;
				openFenceLength = fenceMatch[1].length;
				continue;
			}
			if (fenceChar === currentFenceChar && fenceMatch[1].length >= openFenceLength) {
				inFencedCode = false;
				fenceChar = null;
				openFenceLength = 0;
				continue;
			}
		}

		if (inFencedCode) continue;

		// Checked tasks consume any pending marker - the user already approved
		// (or someone other than the user; either way the gate has been passed).
		if (CHECKED_TASK_COUNT_REGEX.test(line)) {
			firstMarkerInPendingChain = null;
			continue;
		}

		// Unchecked task closes the pending chain: if we have a marker, it's
		// the gate the run should pause at. Otherwise there's no gate above
		// this task.
		if (UNCHECKED_TASK_REGEX.test(line)) {
			return firstMarkerInPendingChain;
		}

		const markerMatch = line.match(HITL_MARKER_REGEX);
		if (markerMatch && firstMarkerInPendingChain === null) {
			const inner = markerMatch[1] || '';
			const reasonMatch = inner.match(/reason\s*=\s*"([^"]*)"/);
			const artifactMatch = inner.match(/artifact\s*=\s*"([^"]*)"/);
			firstMarkerInPendingChain = {
				reason: reasonMatch?.[1]?.trim() || 'Human review requested',
				artifact: artifactMatch?.[1]?.trim() || undefined,
				line: i,
			};
		}
	}

	return null;
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
