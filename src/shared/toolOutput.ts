import { processCarriageReturns, stripAnsiCodes } from './stringUtils';
import { MAX_PERSISTED_SESSION_LOGS } from './deferredSessionContent';

/** Maximum tool result kept in Maestro's session cache. */
export const MAX_PERSISTED_TOOL_OUTPUT_CHARS = 4000;

/**
 * Maximum length of any one string inside a stored tool input. A single input
 * can carry a whole file (Write `content`, Edit `old_string`/`new_string`), up
 * to 198 KB each in one 141 MB sessions file that is rewritten on every save.
 */
export const MAX_PERSISTED_TOOL_INPUT_STRING_CHARS = 4000;

const truncationNote = (length: number): string =>
	`\n... [tool output truncated, ${length} chars total]`;

const inputTruncationNote = (length: number): string =>
	`\n... [tool input truncated, ${length} chars total]`;

/**
 * Cap every long string inside a tool input, keeping its keys, types and short
 * fields (file path, command, todo items) so the tool badge still reads it.
 */
export function compactToolInput(input: unknown): { input: unknown; truncated: boolean } {
	if (typeof input === 'string') {
		if (input.length <= MAX_PERSISTED_TOOL_INPUT_STRING_CHARS) return { input, truncated: false };
		const note = inputTruncationNote(input.length);
		return {
			input: `${input.slice(0, MAX_PERSISTED_TOOL_INPUT_STRING_CHARS - note.length)}${note}`,
			truncated: true,
		};
	}
	if (!input || typeof input !== 'object') return { input, truncated: false };
	let truncated = false;
	const capChild = (value: unknown) => {
		const result = compactToolInput(value);
		truncated ||= result.truncated;
		return result.input;
	};
	const next = Array.isArray(input)
		? input.map(capChild)
		: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, capChild(value)]));
	return truncated ? { input: next, truncated } : { input, truncated: false };
}

/**
 * Keep a tool result small enough for session persistence and browser bootstrap.
 * Short values retain their original type. Oversized objects become a JSON preview.
 */
export function compactToolOutput(output: unknown): { output: unknown; truncated: boolean } {
	if (typeof output === 'string') {
		if (output.length <= MAX_PERSISTED_TOOL_OUTPUT_CHARS) {
			return { output, truncated: false };
		}
		const note = truncationNote(output.length);
		return {
			output: `${output.slice(0, MAX_PERSISTED_TOOL_OUTPUT_CHARS - note.length)}${note}`,
			truncated: true,
		};
	}

	if (output === undefined || output === null) return { output, truncated: false };
	try {
		const serialized = JSON.stringify(output);
		if (!serialized || serialized.length <= MAX_PERSISTED_TOOL_OUTPUT_CHARS) {
			return { output, truncated: false };
		}
		const note = truncationNote(serialized.length);
		return {
			output: `${serialized.slice(0, MAX_PERSISTED_TOOL_OUTPUT_CHARS - note.length)}${note}`,
			truncated: true,
		};
	} catch {
		return { output: '[tool output omitted: serialization failed]', truncated: true };
	}
}

/**
 * Turn raw terminal output into the plain text a tool badge can show. The badge
 * renders `toolState.output` as text, so ANSI color codes print as `[34m` and a
 * PTY's CRLF leaves stray carriage returns. Parsers run command output through
 * this before handing it on; the result is capped like any stored tool result.
 */
export function cleanToolOutputText(text: string): string {
	const cleaned = processCarriageReturns(stripAnsiCodes(text)).replace(/\s+$/, '');
	return compactToolOutput(cleaned).output as string;
}

interface CompactedValue<T> {
	value: T;
	count: number;
}

function compactLogs(value: unknown): CompactedValue<unknown> {
	if (!Array.isArray(value)) return { value, count: 0 };
	let count = 0;
	const logs = value.map((entry) => {
		if (!entry || typeof entry !== 'object') return entry;
		const log = entry as Record<string, unknown>;
		const metadata = log.metadata;
		if (!metadata || typeof metadata !== 'object') return entry;
		const toolState = (metadata as Record<string, unknown>).toolState;
		if (!toolState || typeof toolState !== 'object') return entry;
		const state = toolState as Record<string, unknown>;
		const output = Object.prototype.hasOwnProperty.call(state, 'output')
			? compactToolOutput(state.output)
			: null;
		const input = state.input === undefined ? null : compactToolInput(state.input);
		if (!output?.truncated && !input?.truncated) return entry;
		count += 1;
		return {
			...log,
			metadata: {
				...(metadata as Record<string, unknown>),
				toolState: {
					...state,
					...(output?.truncated && { output: output.output }),
					...(input?.truncated && { input: input.input }),
				},
			},
		};
	});
	return { value: count > 0 ? logs : value, count };
}

