/**
 * An in-memory `AgentHistoryStore` (`src/shared/maestro-lib/agents/lift-history.ts`) for tests of a
 * Federation move: one machine's History of its agents, by agent id, with every append recorded.
 */

import type { AgentHistoryStore } from '../../shared/maestro-lib/agents/lift-history';
import type { HistoryEntry } from '../../shared/types';

export interface MemoryAgentHistoryStore extends AgentHistoryStore {
	/** The entries an agent holds now, newest first. */
	entriesOf(agentId: string): HistoryEntry[];
	/** Every `append` call, in order. */
	appends: Array<{ agentId: string; entries: HistoryEntry[] }>;
}

export function createMemoryAgentHistoryStore(
	initial: Record<string, HistoryEntry[]> = {}
): MemoryAgentHistoryStore {
	const byAgent = new Map(Object.entries(initial).map(([id, list]) => [id, [...list]]));
	const appends: MemoryAgentHistoryStore['appends'] = [];
	const list = (agentId: string) => byAgent.get(agentId) ?? [];
	const edit = (
		agentId: string,
		entryId: string,
		change: (entry: HistoryEntry) => HistoryEntry | null
	) => {
		const entries = list(agentId);
		const index = entries.findIndex((entry) => entry.id === entryId);
		if (index === -1) return false;
		const next = change(entries[index]);
		byAgent.set(
			agentId,
			next
				? entries.map((entry, i) => (i === index ? next : entry))
				: entries.filter((_, i) => i !== index)
		);
		return true;
	};
	return {
		appends,
		entriesOf: (agentId) => [...list(agentId)].sort((a, b) => b.timestamp - a.timestamp),
		read: async (agentId) => [...list(agentId)],
		append: async (agentId, entries) => {
			appends.push({ agentId, entries: [...entries] });
			byAgent.set(agentId, [...list(agentId), ...entries]);
		},
		remove: async (agentId, entryId) => edit(agentId, entryId, () => null),
		update: async (agentId, entryId, updates) =>
			edit(agentId, entryId, (entry) => ({ ...entry, ...updates })),
	};
}
