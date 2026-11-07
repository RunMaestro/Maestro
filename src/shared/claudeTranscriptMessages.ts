/**
 * How many conversation messages a Claude Code transcript holds.
 *
 * A transcript line is not a message. Claude Code writes one line per content
 * block of a response (thinking, text, each tool_use), returns every tool result
 * as a `"type":"user"` line, and adds meta lines (command output, compaction
 * summaries) that nobody typed. Counting `"type":"user"|"assistant"` lines, as
 * every reader used to, overstated messages about 2.3x on real transcripts.
 *
 * A message here is either a prompt the user sent or one model response (one
 * API call, so a tool-calling turn is several). Pure and import-free, so every
 * process counts the same way.
 */

interface TranscriptLine {
	type?: unknown;
	isMeta?: unknown;
	isSidechain?: unknown;
	isCompactSummary?: unknown;
	message?: { id?: unknown; content?: unknown };
}

/** Command bookkeeping Claude Code writes as a user line around slash commands. */
const COMMAND_LINE_PREFIXES = ['<command-name>', '<command-message>', '<local-command-stdout>'];

function isToolResultOnly(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every(
			(block) =>
				!!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result'
		)
	);
}

function isUserPrompt(entry: TranscriptLine): boolean {
	if (entry.isMeta === true || entry.isCompactSummary === true) return false;
	const content = entry.message?.content;
	if (isToolResultOnly(content)) return false;
	if (typeof content === 'string') {
		const head = content.trimStart();
		if (COMMAND_LINE_PREFIXES.some((prefix) => head.startsWith(prefix))) return false;
	}
	return true;
}

/** Counts a transcript's messages one line at a time. */
export interface ClaudeMessageCounter {
	/** Count one transcript line. */
	addLine(line: string): void;
	/** Messages counted so far. */
	count(): number;
}

/**
 * Count the user prompts and model responses in a transcript, fed one line at
 * a time so a caller can stream a large file instead of holding it as one
 * string. Subagent (sidechain) lines are not part of the conversation and are
 * skipped; a response spread across several lines is counted once by its
 * message id.
 */
export function createClaudeMessageCounter(): ClaudeMessageCounter {
	const responseIds = new Set<string>();
	let count = 0;

	const addLine = (line: string): void => {
		// Cheap prefilter: only user and assistant lines can be messages.
		if (line.indexOf('"user"') === -1 && line.indexOf('"assistant"') === -1) return;
		let entry: TranscriptLine;
		try {
			entry = JSON.parse(line);
		} catch {
			return;
		}
		if (entry.isSidechain === true) return;

		if (entry.type === 'assistant') {
			const id = entry.message?.id;
			if (typeof id === 'string' && id) {
				if (responseIds.has(id)) return;
				responseIds.add(id);
			}
			count++;
		} else if (entry.type === 'user' && isUserPrompt(entry)) {
			count++;
		}
	};

	return { addLine, count: () => count };
}

/** {@link createClaudeMessageCounter} over a transcript already in hand. */
export function countClaudeTranscriptMessages(content: string): number {
	const counter = createClaudeMessageCounter();
	for (const line of content.split('\n')) counter.addLine(line);
	return counter.count();
}