/**
 * Compact one AI tab: its tool results and inputs, and its transcript tail to
 * the newest {@link MAX_PERSISTED_SESSION_LOGS} entries. The renderer trims the
 * tail before it saves, but rows written by any other path (or before the cap
 * existed) kept every entry.
 */
function compactTab(value: unknown): CompactedValue<unknown> {
	if (!value || typeof value !== 'object') return { value, count: 0 };
	const tab = value as Record<string, unknown>;
	const overCap = Array.isArray(tab.logs) && tab.logs.length > MAX_PERSISTED_SESSION_LOGS;
	const tail = overCap ? (tab.logs as unknown[]).slice(-MAX_PERSISTED_SESSION_LOGS) : tab.logs;
	const compacted = compactLogs(tail);
	const count = compacted.count + (overCap ? 1 : 0);
	return count > 0 ? { value: { ...tab, logs: compacted.value }, count } : { value, count: 0 };
}

/**
 * Compact tool results and inputs, and trim each transcript to its stored tail,
 * in live, snoozed, and closed AI tabs without changing the input. `compacted`
 * counts the entries and tabs changed. The generic return keeps the caller's
 * full session shape intact.
 */
export function compactSessionToolOutputs<T>(session: T): { session: T; compacted: number } {
	if (!session || typeof session !== 'object') return { session, compacted: 0 };
	const source = session as Record<string, unknown>;
	let compacted = 0;
	const legacyLogs = compactLogs(source.aiLogs);
	compacted += legacyLogs.count;

	const aiTabs = Array.isArray(source.aiTabs)
		? source.aiTabs.map((tab) => {
				const result = compactTab(tab);
				compacted += result.count;
				return result.value;
			})
		: source.aiTabs;
	const snoozedTabs = Array.isArray(source.snoozedTabs)
		? source.snoozedTabs.map((entry) => {
				if (!entry || typeof entry !== 'object') return entry;
				const snooze = entry as Record<string, unknown>;
				if (snooze.type === 'ai') {
					const result = compactTab(snooze.tab);
					compacted += result.count;
					return result.count > 0 ? { ...snooze, tab: result.value } : entry;
				}
				if (snooze.type !== 'group' || !Array.isArray(snooze.members)) return entry;
				let memberCount = 0;
				const members = snooze.members.map((member) => {
					if (!member || typeof member !== 'object') return member;
					const value = member as Record<string, unknown>;
					if (value.type !== 'ai') return member;
					const result = compactTab(value.tab);
					memberCount += result.count;
					return result.count > 0 ? { ...value, tab: result.value } : member;
				});
				compacted += memberCount;
				return memberCount > 0 ? { ...snooze, members } : entry;
			})
		: source.snoozedTabs;

	// A stored closed AI tab keeps its logs when its provider cannot give the
	// transcript back (see src/shared/closedTabHistory.ts), so it is compacted too.
	const closedTabs = Array.isArray(source.unifiedClosedTabHistory)
		? source.unifiedClosedTabHistory.map((entry) => {
				if (!entry || typeof entry !== 'object') return entry;
				const closed = entry as Record<string, unknown>;
				if (closed.type !== 'ai') return entry;
				const result = compactTab(closed.tab);
				compacted += result.count;
				return result.count > 0 ? { ...closed, tab: result.value } : entry;
			})
		: source.unifiedClosedTabHistory;

	return compacted > 0
		? {
				session: {
					...source,
					aiLogs: legacyLogs.value,
					aiTabs,
					snoozedTabs,
					...(closedTabs !== undefined ? { unifiedClosedTabHistory: closedTabs } : {}),
				} as T,
				compacted,
			}
		: { session, compacted: 0 };
}
