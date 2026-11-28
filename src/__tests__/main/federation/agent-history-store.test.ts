/**
 * The desktop's History store for a Federation move (L39): every read and write goes through the
 * `HistoryManager`, each entry under its own project path.
 */
import { describe, expect, it, vi } from 'vitest';

import { desktopAgentHistoryStore } from '../../../main/federation/agent-history-store';
import type { HistoryEntry } from '../../../shared/types';

const entry = (id: string, timestamp: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id,
	type: 'AUTO',
	timestamp,
	summary: id,
	projectPath: '/work',
	sessionId: 'l',
	...extra,
});

describe('desktopAgentHistoryStore', () => {
	it("goes through the desktop's HistoryManager, appending through its checked import", async () => {
		const manager = {
			getEntriesStrict: vi.fn(async () => [entry('a', 1)]),
			getFileStamp: vi.fn(async () => null),
			importEntries: vi.fn(async () => 1),
			deleteEntry: vi.fn(async () => true),
			updateEntry: vi.fn(async () => false),
		};
		const store = desktopAgentHistoryStore(manager);
		expect(await store.read('l')).toEqual([entry('a', 1)]);
		const b = entry('b', 2, { projectPath: '/remote/project' });
		await store.append('l', [b]);
		expect(manager.importEntries).toHaveBeenCalledWith('l', [b]);
		expect(await store.remove?.('l', 'a')).toBe(true);
		expect(await store.update?.('l', 'a', { validated: true })).toBe(false);
		expect(manager.updateEntry).toHaveBeenCalledWith('l', 'a', { validated: true });
	});

	it("keeps the parsed list until the agent's file changes, and drops it on a write (L45 b)", async () => {
		let stamp: string | null = '1:100';
		let held = [entry('a', 1)];
		const manager = {
			getEntriesStrict: vi.fn(async () => [...held]),
			getFileStamp: vi.fn(async () => stamp),
			importEntries: vi.fn(async (_id: string, entries: readonly HistoryEntry[]) => {
				held = [...entries, ...held];
				stamp = '2:200';
				return entries.length;
			}),
			deleteEntry: vi.fn(async () => true),
			updateEntry: vi.fn(async () => true),
		};
		const store = desktopAgentHistoryStore(manager);
		expect(await store.read('l')).toEqual([entry('a', 1)]);
		expect(await store.read('l')).toEqual([entry('a', 1)]);
		// The panel's next page, graph, and bar jump read the file once between writes.
		expect(manager.getEntriesStrict).toHaveBeenCalledTimes(1);

		// Another process (the CLI) wrote the file: its stamp changed, so it is read again.
		stamp = '1:150';
		held = [entry('cli', 3), ...held];
		expect((await store.read('l')).map((e) => e.id)).toEqual(['cli', 'a']);
		expect(manager.getEntriesStrict).toHaveBeenCalledTimes(2);

		// A write through the store drops the list, so a read-back sees the write.
		await store.append('l', [entry('b', 2)]);
		expect((await store.read('l')).map((e) => e.id)).toEqual(['b', 'cli', 'a']);
		expect(manager.getEntriesStrict).toHaveBeenCalledTimes(3);
		await store.update?.('l', 'a', { validated: true });
		await store.read('l');
		expect(manager.getEntriesStrict).toHaveBeenCalledTimes(4);

		// No file to stamp (a legacy file not migrated yet): never kept.
		stamp = null;
		await store.read('l');
		await store.read('l');
		expect(manager.getEntriesStrict).toHaveBeenCalledTimes(6);
	});
});
