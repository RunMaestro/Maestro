/**
 * Utility functions for batch processing of markdown task documents.
 * Extracted from useBatchProcessor.ts for reusability.
 */

import type { TaskSelectionMode } from '../../types';
import {
	CHECKED_TASK_COUNT_REGEX,
	CHECKED_TASK_REGEX,
	UNCHECKED_TASK_REGEX,
	forEachMarkdownLine,
} from '../../../shared/markdownTaskScan';

// HITL gate detection moved to `shared/autorunMarkers` so the CLI engine and the
// markdown renderer can read gates the same way this engine does. Re-exported
// here because the batch hooks import it from this module.
export { findPendingHitlGate, type HitlGate } from '../../../shared/autorunMarkers';

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
	let checked = 0;
	let unchecked = 0;

	forEachMarkdownLine(content, (line) => {
		if (CHECKED_TASK_COUNT_REGEX.test(line)) {
			checked++;
		} else if (UNCHECKED_TASK_REGEX.test(line)) {
			unchecked++;
		}
	});

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

/**
 * Phrases that mark a task as something only a human can do. A checkbox task
 * matching one of these is an Auto Run trap: the engine dispatches it, the
 * agent has no way to finish it, and the run either stalls or the agent ticks
 * a box it never actually completed.
 *
 * Patterns are deliberately narrow. Bare "verify" or "test" are normal agent
 * work; only the qualified forms ("visually verify", "manually test") count.
 * This drives a non-blocking warning, so a false positive costs the author a
 * glance, not a blocked run.
 */
export const HUMAN_ONLY_TASK_PATTERNS: { id: string; label: string; pattern: RegExp }[] = [
	{
		id: 'manual-action',
		label: 'manual action',
		pattern: /\b(?:manually|by hand|hand-verify)\b/i,
	},
	{
		id: 'visual-check',
		label: 'visual verification',
		pattern:
			/\bvisually\b|\bvisual\s+(?:verification|inspection|check|review|confirmation|comparison|QA)\b|\beyeball\b/i,
	},
	{
		id: 'user-input',
		label: 'waiting on a person',
		pattern:
			/\b(?:ask|prompt|wait for|check with|confirm with|coordinate with)\s+(?:the\s+)?(?:user|conductor|human|team|reviewer|stakeholder|owner)\b/i,
	},
	{
		id: 'approval',
		label: 'approval gate',
		pattern:
			/\b(?:human|user|manual|stakeholder|owner)\s+(?:approval|sign-?off|review|verification|confirmation)\b|\bsign[-\s]?off\b|\b(?:get|await|obtain|request|pending)\s+approval\b/i,
	},
	{
		id: 'human-actor',
		label: 'a person is the actor',
		pattern:
			/\b(?:the\s+)?(?:user|conductor|human|developer|you)\s+(?:must|should|will|needs? to|has to)\s+(?:then\s+)?(?:manually\s+)?(?:test|verify|confirm|review|approve|check|click|open|inspect|decide|choose)\b/i,
	},
	{
		id: 'external-credential',
		label: 'credential or account a person must obtain',
		pattern:
			/\b(?:obtain|acquire|sign up for|create an account|register for|request)\b[^.\n]{0,48}\b(?:api key|access key|credentials?|secret|oauth token|license|subscription|account)\b/i,
	},
];

export interface HumanOnlyTask {
	/** 0-indexed line number of the offending checkbox within the document */
	line: number;
	/** Task text with the `- [ ]` prefix stripped */
	text: string;
	/** Human-readable description of why this looks human-only */
	reason: string;
}

/**
 * Find unchecked checkbox tasks that read as human-only steps.
 *
 * Auto Run has two correct ways to express a human step, and neither is a
 * checkbox: a `<!-- MAESTRO:HITL reason="..." -->` marker (pauses the run
 * deliberately and surfaces the reason), or plain `-` bullets at the end of
 * the document (a post-run checklist the engine never sees). See
 * `src/prompts/_autorun-playbooks.md`.
 *
 * Only unchecked tasks are scanned - a checked one has already been resolved
 * one way or another and can no longer stall the run.
 */
export function findHumanOnlyTasks(content: string): HumanOnlyTask[] {
	const found: HumanOnlyTask[] = [];

	forEachMarkdownLine(content, (line, i) => {
		if (!UNCHECKED_TASK_REGEX.test(line)) return;

		const text = line.replace(/^\s*[-*+]\s*\[\s*\]\s*/, '').trim();
		const matched = HUMAN_ONLY_TASK_PATTERNS.filter(({ pattern }) => pattern.test(text));
		if (matched.length === 0) return;

		found.push({
			line: i,
			text,
			reason: matched.map(({ label }) => label).join(', '),
		});
	});

	return found;
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
