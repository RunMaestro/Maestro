/**
 * Peek output parser for group chat participant live output.
 * Parses raw JSONL from agent stdout and extracts meaningful content
 * for display in the peek panel, instead of showing raw JSON.
 */

export interface PeekLine {
	type: 'text' | 'thinking' | 'tool' | 'result' | 'system';
	content: string;
}

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
				// Still incomplete — keep buffering
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
				// Incomplete JSON — start buffering to reassemble across lines
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
		lines.push({ type: 'result', content: msg.result });
		return lines;
	}

	// Claude assistant message: { type: 'assistant', message: { content: [...] } }
	if (msg.type === 'assistant' && msg.message && typeof msg.message === 'object') {
		const message = msg.message as Record<string, unknown>;
		const content = message.content;

		if (typeof content === 'string') {
			lines.push({ type: 'text', content });
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== 'object') continue;
				const b = block as Record<string, unknown>;

				if (b.type === 'text' && typeof b.text === 'string') {
					lines.push({ type: 'text', content: b.text });
				} else if (b.type === 'thinking' && typeof b.thinking === 'string') {
					lines.push({ type: 'thinking', content: b.thinking });
				} else if (b.type === 'tool_use' && typeof b.name === 'string') {
					const toolDesc = formatToolUse(b);
					lines.push({ type: 'tool', content: toolDesc });
				} else if (b.type === 'tool_result') {
					// Skip tool results - they're internal plumbing
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
			lines.push({ type: 'text', content: part.text });
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
		const cmd = String(input.command);
		return `→ $ ${cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd}`;
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
