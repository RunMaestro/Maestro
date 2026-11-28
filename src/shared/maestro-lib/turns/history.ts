/**
 * Appending to an agent's history (`<userData>/history/<agentId>.jsonl`), the way the desktop's
 * `HistoryManager.addEntry` does, so a turn done in the TUI shows up in the History panel.
 *
 * The file format is shared (`src/shared/history.ts`): one JSON object per line, appended
 * with `O_APPEND` and never rewritten. This writer is deliberately narrower than the
 * desktop's manager:
 *
 * - **No rotation.** Trimming a file to the user's `maxLogBuffer` is a read-modify-write of
 *   the whole file. The desktop does it on its own appends, and the next desktop run trims
 *   what the runtime added; a second trimmer is one more way to lose the user's memory.
 * - **No migration.** An agent still on the legacy single-object `<agentId>.json` has no
 *   `.jsonl` yet, and a `.jsonl` created beside it would hide every old entry (the reader
 *   prefers it, and the desktop skips its migration once it exists). The append is refused
 *   with `legacy-format`, the entry is not written, and the desktop migrates the file on its
 *   next run.
 * - **A torn last line is closed first.** An append cut short by a crash leaves a last line
 *   with no newline; appending to it would fuse the new entry onto the damaged one and lose
 *   both. The file's last byte is checked and a newline is written first when it is missing.
 *
 * Never throws: a failure is a result, because history is the memory of a turn that already
 * happened and must not fail it.
 *
 * `remove` and `update` are the History panel's Delete and Validate on a host, the same edits
 * `HistoryManager.deleteEntry` / `updateEntry` make on a desktop. They rewrite the whole file
 * (atomically) on the same per-agent queue as the appends, so an edit never races a turn's entry.
 * A line that does not parse is kept as it is: an edit must not drop what it cannot read.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';

import {
	HISTORY_JSONL_EXT,
	HISTORY_LEGACY_JSON_EXT,
	sanitizeSessionId,
	serializeHistoryEntryLine,
} from '../../history';
import { stripJsonBom } from '../../jsonUtils';
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import type { HistoryEntry } from '../../types';
import type { HistoryEntryUpdates } from '../client/types';
import { atomicWriteFile } from '../store/atomic-write';
import { logger } from '../host';
import type { DataDirVerdict } from '../runtime/data-dir-lock';
import type { MaestroPaths } from '../paths/resolve';

const LOG_CONTEXT = '[HistoryWriter]';

export type HistoryAppendResult =
	| { ok: true; file: string }
	| {
			ok: false;
			/** `legacy-format`: the agent's file is not JSONL yet. `fenced`: another process owns the data dir. `failed`: the write threw. */
			reason: 'legacy-format' | 'fenced' | 'failed';
			message: string;
	  };

export type HistoryEditResult =
	| {
			ok: true;
			/** False: the agent's own History has no entry with that id (nothing was written). */
			changed: boolean;
	  }
	| Extract<HistoryAppendResult, { ok: false }>;

export interface HistoryWriterOptions {
	paths: Pick<MaestroPaths, 'historyDir'>;
	/** Is this process still the data directory's writer? Asked before every append. Default: always. */
	fence?: () => DataDirVerdict;
	/**
	 * Called with each entry once it is in the agent's own History, in append order (a host copies
	 * it to the project's shared History here). A throw is logged; the append still succeeded.
	 */
	onAppended?(agentId: string, entry: HistoryEntry): void;
}

export interface HistoryWriter {
	/** Append one entry to `agentId`'s history. Appends to one agent are written in call order. */
	append(agentId: string, entry: HistoryEntry): Promise<HistoryAppendResult>;
	/** Delete the entry `entryId` from `agentId`'s own History. */
	remove(agentId: string, entryId: string): Promise<HistoryEditResult>;
	/** Change the entry `entryId` in `agentId`'s own History. */
	update(
		agentId: string,
		entryId: string,
		updates: HistoryEntryUpdates
	): Promise<HistoryEditResult>;
	/**
	 * Resolves once every append and edit accepted so far has finished. Shutdown awaits it before
	 * releasing the data-dir lock, so a rewrite still in flight cannot rename over a file the next
	 * owner has appended to.
	 */
	drain(): Promise<void>;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fsp.access(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

/** True when the file is empty or ends in a newline. */
async function endsCleanly(file: string): Promise<boolean> {
	const handle = await fsp.open(file, 'r');
	try {
		const { size } = await handle.stat();
		if (size === 0) return true;
		const last = Buffer.alloc(1);
		await handle.read(last, 0, 1, size - 1);
		return last[0] === 0x0a;
	} finally {
		await handle.close();
	}
}

function isEntryWithId(value: unknown, entryId: string): value is HistoryEntry {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { id?: unknown }).id === entryId
	);
}

