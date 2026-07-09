import type { ToolSummary } from '../types';

/** Handle command values that may be strings or string arrays (Codex uses arrays) */
const safeCommand = (v: unknown): string | null => {
	if (typeof v === 'string') return v;
	if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
		return v.join(' ');
	}
	return null;
};

/** Summarize TodoWrite todos array - shows in-progress task and progress count */
const summarizeTodos = (v: unknown): string | null => {
	if (!Array.isArray(v) || v.length === 0) return null;
	const todos = v as Array<{ content?: string; status?: string; activeForm?: string }>;
	const completed = todos.filter((t) => t.status === 'completed').length;
	const inProgress = todos.find((t) => t.status === 'in_progress');
	const label = inProgress?.activeForm || inProgress?.content || todos[0]?.content;
	if (!label) return `${todos.length} tasks`;
	return `${label} (${completed}/${todos.length})`;
};

/**
 * Summarize tool input generically - no per-tool extractors needed.
 * Returns structured data so the renderer can display description and command
 * with proper visual hierarchy.
 *
 * Tool logs are only emitted when thinking is enabled, so we show the full
 * command text without truncation to give complete visibility into agent actions.
 */
export const summarizeToolInput = (input: unknown): ToolSummary | null => {
	// Some agents (notably Copilot/Codex apply_patch) deliver the tool argument
	// as a raw string instead of an object - Object.entries on a string would
	// iterate it character-by-character and produce garbled, space-separated
	// output, so surface the string as-is.
	if (typeof input === 'string') {
		return input ? { detail: input } : null;
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return null;
	}
	const inputRecord = input as Record<string, unknown>;

	// Special case: TodoWrite todos array
	const todosResult = summarizeTodos(inputRecord.todos);
	if (todosResult) return { detail: todosResult };

	// Extract description field separately for structured display
	const description =
		typeof inputRecord.description === 'string' && inputRecord.description
			? inputRecord.description
			: undefined;

	// Collect displayable values (skip huge blobs)
	const parts: string[] = [];
	for (const [key, val] of Object.entries(inputRecord)) {
		if (val === undefined || val === null || val === '') continue;
		// Skip description - rendered separately
		if (key === 'description') continue;
		// Command arrays (Codex)
		const cmd = safeCommand(val);
		if (cmd) {
			parts.push(cmd);
			continue;
		}
		// Arrays: show count
		if (Array.isArray(val)) {
			parts.push(`${key}: [${val.length}]`);
			continue;
		}
		// Objects: skip (too noisy)
		if (typeof val === 'object') continue;
		// Booleans/numbers: show as key=value
		if (typeof val === 'boolean' || typeof val === 'number') {
			parts.push(`${key}=${val}`);
			continue;
		}
	}
	const detail = parts.length > 0 ? parts.join('  ') : undefined;
	if (!detail && !description) return null;
	return { description, detail: detail ?? '' };
};

/** Max lines of tool output to preview inline before truncating. */
const TOOL_OUTPUT_PREVIEW_LINES = 8;

/**
 * Summarize tool output for inline display. MCP tools (and others) return their
 * result in `toolState.output`; without this the compact tool log shows only the
 * name + status icon and drops the result entirely. Strings render as-is, objects
 * are JSON-stringified. Output is capped to a short preview so large results don't
 * flood the chat.
 */
export const summarizeToolOutput = (output: unknown): string | null => {
	if (output === undefined || output === null) return null;
	let text: string;
	if (typeof output === 'string') {
		text = output;
	} else {
		try {
			text = JSON.stringify(output, null, 2);
		} catch {
			return null;
		}
	}
	text = text.trim();
	if (!text) return null;
	const lines = text.split('\n');
	if (lines.length > TOOL_OUTPUT_PREVIEW_LINES) {
		return lines.slice(0, TOOL_OUTPUT_PREVIEW_LINES).join('\n') + '\n…';
	}
	return text;
};
