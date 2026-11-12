/**
 * Saved playbooks: one file per agent, `userData/playbooks/<sessionId>.json`, holding
 * `{ playbooks: [...] }`. The Auto Run panel lists and edits them through the `playbooks:*` IPC
 * handlers, a marketplace import adds one, and Playbook Launch removes the one its import added.
 *
 * Entries stay untyped (`any`), as the IPC handlers have always kept them: the file holds whatever
 * each Maestro version wrote, and every handler passes unknown fields through.
 */

import fs from 'fs/promises';
import path from 'path';
import type { App } from 'electron';

/** The file that holds one agent's saved playbooks. */
export function getSavedPlaybooksFilePath(app: Pick<App, 'getPath'>, sessionId: string): string {
	return path.join(app.getPath('userData'), 'playbooks', `${sessionId}.json`);
}

/** One agent's saved playbooks. A missing file, or one that is not valid JSON, reads as none. */
export async function readSavedPlaybooks(
	app: Pick<App, 'getPath'>,
	sessionId: string
): Promise<any[]> {
	try {
		const content = await fs.readFile(getSavedPlaybooksFilePath(app, sessionId), 'utf-8');
		const data = JSON.parse(content);
		return Array.isArray(data.playbooks) ? data.playbooks : [];
	} catch {
		// File doesn't exist or is invalid, return empty array
		return [];
	}
}

/** Replace one agent's saved playbooks, creating the playbooks folder when it is missing. */
export async function writeSavedPlaybooks(
	app: Pick<App, 'getPath'>,
	sessionId: string,
	playbooks: any[]
): Promise<void> {
	const filePath = getSavedPlaybooksFilePath(app, sessionId);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify({ playbooks }, null, 2), 'utf-8');
}

/**
 * Remove one saved playbook. Resolves the entry it removed, or `undefined` when the agent has no
 * playbook with that id (or the id is empty). Nothing is written then, so a file that could not be
 * read (and so read as empty) is never replaced by an empty list.
 */
export async function deleteSavedPlaybook(
	app: Pick<App, 'getPath'>,
	sessionId: string,
	playbookId: string
): Promise<any | undefined> {
	// An id from IPC can be missing; it must never match an entry that has no id either.
	if (!playbookId) return undefined;
	const playbooks = await readSavedPlaybooks(app, sessionId);
	const index = playbooks.findIndex((playbook: any) => playbook?.id === playbookId);
	if (index === -1) return undefined;
	const [deleted] = playbooks.splice(index, 1);
	await writeSavedPlaybooks(app, sessionId, playbooks);
	return deleted;
}
