/**
 * Rendering of the corrective text TTSR feeds back to an agent.
 *
 * Two shapes, both straight from OMP's templates:
 * - `<system-interrupt>` - carries corrective guidance through the native Steer queue.
 * - `<system-reminder>` - prepended to the next prompt for non-interrupting
 *   matches, since Maestro has no tool-result hook to fold them into in-band.
 *
 * Pure string work: no process, no state. The driver decides *when* a block is
 * rendered; this module only decides what it looks like.
 */

import { isProseSource } from './ttsr-matcher';
import type { TtsrMatch } from './ttsr-manager';

/** A tool observation does not prove whether its side effects already landed. */
const TOOL_INTERRUPT_PREAMBLE = [
	'Maestro observed a tool call that matches a project rule.',
	'The tool may already have run; inspect its actual result and any affected files before correcting the violation.',
	'Steering does not cancel the tool or undo its effects.',
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

/** The legacy `<system-interrupt>` envelope delivered as a native Steer message. */
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
