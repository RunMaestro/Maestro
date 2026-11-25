/**
 * Durable home for Auto Runs saved across an update restart.
 *
 * The renderer that owns a run writes its resume point here right before the
 * app quits to install an update; the next launch takes the entries once and
 * starts the runs again. The format and the rules about what is resumable live
 * in `src/shared/autorunRestartResume.ts`; this module only stores the list.
 *
 * "Take" reads and deletes in one step. An entry that survived its own resume
 * would start the same run again on every later launch.
 */

import { ipcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { atomicWriteJson, createKeyedWriteQueue } from './utils/atomic-json-store';
import { logger } from './utils/logger';
import {
	mergeRestartEntries,
	parseRestartEntries,
	type AutoRunRestartEntry,
} from '../shared/autorunRestartResume';

const LOG_CONTEXT = '[AutoRunRestartResume]';
export const AUTO_RUN_RESTART_RESUME_FILE = 'autorun-restart-resume.json';
const QUEUE_KEY = 'entries';

export interface AutoRunRestartResumeStore {
	save(entries: AutoRunRestartEntry[]): Promise<number>;
	take(): Promise<AutoRunRestartEntry[]>;
}

export function createAutoRunRestartResumeStore(userDataDir: string): AutoRunRestartResumeStore {
	const filePath = path.join(userDataDir, AUTO_RUN_RESTART_RESUME_FILE);
	const queue = createKeyedWriteQueue();

	async function read(): Promise<AutoRunRestartEntry[]> {
		let text: string;
		try {
			text = await fs.readFile(filePath, 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw err;
		}
		try {
			return parseRestartEntries(JSON.parse(text));
		} catch {
			// A torn or hand-edited file holds nothing we can safely run.
			logger.warn('Discarding unreadable Auto Run restart file', LOG_CONTEXT);
			return [];
		}
	}

	async function remove(): Promise<void> {
		await fs.rm(filePath, { force: true });
	}

	return {
		save: (incoming) =>
			queue.enqueue(QUEUE_KEY, async () => {
				const valid = parseRestartEntries(incoming);
				const merged = mergeRestartEntries(await read(), valid);
				await atomicWriteJson(filePath, merged);
				logger.info(`Saved ${valid.length} Auto Run(s) to resume after restart`, LOG_CONTEXT, {
					sessionIds: valid.map((e) => e.sessionId),
				});
				return valid.length;
			}),
		take: () =>
			queue.enqueue(QUEUE_KEY, async () => {
				const entries = await read();
				await remove();
				return entries;
			}),
	};
}

export function registerAutoRunRestartResumeHandlers(userDataDir: string): void {
	const store = createAutoRunRestartResumeStore(userDataDir);
	ipcMain.handle('autorun:saveRestartResume', (_event, entries: AutoRunRestartEntry[]) =>
		store.save(entries)
	);
	ipcMain.handle('autorun:takeRestartResume', () => store.take());
}
