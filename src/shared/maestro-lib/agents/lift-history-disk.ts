import { createHistoryWriter } from '../turns/history';
import type { MaestroPaths } from '../paths/resolve';
import { readHistory } from '../store/read-history';
import type { AgentHistoryStore } from './lift-history';

/**
 * This machine's History as the CLI reads and writes it without the desktop: the agent's own
 * `history/<agentId>.jsonl`, read whole, appended with `O_APPEND` (safe beside a running desktop,
 * whose History watcher picks the lines up).
 */
export function diskAgentHistoryStore(
	paths: Pick<MaestroPaths, 'historyDir'> | (() => Pick<MaestroPaths, 'historyDir'>)
): AgentHistoryStore {
	// A getter is read per call: a CLI's folder is known only once `--data-dir` applied.
	const resolve = typeof paths === 'function' ? paths : () => paths;
	return {
		read: async (agentId) => {
			const read = readHistory(resolve(), agentId, { limit: Number.MAX_SAFE_INTEGER });
			if (read.status === 'ok') return read.entries;
			if (read.status === 'missing') return [];
			throw new Error(`This machine's History of the agent could not be read: ${read.reason}`);
		},
		append: async (agentId, entries) => {
			const writer = createHistoryWriter({ paths: resolve() });
			for (const entry of entries) {
				const result = await writer.append(agentId, entry);
				if (!result.ok) throw new Error(result.message);
			}
		},
	};
}
