/**
 * Renders the prompt that wakes the caller when a dispatch finishes.
 *
 * Deliberately a small self-contained substituter rather than
 * `substituteTemplateVariables()` from shared/templateVariables.ts: that helper
 * requires a full TemplateContext (session record, git branch, agent paths)
 * which the main-process registry does not have at fire time, and the
 * `DISPATCH_*` variables are meaningless outside a callback body.
 */

import type { DispatchCallbackFire } from './types';
// The template lives in shared so the renderer's card parser is bound to the
// exact text the main process emits (round-trip tested). Re-exported here so
// existing importers of DEFAULT_CALLBACK_PROMPT keep their path.
import { DEFAULT_CALLBACK_PROMPT } from '../../shared/dispatchCallbackCard';

export { DEFAULT_CALLBACK_PROMPT };

/**
 * Cap on the inlined result text. Matches Cue's SOURCE_OUTPUT_MAX_CHARS so the
 * two "an agent's output lands in another agent's prompt" paths behave the
 * same. The tab handle in the prompt is how the caller gets the rest.
 */
export const DISPATCH_OUTPUT_MAX_CHARS = 5000;

/** Human-readable duration, e.g. "4m 12s". */
function formatCallbackDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return 'unknown';
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

/**
 * Tail-slice the target's output. Tail rather than head because the useful part
 * of an agent turn (the conclusion) is at the end - same choice Cue makes.
 */
export function truncateDispatchOutput(
	output: string,
	maxChars = DISPATCH_OUTPUT_MAX_CHARS
): { text: string; truncated: boolean } {
	if (output.length <= maxChars) return { text: output, truncated: false };
	return { text: output.slice(-maxChars), truncated: true };
}

export interface RenderCallbackPromptInput {
	fire: DispatchCallbackFire;
	/** Best-effort result text from the target's history. May be empty. */
	output?: string;
	maxOutputChars?: number;
}

export function buildDispatchVariables(input: RenderCallbackPromptInput): Record<string, string> {
	const { fire } = input;
	const { entry } = fire;
	const { text, truncated } = truncateDispatchOutput(
		input.output ?? '',
		input.maxOutputChars ?? DISPATCH_OUTPUT_MAX_CHARS
	);
	return {
		DISPATCH_CALLBACK_ID: entry.callbackId,
		DISPATCH_TARGET_ID: entry.targetAgentId,
		DISPATCH_TARGET_NAME: entry.targetName || entry.targetAgentId,
		DISPATCH_TAB_ID: entry.targetTabId,
		DISPATCH_STATUS: fire.status,
		DISPATCH_EXIT_CODE: fire.exitCode === null ? 'n/a' : String(fire.exitCode),
		DISPATCH_DURATION: formatCallbackDuration(fire.durationMs),
		DISPATCH_OUTPUT: text || '(no output captured - read the tab for the full transcript)',
		DISPATCH_OUTPUT_TRUNCATED: truncated ? 'true' : 'false',
		DISPATCH_TASKS_COMPLETED:
			fire.tasksCompleted === undefined ? 'n/a' : String(fire.tasksCompleted),
		DISPATCH_TASKS_TOTAL: fire.tasksTotal === undefined ? 'n/a' : String(fire.tasksTotal),
		DISPATCH_PROMPT: entry.prompt,
	};
}

/**
 * Substitute `{{DISPATCH_*}}` placeholders. Substitution is single-pass over the
 * template (not iterative re-scanning), so agent output containing a literal
 * `{{DISPATCH_...}}` cannot inject another variable.
 */
export function renderCallbackPrompt(input: RenderCallbackPromptInput): string {
	const template = input.fire.entry.callbackPrompt?.trim()
		? input.fire.entry.callbackPrompt
		: DEFAULT_CALLBACK_PROMPT;
	const vars = buildDispatchVariables(input);
	return template.replace(/\{\{(DISPATCH_[A-Z_]+)\}\}/g, (match, name: string) =>
		name in vars ? vars[name] : match
	);
}
