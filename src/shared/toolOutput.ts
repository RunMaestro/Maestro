/** Maximum tool result kept in Maestro's session cache. */
export const MAX_PERSISTED_TOOL_OUTPUT_CHARS = 4000;

const truncationNote = (length: number): string =>
	`\n... [tool output truncated, ${length} chars total]`;

/**
 * Keep a tool result small enough for session persistence and browser bootstrap.
 * Short values retain their original type. Oversized objects become a JSON preview.
 */
export function compactToolOutput(output: unknown): { output: unknown; truncated: boolean } {
	if (typeof output === 'string') {
		if (output.length <= MAX_PERSISTED_TOOL_OUTPUT_CHARS) {
			return { output, truncated: false };
		}
		return {
			output: `${output.slice(0, MAX_PERSISTED_TOOL_OUTPUT_CHARS)}${truncationNote(output.length)}`,
			truncated: true,
		};
	}

	if (output === undefined || output === null) return { output, truncated: false };
	try {
		const serialized = JSON.stringify(output);
		if (!serialized || serialized.length <= MAX_PERSISTED_TOOL_OUTPUT_CHARS) {
			return { output, truncated: false };
		}
		return {
			output: `${serialized.slice(0, MAX_PERSISTED_TOOL_OUTPUT_CHARS)}${truncationNote(serialized.length)}`,
			truncated: true,
		};
	} catch {
		return { output: '[tool output omitted: serialization failed]', truncated: true };
	}
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
		if (!Object.prototype.hasOwnProperty.call(state, 'output')) return entry;

		const compacted = compactToolOutput(state.output);
		if (!compacted.truncated) return entry;
		count += 1;
		return {
			...log,
			metadata: {
				...(metadata as Record<string, unknown>),
				toolState: { ...state, output: compacted.output },
			},
		};
	});
	return { value: count > 0 ? logs : value, count };
}

function compactTab(value: unknown): CompactedValue<unknown> {
	if (!value || typeof value !== 'object') return { value, count: 0 };
	const tab = value as Record<string, unknown>;
	const compacted = compactLogs(tab.logs);
	return compacted.count > 0
		? { value: { ...tab, logs: compacted.value }, count: compacted.count }
		: { value, count: 0 };
}

/**
 * Compact tool results in live and snoozed AI tabs without changing the input.
 * The generic return keeps the caller's full session shape intact.
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

	return compacted > 0
		? { session: { ...source, aiLogs: legacyLogs.value, aiTabs, snoozedTabs } as T, compacted }
		: { session, compacted: 0 };
}
