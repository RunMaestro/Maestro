/**
 * Computer History - retention and deletion.
 *
 * D10: keep `retentionDays` (default 90) and at most `maxBytes` (default
 * 25 GB). Whichever limit bites first deletes the OLDEST segments first. The
 * open segment is never deleted by retention. Digests follow their segment.
 *
 * Runs at service start and hourly. Also hosts `deleteSegments()`, the
 * deletion primitive `clear` uses, so both prune `index.jsonl` the same way:
 * a rewrite under the shared `index` queue key (see segment-writer.ts), so a
 * segment closing mid-prune never loses its index line.
 */

import * as fs from 'fs/promises';
import {
	DIGESTS_DIR,
	INDEX_FILE,
	SEGMENTS_DIR,
	SEGMENT_MS,
	digestRelativePath,
	parseSegmentRelativePath,
	resolveStorePath,
} from '../../shared/computer-history/paths';
import {
	listDayFolders,
	listSegmentFilesIn,
	parseIndexText,
} from '../../shared/computer-history/reader';
import { atomicWriteFile, type KeyedWriteQueue } from '../utils/atomic-json-store';
import { INDEX_QUEUE_KEY, STORE_FILE_MODE } from './segment-writer';

const DAY_MS = 86_400_000;

export interface SegmentFileInfo {
	file: string;
	startMs: number;
	bytes: number;
}

export interface RetentionOptions {
	storeDir: string;
	retentionDays: number;
	maxBytes: number;
	nowMs: number;
	queue: KeyedWriteQueue;
	/** The open segment; never deleted. */
	protectFile?: string | null;
}

export interface RetentionResult {
	deletedSegments: number;
	freedBytes: number;
	/** Segment bytes remaining after the pass. */
	totalBytes: number;
}

/** Every segment file with its size, oldest first. */
export async function listSegmentFiles(storeDir: string): Promise<SegmentFileInfo[]> {
	const days = await listDayFolders(storeDir);
	const out: SegmentFileInfo[] = [];
	for (const rel of await listSegmentFilesIn(storeDir, days)) {
		const startMs = parseSegmentRelativePath(rel);
		if (startMs === null) continue;
		try {
			const st = await fs.stat(resolveStorePath(storeDir, rel));
			out.push({ file: rel, startMs, bytes: st.size });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
	}
	return out.sort((a, b) => a.startMs - b.startMs);
}

async function unlinkIfExists(abs: string): Promise<void> {
	try {
		await fs.unlink(abs);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
	}
}

/** Remove now-empty day folders under segments/ and digests/. */
async function removeEmptyDayFolders(storeDir: string): Promise<void> {
	for (const top of [SEGMENTS_DIR, DIGESTS_DIR]) {
		const topAbs = resolveStorePath(storeDir, top);
		let names: string[];
		try {
			names = await fs.readdir(topAbs);
		} catch {
			continue;
		}
		for (const name of names) {
			const dir = resolveStorePath(storeDir, `${top}/${name}`);
			try {
				if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
			} catch {
				// Not a directory, or raced with a writer creating a file: leave it.
			}
		}
	}
}

/**
 * Delete segment files (and their digests) and drop their index lines.
 * Returns the bytes freed.
 */
export async function deleteSegments(
	storeDir: string,
	files: readonly SegmentFileInfo[],
	queue: KeyedWriteQueue
): Promise<number> {
	if (files.length === 0) return 0;
	let freed = 0;
	const deleted = new Set<string>();
	for (const f of files) {
		await unlinkIfExists(resolveStorePath(storeDir, f.file));
		await unlinkIfExists(resolveStorePath(storeDir, digestRelativePath(f.startMs)));
		freed += f.bytes;
		deleted.add(f.file);
	}
	await queue.enqueue(INDEX_QUEUE_KEY, async () => {
		const indexAbs = resolveStorePath(storeDir, INDEX_FILE);
		let text: string;
		try {
			text = await fs.readFile(indexAbs, 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw err;
		}
		// Rewriting also compacts: torn lines and superseded duplicates go.
		const kept = parseIndexText(text).filter((e) => !deleted.has(e.file));
		await atomicWriteFile(
			indexAbs,
			kept.length > 0 ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '',
			{ mode: STORE_FILE_MODE }
		);
	});
	await removeEmptyDayFolders(storeDir);
	return freed;
}

/** Delete digests whose window is older than the cutoff (their segment may be gone). */
async function pruneOldDigests(storeDir: string, cutoffMs: number): Promise<void> {
	const top = resolveStorePath(storeDir, DIGESTS_DIR);
	let days: string[];
	try {
		days = await fs.readdir(top);
	} catch {
		return;
	}
	for (const day of days) {
		const dayStart = Date.parse(`${day}T00:00:00.000Z`);
		if (Number.isNaN(dayStart) || dayStart + DAY_MS > cutoffMs) continue;
		await fs.rm(resolveStorePath(storeDir, `${DIGESTS_DIR}/${day}`), {
			recursive: true,
			force: true,
		});
	}
}

/** Apply the day and byte limits. Oldest first; the open segment is kept. */
export async function runRetention(options: RetentionOptions): Promise<RetentionResult> {
	const all = await listSegmentFiles(options.storeDir);
	const cutoffMs = options.nowMs - options.retentionDays * DAY_MS;
	const doomed: SegmentFileInfo[] = [];
	const survivors: SegmentFileInfo[] = [];
	for (const f of all) {
		const expired = f.startMs + SEGMENT_MS <= cutoffMs;
		if (expired && f.file !== options.protectFile) doomed.push(f);
		else survivors.push(f);
	}
	let total = survivors.reduce((sum, f) => sum + f.bytes, 0);
	for (const f of survivors) {
		if (total <= options.maxBytes) break;
		if (f.file === options.protectFile) continue;
		doomed.push(f);
		total -= f.bytes;
	}
	const freedBytes = await deleteSegments(options.storeDir, doomed, options.queue);
	await pruneOldDigests(options.storeDir, cutoffMs);
	return { deletedSegments: doomed.length, freedBytes, totalBytes: total };
}
