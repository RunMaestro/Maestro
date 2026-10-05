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
 */

import * as fsp from 'fs/promises';
import * as path from 'path';

import {
	HISTORY_JSONL_EXT,
	HISTORY_LEGACY_JSON_EXT,
	sanitizeSessionId,
	serializeHistoryEntryLine,
} from '../../history';
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import type { HistoryEntry } from '../../types';
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

export interface HistoryWriterOptions {
	paths: Pick<MaestroPaths, 'historyDir'>;
	/** Is this process still the data directory's writer? Asked before every append. Default: always. */
	fence?: () => DataDirVerdict;
}

export interface HistoryWriter {
	/** Append one entry to `agentId`'s history. Appends to one agent are written in call order. */
	append(agentId: string, entry: HistoryEntry): Promise<HistoryAppendResult>;
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

export function createHistoryWriter(options: HistoryWriterOptions): HistoryWriter {
	const queue = createKeyedWriteQueue();

	async function appendNow(agentId: string, entry: HistoryEntry): Promise<HistoryAppendResult> {
		const verdict = options.fence?.();
		if (verdict && !verdict.ok) return { ok: false, reason: 'fenced', message: verdict.reason };

		const safeId = sanitizeSessionId(agentId);
		const file = path.join(options.paths.historyDir, `${safeId}${HISTORY_JSONL_EXT}`);
		const legacy = path.join(options.paths.historyDir, `${safeId}${HISTORY_LEGACY_JSON_EXT}`);
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
		append: (agentId, entry) => queue.enqueue(agentId, () => appendNow(agentId, entry)),
	};
}
