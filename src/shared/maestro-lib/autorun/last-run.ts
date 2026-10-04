/**
 * When an agent last ran Auto Run, from its history (AR-1).
 *
 * An Auto Run writes one AUTO entry per task, none of which names its document,
 * so "last run" is a fact about the agent, not about one document. The newest
 * AUTO entry is when work last finished; an agent that has never run Auto Run
 * has none.
 */

import { readHistory } from '../store/read-history';
import type { MaestroPaths } from '../paths/resolve';

export interface LastAutoRun {
	/** Epoch ms of the newest AUTO entry. */
	at: number;
	success?: boolean;
	summary: string;
}

/** USER entries pile up between runs, so look past a few pages before saying "never". */
const MAX_PAGES = 10;
const PAGE_SIZE = 200;

export function findLastAutoRun(
	paths: Pick<MaestroPaths, 'historyDir'>,
	agentId: string
): LastAutoRun | undefined {
	let before: number | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = readHistory(paths, agentId, { limit: PAGE_SIZE, before });
		if (result.status !== 'ok') return undefined;
		const entry = result.entries.find((candidate) => candidate.type === 'AUTO');
		if (entry) return { at: entry.timestamp, success: entry.success, summary: entry.summary };
		if (!result.hasMore) return undefined;
		before = result.nextBefore;
	}
	return undefined;
}
