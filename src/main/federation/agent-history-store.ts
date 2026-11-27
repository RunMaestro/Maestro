/**
 * This machine's History of its agents as a Federation move reads and writes it
 * (`AgentHistoryStore` in `src/shared/maestro-lib/agents/lift-history.ts`), over the desktop's
 * `HistoryManager`: the same file, queue, and rotation every History write here takes. The append
 * is `importEntries()`, which throws on a failed write (`addEntry()` only logs one), so a move
 * stops before it removes the host's copy.
 *
 * A hosted agent's History panel reads this machine's half of the list through `read` on every
 * page, graph, and bar jump (`federation:historyPage` and siblings). The parsed list is kept per
 * agent until its file changes (`HistoryManager.getFileStamp()`: any write, from this app or the
 * CLI), and dropped on every write made through this store.
 */

import type { AgentHistoryStore } from '../../shared/maestro-lib/agents/lift-history';
import type { HistoryEntry } from '../../shared/types';
import type { HistoryManager } from '../history-manager';

/** Agents whose parsed History is kept at once: the local records of the hosted agents open. */
const MAX_CACHED_AGENTS = 16;

export function desktopAgentHistoryStore(
	manager: Pick<
		HistoryManager,
		'getEntriesStrict' | 'getFileStamp' | 'importEntries' | 'deleteEntry' | 'updateEntry'
	>
): AgentHistoryStore {
	const cache = new Map<string, { stamp: string; entries: HistoryEntry[] }>();
	return {
		read: async (agentId) => {
			// The stamp is taken BEFORE the read: a write landing in between leaves a stale stamp
			// beside the newer list, so the next read misses and reads again. Never the reverse.
			const stamp = await manager.getFileStamp(agentId);
			const held = cache.get(agentId);
			if (stamp && held?.stamp === stamp) return [...held.entries];
			// Strict: a file that cannot be read must not read as "no History" to a move or a panel.
			const entries = await manager.getEntriesStrict(agentId);
			cache.delete(agentId);
			if (stamp) {
				cache.set(agentId, { stamp, entries });
				if (cache.size > MAX_CACHED_AGENTS) cache.delete(cache.keys().next().value as string);
			}
			return [...entries];
		},
		append: async (agentId, entries) => {
			cache.delete(agentId);
			try {
				await manager.importEntries(agentId, entries);
			} finally {
				cache.delete(agentId);
			}
		},
		remove: async (agentId, entryId) => {
			cache.delete(agentId);
			return manager.deleteEntry(agentId, entryId);
		},
		update: async (agentId, entryId, updates) => {
			cache.delete(agentId);
			return manager.updateEntry(agentId, entryId, updates);
		},
	};
}
