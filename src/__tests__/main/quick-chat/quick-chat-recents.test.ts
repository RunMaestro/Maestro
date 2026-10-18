/**
 * @file quick-chat-recents.test.ts
 * @description The recent chats list over its store: read once, written
 * through, malformed entries dropped, newest first.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron-store', () => ({ default: vi.fn() }));

import { createQuickChatRecents } from '../../../main/quick-chat/quick-chat-recents';
import type { QuickChatRecent } from '../../../shared/quickChat';

const chat = (id: string, updatedAt: number): QuickChatRecent => ({
	id,
	agentId: 'agent-1',
	agentName: 'Pedsidian',
	persistent: false,
	createdAt: 0,
	updatedAt,
	homeTabId: 'tab-1',
	homeAgentSessionId: null,
	homeTabName: null,
	ownedTabIds: [],
	turns: [
		{
			id: `${id}-t1`,
			text: 'hello',
			timestamp: 1,
			phase: 'delivered',
			error: null,
			tabId: 'tab-1',
			agentSessionId: null,
			tabName: null,
			origin: 'new',
			queuedItemId: null,
			reply: [],
		},
	],
});

function memoryStore(initial: unknown) {
	let value = initial;
	return {
		get: vi.fn(() => value),
		set: vi.fn((next: QuickChatRecent[]) => {
			value = next;
		}),
	};
}

describe('createQuickChatRecents', () => {
	it('reads the store once, dropping what is not a chat, newest first', () => {
		const store = memoryStore([chat('old', 1), { junk: true }, chat('new', 9)]);
		const recents = createQuickChatRecents(store);
		expect(recents.list().map((r) => r.id)).toEqual(['new', 'old']);
		recents.list();
		expect(store.get).toHaveBeenCalledTimes(1);
	});

	it('treats a store that is not a list as empty', () => {
		expect(createQuickChatRecents(memoryStore('garbage')).list()).toEqual([]);
	});

	it('saves a chat in place of its old copy and writes the list through', () => {
		const store = memoryStore([chat('a', 5), chat('b', 3)]);
		const recents = createQuickChatRecents(store);
		expect(recents.save(chat('b', 10))).toBe(true);
		expect(recents.list().map((r) => r.id)).toEqual(['b', 'a']);
		expect(store.set).toHaveBeenLastCalledWith(recents.list());
		expect(recents.get('b')?.updatedAt).toBe(10);
		expect(recents.get('missing')).toBeNull();
	});

	it('refuses what is not a chat, leaving the store alone', () => {
		const store = memoryStore([]);
		const recents = createQuickChatRecents(store);
		expect(recents.save({ id: 'x' })).toBe(false);
		expect(store.set).not.toHaveBeenCalled();
	});
});
