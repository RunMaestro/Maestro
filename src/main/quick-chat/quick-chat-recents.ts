/**
 * Quick Chat recent chats - the list the window's History button and
 * `maestro-cli quick-chat history` show, and `recall` brings a chat back from.
 *
 * The engine (the app renderer running the chat) reports each chat as it
 * changes; this keeps the newest few, per device. Tab ids are per device, so
 * the list is too: it lives in its own store beside the window state, never in
 * the synced settings.
 *
 * The `Store` instance is created lazily on first call so tests can
 * `vi.mock('electron-store')` before the module is touched.
 */

import Store from 'electron-store';
import {
	parseQuickChatRecent,
	upsertQuickChatRecent,
	type QuickChatRecent,
} from '../../shared/quickChat';

/** Where the list persists. Injectable so the controller can be tested without disk. */
export interface QuickChatRecentsStore {
	get(): unknown;
	set(recents: QuickChatRecent[]): void;
}

interface QuickChatRecentsData {
	recents: QuickChatRecent[];
}

let _store: Store<QuickChatRecentsData> | null = null;

/** The on-disk store (`maestro-quick-chat-recents.json`). */
export function createQuickChatRecentsDiskStore(): QuickChatRecentsStore {
	const store = () => {
		if (_store === null) {
			_store = new Store<QuickChatRecentsData>({
				name: 'maestro-quick-chat-recents',
				defaults: { recents: [] },
			});
		}
		return _store;
	};
	return {
		get: () => store().get('recents', []),
		set: (recents) => store().set('recents', recents),
	};
}

/** The list over a store: read once, then kept in memory and written through. */
export interface QuickChatRecents {
	list(): QuickChatRecent[];
	get(id: string): QuickChatRecent | null;
	/** Remember a chat the engine reported. False when it is not a chat. */
	save(raw: unknown): boolean;
}

export function createQuickChatRecents(store: QuickChatRecentsStore): QuickChatRecents {
	let cache: QuickChatRecent[] | null = null;
	const list = (): QuickChatRecent[] => {
		if (cache) return cache;
		const raw = store.get();
		// A hand-edited or older file: keep what still reads as a chat.
		cache = (Array.isArray(raw) ? raw : [])
			.map(parseQuickChatRecent)
			.filter((r): r is QuickChatRecent => r !== null)
			.reduce<QuickChatRecent[]>((acc, r) => upsertQuickChatRecent(acc, r), []);
		return cache;
	};
	return {
		list,
		get: (id) => list().find((r) => r.id === id) ?? null,
		save: (raw) => {
			const recent = parseQuickChatRecent(raw);
			if (!recent) return false;
			cache = upsertQuickChatRecent(list(), recent);
			store.set(cache);
			return true;
		},
	};
}
