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
	it("goes through the desktop's HistoryManager, each entry under its own project path", async () => {
		const manager = {
			getEntries: vi.fn(async () => [entry('a', 1)]),
			addEntry: vi.fn(async () => undefined),
			deleteEntry: vi.fn(async () => true),
			updateEntry: vi.fn(async () => false),
		};
		const store = desktopAgentHistoryStore(manager);
		expect(await store.read('l')).toEqual([entry('a', 1)]);
		const b = entry('b', 2, { projectPath: '/remote/project' });
		await store.append('l', [b]);
		expect(manager.addEntry).toHaveBeenCalledWith('l', '/remote/project', b);
		expect(await store.remove?.('l', 'a')).toBe(true);
		expect(await store.update?.('l', 'a', { validated: true })).toBe(false);
		expect(manager.updateEntry).toHaveBeenCalledWith('l', 'a', { validated: true });
	});
});
