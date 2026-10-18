/**
 * The closed-tab archive (CH-1, gap G13, decision RT6).
 *
 * The desktop keeps closed tabs only in memory: `useDebouncedPersistence` strips
 * `closedTabHistory` and `useSessionRestoration` resets it to `[]` on load. A closed
 * tab the runtime wrote into the agent record would therefore be erased by the
 * desktop's first flush, so the runtime keeps its own archive, one file per agent:
 *
 *   `<syncDir>/closed-tabs/<agentId>.json`  ->  `{ "closedTabs": [ ClosedTab, ... ] }`
 *
 * Newest first, bounded like the desktop (25 tabs, 100 log entries each). An entry
 * is the desktop's `ClosedTab` shape, so the desktop can load an archive straight
 * into `closedTabHistory` when it learns to (L1b). A tab that falls off the end
 * still has its provider session file and its History entries.
 *
 * The archive is written BEFORE the sessions record changes (see the repository),
 * so a close can never lose a transcript: a failure between the two writes leaves
 * the tab open and also archived, and reopening dedupes by tab id.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { MAX_PERSISTED_SESSION_LOGS } from '../../deferredSessionContent';
import { logger } from '../host';
import { quarantineStoreFile, readStoreDocument, writeStoreDocument } from '../store/io';
import type { ClosedTabRecord } from '../store/records';

const LOG_CONTEXT = '[ClosedTabs]';

/** Tabs kept per agent. The desktop's `MAX_CLOSED_TAB_HISTORY`. */
export const MAX_CLOSED_TAB_ARCHIVE = 25;

/** Folder under the sync directory holding one archive per agent. */
export const CLOSED_TABS_DIR = 'closed-tabs';

interface ClosedTabsDocument {
	closedTabs?: ClosedTabRecord[];
	[key: string]: unknown;
}

/** The file name for an agent id: ids are UUIDs, and any other character is percent-encoded. */
function fileNameFor(agentId: string): string {
	const safe = agentId.replace(/[^A-Za-z0-9_-]/g, (char) => {
		const code = char.charCodeAt(0);
		return `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
	});
	return `${safe}.json`;
}

export function closedTabsFile(syncDir: string, agentId: string): string {
	return path.join(syncDir, CLOSED_TABS_DIR, fileNameFor(agentId));
}

function capLogs(entry: ClosedTabRecord): ClosedTabRecord {
	const logs = entry.tab.logs;
	if (!Array.isArray(logs) || logs.length <= MAX_PERSISTED_SESSION_LOGS) return entry;
	return { ...entry, tab: { ...entry.tab, logs: logs.slice(-MAX_PERSISTED_SESSION_LOGS) } };
}

/**
 * Read one agent's archive, newest first. A missing file is an empty archive. A
 * file that is not JSON is moved aside (never deleted) and reads as empty:
 * refusing to close a tab because its history was torn would be worse than
 * starting the archive again, and the sidecar still holds the old bytes.
 */
export async function readClosedTabs(file: string): Promise<ClosedTabRecord[]> {
	const read = await readStoreDocument<ClosedTabsDocument>(file);
	if (read.status === 'ok') {
		return Array.isArray(read.data.closedTabs) ? read.data.closedTabs : [];
	}
	if (read.status === 'corrupt') {
		const sidecar = await quarantineStoreFile(file);
		logger.warn(`The closed-tab archive was not valid JSON; kept as ${sidecar}`, LOG_CONTEXT);
	}
	return [];
}

/**
 * Put a closed tab at the front of the agent's archive. A tab already archived
 * under the same id is replaced (closed, reopened, closed again), the logs are
 * capped, and the list is bounded. Throws when the archive cannot be written, so
 * the caller leaves the tab open.
 */
export async function archiveClosedTab(
	syncDir: string,
	agentId: string,
	closed: ClosedTabRecord
): Promise<void> {
	const file = closedTabsFile(syncDir, agentId);
	const existing = await readClosedTabs(file);
	const closedTabs = [
		capLogs(closed),
		...existing.filter((entry) => entry.tab.id !== closed.tab.id),
	].slice(0, MAX_CLOSED_TAB_ARCHIVE);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await writeStoreDocument(file, { closedTabs });
}

/** Delete an agent's archive with the agent. A missing file is fine. */
export async function removeClosedTabArchive(syncDir: string, agentId: string): Promise<void> {
	await fs.rm(closedTabsFile(syncDir, agentId), { force: true });
}
