/**
 * Peek output parser for group chat participant live output.
 * Parses raw JSONL from agent stdout and extracts meaningful content
 * for display in the peek panel, instead of showing raw JSON.
 */

export interface PeekLine {
	type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'result' | 'system';
	content: string;
}

const TOOL_RESULT_PREVIEW_CHARS = 480;
const TEXT_PREVIEW_CHARS = 1000;

/**
 * Parse raw JSONL output from an agent process into structured peek lines.
 * Handles Claude Code format: { type: 'assistant', message: { content: [...] } }
 * Falls back gracefully for non-JSON or unknown formats.
 */
export function parsePeekOutput(rawOutput: string): PeekLine[] {
	const lines: PeekLine[] = [];
	const rawLines = rawOutput.split('\n');

	// Buffer for reassembling JSON objects split across lines
	let jsonBuffer = '';

	for (const line of rawLines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// If we have a pending buffer, append this line and try to parse
		if (jsonBuffer) {
			jsonBuffer += trimmed;
			try {
				const msg = JSON.parse(jsonBuffer);
				const parsed = extractFromMessage(msg);
				if (parsed.length > 0) {
					lines.push(...parsed);
				}
				jsonBuffer = '';
			} catch {
				// Still incomplete - keep buffering
			}
			continue;
		}

		// Try to parse as JSON
		if (trimmed.startsWith('{')) {
			try {
				const msg = JSON.parse(trimmed);
				const parsed = extractFromMessage(msg);
				if (parsed.length > 0) {
					lines.push(...parsed);
				}
			} catch {
				// Incomplete JSON - start buffering to reassemble across lines
				jsonBuffer = trimmed;
			}
			continue;
		}

		// Non-JSON line that doesn't look like a JSON fragment
		if (!trimmed.startsWith('"') && !trimmed.startsWith('}') && !trimmed.startsWith(']')) {
			lines.push({ type: 'text', content: trimmed });
		}
	}

	return lines;
}

/**
 * Extract meaningful content from a parsed JSON message.
 */
function extractFromMessage(msg: Record<string, unknown>): PeekLine[] {
	const lines: PeekLine[] = [];

	// Claude result message: { type: 'result', result: '...' }
	if (msg.type === 'result' && typeof msg.result === 'string') {
		const trimmed = msg.result.trim();
		if (trimmed) lines.push({ type: 'result', content: truncateForDisplay(trimmed) });
		return lines;
	}

	// Claude assistant message: { type: 'assistant', message: { content: [...] } }
	if (msg.type === 'assistant' && msg.message && typeof msg.message === 'object') {
		const message = msg.message as Record<string, unknown>;
		const content = message.content;

		if (typeof content === 'string') {
			const trimmed = content.trim();
			if (trimmed) lines.push({ type: 'text', content: truncateForDisplay(trimmed) });
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== 'object') continue;
				const b = block as Record<string, unknown>;

				if (b.type === 'text' && typeof b.text === 'string') {
					const t = b.text.trim();
					if (t) lines.push({ type: 'text', content: truncateForDisplay(t) });
				} else if (b.type === 'thinking' && typeof b.thinking === 'string') {
					const t = b.thinking.trim();
					if (t) lines.push({ type: 'thinking', content: truncateForDisplay(t) });
				} else if (b.type === 'tool_use' && typeof b.name === 'string') {
					const toolDesc = formatToolUse(b);
					lines.push({ type: 'tool', content: toolDesc });
				}
			}
		}
		return lines;
	}

	// Claude user message with tool_result blocks (the SDK injects these
	// after each tool call). Without these, the user sees a tool call with
	// no idea what came back, which is unreadable for long-running agents.
	if (msg.type === 'user' && msg.message && typeof msg.message === 'object') {
		const message = msg.message as Record<string, unknown>;
		const content = message.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== 'object') continue;
				const b = block as Record<string, unknown>;
				if (b.type === 'tool_result') {
					const preview = formatToolResultContent(b.content);
					if (preview) lines.push({ type: 'tool_result', content: preview });
				}
			}
		}
		return lines;
	}

	// System init message
	if (msg.type === 'system' && msg.subtype === 'init') {
		lines.push({ type: 'system', content: 'Session initialized' });
		return lines;
	}

	// OpenCode format: { type: 'text', part: { text: '...' } }
	if (msg.type === 'text' && msg.part && typeof msg.part === 'object') {
		const part = msg.part as Record<string, unknown>;
		if (typeof part.text === 'string') {
			const t = part.text.trim();
			if (t) lines.push({ type: 'text', content: truncateForDisplay(t) });
		}
		return lines;
	}

	// Messages with only usage/cost info - skip (no content to show)
	if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
		return lines;
	}

	return lines;
}