export function createHistoryWriter(options: HistoryWriterOptions): HistoryWriter {
	const queue = createKeyedWriteQueue();

	function agentFiles(agentId: string): { file: string; legacy: string } {
		const safeId = sanitizeSessionId(agentId);
		return {
			file: path.join(options.paths.historyDir, `${safeId}${HISTORY_JSONL_EXT}`),
			legacy: path.join(options.paths.historyDir, `${safeId}${HISTORY_LEGACY_JSON_EXT}`),
		};
	}

	/**
	 * Rewrite `agentId`'s file with every entry whose id is `entryId` passed through `edit`
	 * (`null` drops it). Every other line is written back byte for byte.
	 */
	async function rewriteNow(
		agentId: string,
		entryId: string,
		edit: (entry: HistoryEntry) => HistoryEntry | null
	): Promise<HistoryEditResult> {
		const verdict = options.fence?.();
		if (verdict && !verdict.ok) return { ok: false, reason: 'fenced', message: verdict.reason };

		const { file, legacy } = agentFiles(agentId);
		try {
			let raw: string;
			try {
				raw = await fsp.readFile(file, 'utf-8');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				if (await exists(legacy)) {
					return {
						ok: false,
						reason: 'legacy-format',
						message: `${path.basename(legacy)} has not been migrated to JSONL yet; open the desktop once so it can, then entries can be edited.`,
					};
				}
				return { ok: true, changed: false };
			}

			let changed = false;
			const lines: string[] = [];
			for (const line of stripJsonBom(raw).split('\n')) {
				if (!line.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					lines.push(line);
					continue;
				}
				if (!isEntryWithId(parsed, entryId)) {
					lines.push(line);
					continue;
				}
				changed = true;
				const next = edit(parsed);
				if (next) lines.push(serializeHistoryEntryLine(next).trimEnd());
			}
			if (!changed) return { ok: true, changed: false };
			await atomicWriteFile(file, lines.map((line) => `${line}\n`).join(''));
			return { ok: true, changed: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to edit history for agent ${agentId}: ${message}`, LOG_CONTEXT);
			return { ok: false, reason: 'failed', message };
		}
	}

	async function appendNow(agentId: string, entry: HistoryEntry): Promise<HistoryAppendResult> {
		const verdict = options.fence?.();
		if (verdict && !verdict.ok) return { ok: false, reason: 'fenced', message: verdict.reason };

		const { file, legacy } = agentFiles(agentId);
		try {
			await fsp.mkdir(options.paths.historyDir, { recursive: true });
			const hasJsonl = await exists(file);
			if (!hasJsonl && (await exists(legacy))) {
				return {
					ok: false,
					reason: 'legacy-format',
					message: `${path.basename(legacy)} has not been migrated to JSONL yet; open the desktop once so it can, then new entries will be recorded.`,
				};
			}
			const prefix = hasJsonl && !(await endsCleanly(file)) ? '\n' : '';
			// O_APPEND: the kernel seeks to EOF as part of the write, so another process
			// appending at the same moment cannot overwrite these bytes.
			await fsp.appendFile(file, prefix + serializeHistoryEntryLine(entry), 'utf-8');
			return { ok: true, file };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`Failed to write history for agent ${agentId}: ${message}`, LOG_CONTEXT);
			return { ok: false, reason: 'failed', message };
		}
	}

	return {
		append: (agentId, entry) =>
			queue.enqueue(agentId, async () => {
				const result = await appendNow(agentId, entry);
				if (result.ok && options.onAppended) {
					try {
						options.onAppended(agentId, entry);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						logger.warn(`After-append hook failed for agent ${agentId}: ${message}`, LOG_CONTEXT);
					}
				}
				return result;
			}),
		remove: (agentId, entryId) =>
			queue.enqueue(agentId, () => rewriteNow(agentId, entryId, () => null)),
		update: (agentId, entryId, updates) =>
			queue.enqueue(agentId, () =>
				rewriteNow(agentId, entryId, (entry) => ({
					...entry,
					...(updates.validated !== undefined ? { validated: updates.validated } : {}),
				}))
			),
		drain: () => queue.idle(),
	};
}
