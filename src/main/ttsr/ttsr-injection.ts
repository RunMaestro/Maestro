/**
 * Rendering of the corrective text TTSR feeds back to an agent.
 *
 * Two shapes, both straight from OMP's templates:
 * - `<system-interrupt>` - replaces the aborted turn's prompt, telling the agent
 *   why it was stopped and what to do instead.
 * - `<system-reminder>` - prepended to the next prompt for non-interrupting
 *   matches, since Maestro has no tool-result hook to fold them into in-band.
 *
 * Pure string work: no process, no state. The driver decides *when* a block is
 * rendered; this module only decides what it looks like.
 */

import { isProseSource } from './ttsr-matcher';
import type { TtsrMatch } from './ttsr-manager';

/** How much of the original goal a degraded `fresh` reinject restates. */
const GOAL_RESTATEMENT_MAX_CHARS = 600;

/**
 * Counter-message for tool-sourced interrupts. TTSR sees a tool call at the
 * assistant-message boundary, which on claude-code is after the CLI already ran
 * it, and the CLI then synthesizes its own "the user doesn't want to proceed
 * with this tool use" rejection into a transcript Maestro cannot edit. Without
 * this preamble the corrective turn believes the write never landed and leaves
 * the forbidden content on disk.
 */
const TOOL_INTERRUPT_PREAMBLE = [
	'This turn was interrupted by a Maestro rule AFTER the flagged tool call had already run.',
	'Its effects, including any writes to the files named in `affected-files` below, are already applied on disk.',
	'Any earlier message claiming the tool use was rejected, or that the content was not written, is incorrect and must be disregarded.',
	'The first step of this corrective turn is to inspect the affected files and fix or revert the violating content.',
].join(' ');

/** Attribute values are agent-authored text, so quotes must not break the tag. */
function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderBlock(
	tag: 'system-interrupt' | 'system-reminder',
	match: TtsrMatch,
	affectedFiles: string[]
): string {
	const attrs = [
		'reason="rule_violation"',
		`rule="${escapeAttribute(match.rule.name)}"`,
		`path="${escapeAttribute(match.rule.path)}"`,
	];
	// Appended last: existing assertions pin `reason` as the first attribute.
	if (affectedFiles.length > 0) {
		attrs.push(`affected-files="${affectedFiles.map(escapeAttribute).join(', ')}"`);
	}
	return `<${tag} ${attrs.join(' ')}>\n${match.rule.content.trim()}\n</${tag}>`;
}

/**
 * One block per distinct rule, in fire order. A rule that tripped on several
 * streams in the same turn is stated once - repeating identical guidance only
 * spends the corrective turn's context. The folded matches are not lost
 * entirely: their distinct `filePath` values are aggregated onto the surviving
 * block, so a rule that tripped on three files still names all three. Bash
 * matches carry no path and contribute nothing.
 */
function renderBlocks(tag: 'system-interrupt' | 'system-reminder', matches: TtsrMatch[]): string {
	const first = new Map<string, TtsrMatch>();
	const files = new Map<string, string[]>();
	for (const match of matches) {
		const key = match.rule.name;
		if (!first.has(key)) {
			first.set(key, match);
			files.set(key, []);
		}
		const paths = files.get(key)!;
		if (match.filePath && !paths.includes(match.filePath)) paths.push(match.filePath);
	}
	const blocks: string[] = [];
	for (const [key, match] of first) {
		blocks.push(renderBlock(tag, match, files.get(key)!));
	}
	return blocks.join('\n\n');
}

/** The `<system-interrupt>` payload for an aborted turn. */
export function renderTtsrInterrupt(matches: TtsrMatch[]): string {
	const blocks = renderBlocks('system-interrupt', matches);
	// Prose-only interrupts stop the agent mid-sentence, so nothing has landed
	// anywhere and the preamble would be a lie. Those render exactly as before.
	if (!matches.some((match) => !isProseSource(match.source))) return blocks;
	return `${TOOL_INTERRUPT_PREAMBLE}\n\n${blocks}`;
}

/** The `<system-reminder>` payload prepended to a later prompt. */
export function renderTtsrReminder(matches: TtsrMatch[]): string {
	return renderBlocks('system-reminder', matches);
}

/**
 * Collapse a prompt to a single line for restatement. The degraded `fresh`
 * path starts a brand new conversation, so without this the agent has no idea
 * what it was working on.
 */
export function summarizeGoal(goal: string): string {
	const collapsed = goal.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= GOAL_RESTATEMENT_MAX_CHARS) return collapsed;
	return `${collapsed.slice(0, GOAL_RESTATEMENT_MAX_CHARS - 1)}…`;
}

/**
 * Full prompt for a degraded (`mode: 'fresh'`) reinject: the original goal
 * restated above the interrupt blocks, because the provider session id never
 * arrived and the corrective turn cannot resume the aborted conversation.
 */
export function buildFreshInjectionPrompt(originalGoal: string, blocks: string): string {
	const goal = summarizeGoal(originalGoal);
	if (!goal) return blocks;
	return `Continuing this request: ${goal}\n\n${blocks}`;
}
