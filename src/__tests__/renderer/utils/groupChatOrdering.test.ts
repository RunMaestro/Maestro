/**
 * Tests for group-chat display ordering and post-delete focus selection.
 */
import { describe, it, expect } from 'vitest';
import {
	orderGroupChatsForDisplay,
	pickNextGroupChatIdAfterDelete,
} from '../../../renderer/utils/groupChatOrdering';

const chats = [
	{ id: 'a', name: 'Charlie', updatedAt: 1 },
	{ id: 'b', name: 'Alpha', updatedAt: 3 },
	{ id: 'c', name: 'Bravo', updatedAt: 2, archived: true },
	{ id: 'd', name: 'Delta', createdAt: 2, updatedAt: undefined as unknown as number },
];

describe('orderGroupChatsForDisplay', () => {
	it('drops archived chats and sorts by most-recent activity by default', () => {
		const ordered = orderGroupChatsForDisplay(chats, false);
		expect(ordered.map((c) => c.id)).toEqual(['b', 'd', 'a']);
	});

	it('sorts alphabetically when the toggle is on', () => {
		const ordered = orderGroupChatsForDisplay(chats, true);
		expect(ordered.map((c) => c.name)).toEqual(['Alpha', 'Charlie', 'Delta']);
	});
});

describe('pickNextGroupChatIdAfterDelete', () => {
	const list = [
		{ id: 'gc-1', name: 'One', updatedAt: 3 },
		{ id: 'gc-2', name: 'Two', updatedAt: 2 },
		{ id: 'gc-3', name: 'Three', updatedAt: 1 },
	];

	it('returns the chat that shifts up into the deleted slot (next below)', () => {
		expect(pickNextGroupChatIdAfterDelete('gc-1', list, false)).toBe('gc-2');
		expect(pickNextGroupChatIdAfterDelete('gc-2', list, false)).toBe('gc-3');
	});

	it('returns the new last chat when deleting the bottom-most one', () => {
		expect(pickNextGroupChatIdAfterDelete('gc-3', list, false)).toBe('gc-2');
	});

	it('returns null when the deleted chat is the only one', () => {
		expect(pickNextGroupChatIdAfterDelete('gc-1', [list[0]], false)).toBeNull();
	});

	it('returns null when the deleted id is not in the list', () => {
		expect(pickNextGroupChatIdAfterDelete('missing', list, false)).toBeNull();
	});

	it('ignores archived chats when choosing the next focus', () => {
		const withArchived = [
			{ id: 'gc-1', name: 'One', updatedAt: 3 },
			{ id: 'gc-2', name: 'Two', updatedAt: 2, archived: true },
			{ id: 'gc-3', name: 'Three', updatedAt: 1 },
		];
		// Visible order is gc-1, gc-3; deleting gc-1 focuses gc-3.
		expect(pickNextGroupChatIdAfterDelete('gc-1', withArchived, false)).toBe('gc-3');
	});
});
