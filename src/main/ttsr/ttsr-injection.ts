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

import type { TtsrMatch } from './ttsr-manager';

/** How much of the original goal a degraded `fresh` reinject restates. */
const GOAL_RESTATEMENT_MAX_CHARS = 600;

/** Attribute values are agent-authored text, so quotes must not break the tag. */
function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderBlock(tag: 'system-interrupt' | 'system-reminder', match: TtsrMatch): string {
	const attrs = [
		'reason="rule_violation"',
		`rule="${escapeAttribute(match.rule.name)}"`,
		`path="${escapeAttribute(match.rule.path)}"`,
	];
	return `<${tag} ${attrs.join(' ')}>\n${match.rule.content.trim()}\n</${tag}>`;
}

/**
 * One block per distinct rule, in fire order. A rule that tripped on several
 * streams in the same turn is stated once - repeating identical guidance only
 * spends the corrective turn's context.
 */
function renderBlocks(tag: 'system-interrupt' | 'system-reminder', matches: TtsrMatch[]): string {
	const seen = new Set<string>();
	const blocks: string[] = [];
	for (const match of matches) {
		if (seen.has(match.rule.name)) continue;
		seen.add(match.rule.name);
		blocks.push(renderBlock(tag, match));
	}
	return blocks.join('\n\n');
}

/** The `<system-interrupt>` payload for an aborted turn. */
export function renderTtsrInterrupt(matches: TtsrMatch[]): string {
	return renderBlocks('system-interrupt', matches);
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