/**
 * Format a tool_result content payload (string or array of content blocks)
 * into a single-line preview. Strips embedded image base64 and collapses
 * whitespace so the result fits on one row of the live-output table.
 */
function formatToolResultContent(content: unknown): string {
	if (typeof content === 'string') {
		return collapseAndTruncate(content, TOOL_RESULT_PREVIEW_CHARS);
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const part of content) {
			if (!part || typeof part !== 'object') continue;
			const p = part as Record<string, unknown>;
			if (p.type === 'text' && typeof p.text === 'string') {
				parts.push(p.text);
			} else if (p.type === 'image') {
				parts.push('[image]');
			}
		}
		return collapseAndTruncate(parts.join(' '), TOOL_RESULT_PREVIEW_CHARS);
	}
	return '';
}

function collapseAndTruncate(s: string, max: number): string {
	const cleaned = s.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= max) return cleaned;
	return cleaned.slice(0, max) + '…';
}

function truncateForDisplay(s: string): string {
	if (s.length <= TEXT_PREVIEW_CHARS) return s;
	return s.slice(0, TEXT_PREVIEW_CHARS) + '…';
}

/**
 * Format a tool_use block into a concise description.
 */
function formatToolUse(block: Record<string, unknown>): string {
	const name = block.name as string;
	const input = block.input as Record<string, unknown> | undefined;

	if (!input) return `→ ${name}`;

	// Common tool patterns
	if (name === 'Read' && input.file_path) {
		return `→ Read ${input.file_path}`;
	}
	if (name === 'Write' && input.file_path) {
		return `→ Write ${input.file_path}`;
	}
	if (name === 'Edit' && input.file_path) {
		return `→ Edit ${input.file_path}`;
	}
	if (name === 'Bash' && input.command) {
		return `→ $ ${String(input.command)}`;
	}
	if (name === 'Grep' && input.pattern) {
		return `→ Grep "${input.pattern}"`;
	}
	if (name === 'Glob' && input.pattern) {
		return `→ Glob "${input.pattern}"`;
	}
	if ((name === 'Agent' || name === 'Task') && input.description) {
		return `→ ${name}: ${input.description}`;
	}
	if (name === 'WebFetch' && input.url) {
		return `→ Fetch ${input.url}`;
	}
	if (name === 'WebSearch' && input.query) {
		return `→ Search "${input.query}"`;
	}

	return `→ ${name}`;
}

/**
 * Convert parsed peek lines back to a formatted string for display.
 * Concatenates content, prefixing thinking and tool lines with labels.
 */
export function formatPeekLines(peekLines: PeekLine[]): string {
	if (peekLines.length === 0) return '';

	return peekLines
		.filter((line) => line.type !== 'tool_result')
		.map((line) => {
			switch (line.type) {
				case 'thinking':
					return `💭 ${line.content}`;
				case 'tool':
					return `🔧 ${line.content}`;
				case 'system':
					return `⚙ ${line.content}`;
				case 'result':
				case 'text':
				default:
					return line.content;
			}
		})
		.join('\n');
}
