import { describe, it, expect } from 'vitest';
import {
	MODERATOR_PARTICIPANT_NAME,
	filterGroupChatHistory,
	isDirectModeratorMessage,
} from '../../shared/groupChatModeratorView';
import type { GroupChatHistoryEntry, GroupChatMessage } from '../../shared/group-chat-types';

function message(from: string): GroupChatMessage {
	return { timestamp: new Date().toISOString(), from, content: 'hi' };
}

function entry(
	participantName: string,
	type: GroupChatHistoryEntry['type']
): GroupChatHistoryEntry {
	return {
		id: `${participantName}-${type}`,
		timestamp: Date.now(),
		summary: 'did a thing',
		participantName,
		participantColor: '#fff',
		type,
	};
}

describe('isDirectModeratorMessage', () => {
	it('keeps the user, the moderator, and system notices', () => {
		expect(isDirectModeratorMessage(message('user'))).toBe(true);
		expect(isDirectModeratorMessage(message('moderator'))).toBe(true);
		expect(isDirectModeratorMessage(message('system'))).toBe(true);
	});

	it('drops a participant reply', () => {
		expect(isDirectModeratorMessage(message('rc'))).toBe(false);
	});

	it('drops a delegation the moderator sent to a participant', () => {
		// Logged as `moderator->{name}`, which starts with the moderator's own
		// sender name - a prefix test here would leak every delegation through.
		expect(isDirectModeratorMessage(message('moderator->rc'))).toBe(false);
	});
});

describe('filterGroupChatHistory', () => {
	const entries = [
		entry(MODERATOR_PARTICIPANT_NAME, 'delegation'),
		entry('rc', 'response'),
		entry(MODERATOR_PARTICIPANT_NAME, 'synthesis'),
		entry('RunMaestro.ai', 'response'),
	];

	it('returns every entry in the team view', () => {
		expect(filterGroupChatHistory(entries, false)).toBe(entries);
	});

	it('keeps only the moderator’s own entries in the moderator view', () => {
		const filtered = filterGroupChatHistory(entries, true);
		expect(filtered.map((e) => e.type)).toEqual(['delegation', 'synthesis']);
	});

	it('handles an empty log', () => {
		expect(filterGroupChatHistory([], true)).toEqual([]);
	});
});
