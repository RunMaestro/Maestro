/**
 * A group chat's lines as transcript entries, so the chat reads through the same
 * viewport and markdown renderer as an agent's conversation. A line's `source`
 * carries who said it (`gc:moderator`, `gc:participant:Claude`), and
 * `groupChatStyle` turns that into the header the entry view draws: the
 * sender's own name rather than the one-word labels an agent's transcript has.
 */

import type { GroupChatLine, LogEntryRecord } from '../../shared/maestro-lib';
import type { SourceStyle } from '../transcript/entries';

const SOURCE_PREFIX = 'gc:';
const PARTICIPANT_PREFIX = `${SOURCE_PREFIX}participant:`;

/** Terminal colors a participant takes, by a hash of its name, so a name keeps its color. */
const PARTICIPANT_COLORS = ['cyan', 'yellow', 'magenta', 'blue', 'redBright'] as const;

export function participantColor(name: string): string {
	let hash = 0;
	for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
	return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length]!;
}

export function groupChatEntry(line: GroupChatLine): LogEntryRecord {
	return {
		id: line.id,
		timestamp: line.at,
		source:
			line.speaker === 'participant'
				? `${PARTICIPANT_PREFIX}${line.from}`
				: `${SOURCE_PREFIX}${line.speaker}`,
		text: line.text,
	};
}

export function groupChatEntries(lines: readonly GroupChatLine[]): LogEntryRecord[] {
	return lines.map(groupChatEntry);
}

/** The header style for a group chat entry, or undefined for any other entry. Module-level so a memoized entry view keeps its identity. */
export function groupChatStyle(entry: LogEntryRecord): SourceStyle | undefined {
	const { source } = entry;
	if (!source.startsWith(SOURCE_PREFIX)) return undefined;
	if (source.startsWith(PARTICIPANT_PREFIX)) {
		const name = source.slice(PARTICIPANT_PREFIX.length);
		return { label: name, color: participantColor(name) };
	}
	switch (source.slice(SOURCE_PREFIX.length)) {
		case 'user':
			return { label: 'You', color: 'green' };
		case 'moderator':
			return { label: 'Moderator', color: '#9146FF' };
		case 'system':
			return { label: 'System', dimColor: true };
		default:
			return { label: source.slice(SOURCE_PREFIX.length), dimColor: true };
	}
}
