/**
 * Remove one user message and the response that followed it from a Claude
 * Code JSONL transcript.
 *
 * Pure text in, text out, so the local file path, the SSH remote path, and the
 * deprecated `claude:deleteMessagePair` handler all apply the same edit. Before
 * this module each of those carried its own copy of the walk.
 *
 * The pair ends at the next REAL user turn. Claude records each tool result as
 * a `type: "user"` line, so stopping at the first `user` line cut the pair off
 * after the first tool call and left the rest of the reply in the transcript.
 */

interface ClaudeTranscriptEntry {
	type?: string;
	uuid?: string;
	message?: { content?: unknown };
}

interface ParsedLine {
	line: string;
	entry: ClaudeTranscriptEntry | null;
}

export type RemoveClaudeMessagePairResult =
	| { found: true; content: string; linesRemoved: number; deletedToolUseIds: string[] }
	| { found: false };

function parseLines(content: string): ParsedLine[] {
	return content
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => {
			try {
				return { line, entry: JSON.parse(line) as ClaudeTranscriptEntry };
			} catch {
				return { line, entry: null };
			}
		});
}

function userMessageText(entry: ClaudeTranscriptEntry): string {
	const content = entry.message?.content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return (content as Array<{ type?: string; text?: string }>)
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join('\n');
}

/** A `user` line holding only tool results belongs to the turn before it. */
function isToolResultOnly(entry: ClaudeTranscriptEntry): boolean {
	const content = entry.message?.content;
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		(content as Array<{ type?: string }>).every((block) => block.type === 'tool_result')
	);
}

function isUserTurn(entry: ClaudeTranscriptEntry | null): boolean {
	return entry?.type === 'user' && !isToolResultOnly(entry);
}

function findUserMessageIndex(
	lines: ParsedLine[],
	userMessageUuid: string,
	fallbackContent: string | undefined
): number {
	// The LAST uuid match wins, as it always has.
	let index = -1;
	lines.forEach(({ entry }, i) => {
		if (entry?.type === 'user' && entry.uuid === userMessageUuid) index = i;
	});
	if (index !== -1 || !fallbackContent) return index;

	// Maestro's log ids are its own, so a uuid miss is the normal case: fall back
	// to the newest user turn whose text matches.
	const wanted = fallbackContent.trim();
	for (let i = lines.length - 1; i >= 0; i--) {
		const entry = lines[i].entry;
		if (isUserTurn(entry) && userMessageText(entry!).trim() === wanted) return i;
	}
	return -1;
}

export function removeClaudeMessagePair(
	content: string,
	userMessageUuid: string,
	fallbackContent?: string
): RemoveClaudeMessagePairResult {
	const lines = parseLines(content);
	const start = findUserMessageIndex(lines, userMessageUuid, fallbackContent);
	if (start === -1) return { found: false };

	let end = lines.length;
	const deletedToolUseIds = new Set<string>();
	for (let i = start + 1; i < lines.length; i++) {
		const entry = lines[i].entry;
		if (isUserTurn(entry)) {
			end = i;
			break;
		}
		const blocks = entry?.type === 'assistant' ? entry.message?.content : undefined;
		if (Array.isArray(blocks)) {
			for (const block of blocks as Array<{ type?: string; id?: string }>) {
				if (block.type === 'tool_use' && block.id) deletedToolUseIds.add(block.id);
			}
		}
	}

	const kept: string[] = [];
	for (const item of [...lines.slice(0, start), ...lines.slice(end)]) {
		const blocks = item.entry?.type === 'user' ? item.entry.message?.content : undefined;
		if (deletedToolUseIds.size === 0 || !Array.isArray(blocks)) {
			kept.push(item.line);
			continue;
		}
		// Drop tool results whose tool_use went with the deleted pair; the API
		// rejects a tool_result with no matching tool_use.
		const filtered = (blocks as Array<{ type?: string; tool_use_id?: string }>).filter(
			(block) =>
				!(
					block.type === 'tool_result' &&
					block.tool_use_id &&
					deletedToolUseIds.has(block.tool_use_id)
				)
		);
		if (filtered.length === 0) continue;
		kept.push(
			filtered.length === blocks.length
				? item.line
				: JSON.stringify({ ...item.entry, message: { ...item.entry!.message, content: filtered } })
		);
	}

	return {
		found: true,
		content: kept.join('\n') + '\n',
		linesRemoved: end - start,
		deletedToolUseIds: [...deletedToolUseIds],
	};
}
