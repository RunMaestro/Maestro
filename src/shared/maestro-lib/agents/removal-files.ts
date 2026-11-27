/**
 * The files an agent leaves beside its record, removed with it: its playbooks and its closed-tab
 * archive. One rule for every way an agent leaves a host: a remove and the replace an import does
 * of a copy a Move Back left (the headless repository and the desktop's `import_agent`).
 *
 * Kept on purpose: History, the provider's own session files, the working directory (AG-5).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { removeClosedTabArchive } from './closed-tabs';

/** An id that is safe to use as a file name under a folder: no separator can climb out of it. */
export function isSafeFileId(id: string): boolean {
	return id.length > 0 && !/[\\/]/.test(id) && id !== '.' && id !== '..';
}

export interface AgentFilePaths {
	/** Where `playbooks/<agentId>.json` lives. */
	userDataDir: string;
	/**
	 * Where `closed-tabs/<agentId>` lives. Absent on a host that keeps an agent's closed tabs on its
	 * record (the desktop app), which drops them with the record.
	 */
	syncDir?: string;
}

/** Remove an agent's playbooks and closed-tab archive. A missing file is fine. */
export async function removeAgentFiles(paths: AgentFilePaths, agentId: string): Promise<void> {
	if (isSafeFileId(agentId)) {
		await fs.rm(path.join(paths.userDataDir, 'playbooks', `${agentId}.json`), { force: true });
	}
	if (paths.syncDir !== undefined) await removeClosedTabArchive(paths.syncDir, agentId);
}
