/**
 * Turns one transcript entry into what the terminal draws: a header line and a
 * list of markdown blocks. Pure, so the rules (which entries are tool calls,
 * which are finished, what an expanded tool call shows) are tested without Ink.
 */

import {
	describeToolActivity,
	describeToolActivityStatus,
	type LogEntryRecord,
	type ToolActivityStatus,
} from '../../shared/maestro-lib';
import { highlightCode } from './highlight';
import { parseMarkdown, type Block } from './markdown';

export interface SourceStyle {
	label: string;
	color?: string;
	dimColor?: boolean;
}

const SOURCE_STYLES: Record<string, SourceStyle> = {
	user: { label: 'You', color: 'green' },
	ai: { label: 'Agent', color: '#9146FF' },
	thinking: { label: 'Thinking', dimColor: true },
	system: { label: 'System', dimColor: true },
	error: { label: 'Error', color: 'red' },
	stderr: { label: 'stderr', color: 'red' },
	stdout: { label: 'Output', color: 'cyan' },
	tool: { label: 'Tool', color: 'yellow' },
};

/** How an entry's header reads. An entry kind from a newer build still gets its own name. */
export function sourceStyle(source: string): SourceStyle {
	return SOURCE_STYLES[source] ?? { label: source, dimColor: true };
}

export const TOOL_STATUS_GLYPHS: Record<ToolActivityStatus, string> = {
	running: '…',
	completed: '✓',
	failed: '✗',
};

/** An expanded tool call shows at most this many lines of input and of output. */
export const MAX_TOOL_DETAIL_LINES = 40;

export function isToolEntry(entry: LogEntryRecord): boolean {
	return entry.source === 'tool';
}

function toolStateOf(entry: LogEntryRecord) {
	return entry.metadata?.toolState;
}

export interface ToolSummary {
	status: ToolActivityStatus;
	/** `Read src/App.tsx`: the one line a collapsed call shows. */
	line: string;
}

export function summarizeToolEntry(entry: LogEntryRecord): ToolSummary {
	const state = toolStateOf(entry);
	const label = describeToolActivity(entry.text, state?.input);
	return {
		status: describeToolActivityStatus(state),
		line: [label.verb, label.target].filter(Boolean).join(' '),
	};
}

/**
 * Whether an entry is done changing. Only a tool call still running is not.
 * Callers keep the entries from the first unfinished one onward live, so a
 * finished entry is never printed ahead of one that can still change.
 */
export function isFinishedEntry(entry: LogEntryRecord): boolean {
	return !isToolEntry(entry) || summarizeToolEntry(entry).status !== 'running';
}

/** The entries before the first unfinished one, and everything from it on. */
export function splitFinished(entries: readonly LogEntryRecord[]): {
	finished: LogEntryRecord[];
	live: LogEntryRecord[];
} {
	const firstLive = entries.findIndex((entry) => !isFinishedEntry(entry));
	if (firstLive === -1) return { finished: [...entries], live: [] };
	return { finished: entries.slice(0, firstLive), live: entries.slice(firstLive) };
}

function capLines(text: string): string {
	const lines = text.split('\n');
	if (lines.length <= MAX_TOOL_DETAIL_LINES) return text;
	const hidden = lines.length - MAX_TOOL_DETAIL_LINES;
	return [...lines.slice(0, MAX_TOOL_DETAIL_LINES), `… ${hidden} more lines`].join('\n');
}

function codeBlock(text: string, language: string | undefined): Block {
	const capped = capLines(text);
	return { kind: 'code', language, lines: highlightCode(capped, language) };
}

/** The input and output of a tool call, as code blocks. Empty when it carried neither. */
function toolDetailBlocks(entry: LogEntryRecord): Block[] {
	const state = toolStateOf(entry);
	const blocks: Block[] = [];
	const { input, output } = state ?? {};
	if (input !== undefined && input !== null && input !== '') {
		blocks.push(
			typeof input === 'string'
				? codeBlock(input, undefined)
				: codeBlock(JSON.stringify(input, null, 2), 'json')
		);
	}
	if (typeof output === 'string' && output.trim()) {
		blocks.push(codeBlock(output, undefined));
	} else if (output !== undefined && output !== null && typeof output !== 'string') {
		blocks.push(codeBlock(JSON.stringify(output, null, 2), 'json'));
	}
	return blocks;
}

const parsedMarkdown = new WeakMap<LogEntryRecord, { text: string; blocks: Block[] }>();

/**
 * Markdown blocks for an entry's text, parsed once per entry. The transcript
 * redraws on every key; without this each redraw would re-lex every message.
 */
export function entryBlocks(entry: LogEntryRecord): Block[] {
	const cached = parsedMarkdown.get(entry);
	if (cached && cached.text === entry.text) return cached.blocks;
	const blocks =
		entry.source === 'stdout' || entry.source === 'stderr'
			? // Command output is not authored markdown: underscores and asterisks in it are literal.
				[codeBlock(entry.text, undefined)]
			: parseMarkdown(entry.text);
	parsedMarkdown.set(entry, { text: entry.text, blocks });
	return blocks;
}

/** What sits under an entry's header line: nothing for a collapsed tool call. */
export function entryBodyBlocks(entry: LogEntryRecord, expandTools: boolean): Block[] {
	if (isToolEntry(entry)) return expandTools ? toolDetailBlocks(entry) : [];
	return entryBlocks(entry);
}

/** A subagent's tool call sits one step in from its parent's. */
export function entryIndent(entry: LogEntryRecord): number {
	return entry.metadata?.parentToolUseId ? 2 : 0;
}
