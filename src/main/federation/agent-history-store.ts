/**
 * This machine's History of its agents as a Federation move reads and writes it
 * (`AgentHistoryStore` in `src/shared/maestro-lib/agents/lift-history.ts`), over the desktop's
 * `HistoryManager`: the same file, queue, and rotation every History write here takes.
 */

import type { AgentHistoryStore } from '../../shared/maestro-lib/agents/lift-history';
import type { HistoryManager } from '../history-manager';

export function desktopAgentHistoryStore(
	manager: Pick<HistoryManager, 'getEntries' | 'addEntry' | 'deleteEntry' | 'updateEntry'>
): AgentHistoryStore {
	return {
		read: (agentId) => manager.getEntries(agentId),
		append: async (agentId, entries) => {
			for (const entry of entries) await manager.addEntry(agentId, entry.projectPath, entry);
		},
		remove: (agentId, entryId) => manager.deleteEntry(agentId, entryId),
		update: (agentId, entryId, updates) => manager.updateEntry(agentId, entryId, updates),
	};
}
