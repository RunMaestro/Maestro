/**
 * Pianola decision-log file helpers - NODE ONLY (imports `fs`).
 *
 * Intentionally NOT imported by the renderer: only the CLI store and the
 * main-process store use it, so it never enters the renderer bundle. It exists to
 * keep the concurrency-sensitive append + compaction glue in ONE place instead of
 * duplicated across the two stores.
 *
 * Production writes use the canonical fs-store decision mutation lock for
 * compare, append and compaction together. The standalone compactor acquires
 * that same lock; callers already holding it must pass mutationLockHeld.
 * No network or model work is performed while holding the lock.
 */

import * as fs from 'fs';
import { trimJsonlToFit, PIANOLA_DECISION_RECORD_MAX_BYTES } from './storage';

/** Conservative lower bound on a serialized decision-record line (the id, two
 * timestamps, and the classification + decision objects are always larger). Lets
 * the record-cap gate skip the line count when the file is too small to possibly
 * exceed maxRecords, keeping the hot append path read-free for small logs. */
const MIN_DECISION_RECORD_BYTES = 50;
/**
 * Append one already-newline-terminated JSONL line to the log. A single record
 * over PIANOLA_DECISION_RECORD_MAX_BYTES is DROPPED (not appended): most fields
 * are bounded upstream, but `decision.answer` and a dispatch `error` are not, so
 * this guarantees one hostile/oversized record can never blow the file byte
 * budget on its own. The dropped record is a pathological outlier - a legitimate
 * decision serializes to a few hundred bytes, far under the cap.
 */
export function appendDecisionLine(filePath: string, line: string): void {
	if (Buffer.byteLength(line, 'utf-8') > PIANOLA_DECISION_RECORD_MAX_BYTES) return;
	fs.appendFileSync(filePath, line, 'utf-8');
}

/** Take the compaction lock. Returns a unique owner token on success (passed back
 * to releaseLock), or null when another process holds it. */
function acquireLock(lockPath: string): string | null {
	const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
	try {
		// `wx` fails if the lock already exists - that is the mutual exclusion.
		fs.writeFileSync(lockPath, token, { flag: 'wx' });
		return token;
	} catch (error) {
		// Standalone compaction is best effort. Only the canonical store's lock
		// acquisition reclaims dead owners; a slow live mutation is never stolen.
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
		throw error;
	}
}

/** Release a lock we own. Verifies the owner token first so we never delete a lock
 * a different process reclaimed after ours went stale. */
function releaseLock(lockPath: string, token: string): void {
	try {
		if (fs.readFileSync(lockPath, 'utf-8') === token) {
			fs.rmSync(lockPath, { force: true });
		}
	} catch {
		// Missing/unreadable: nothing to release.
	}
}

function removeTemp(tmpPath: string): void {
	try {
		fs.rmSync(tmpPath, { force: true });
	} catch {
		// Best-effort.
	}
}

/** Count non-empty JSONL lines (records) in `content`. */
function countRecords(content: string): number {
	let count = 0;
	let start = 0;
	for (let i = 0; i < content.length; i += 1) {
		if (content.charCodeAt(i) === 10 /* \n */) {
			if (content.slice(start, i).trim().length > 0) count += 1;
			start = i + 1;
		}
	}
	if (content.slice(start).trim().length > 0) count += 1;
	return count;
}

/**
 * Compact `filePath` to at most `maxRecords` recent lines AND under `maxBytes`.
 *
 * Trigger gates honor BOTH caps. The byte cap is a pure stat. The record cap needs
 * a line count, but a record line is always >= MIN_DECISION_RECORD_BYTES, so below
 * `maxRecords * MIN_DECISION_RECORD_BYTES` the count cannot exceed the cap and we
 * skip the read - keeping the hot append path read-free for small logs.
 *
 * Safe under concurrent appenders (see module doc): re-read + fold delta + re-trim,
 * then rename ONLY when the live file still exactly equals what we merged. Best-
 * effort: on any error or an unreconcilable concurrent change the log is left as-is
 * rather than risking dropped records.
 */
export function compactDecisionLog(
	filePath: string,
	maxRecords: number,
	maxBytes: number,
	mutationLockHeld = false
): void {
	let size: number;
	try {
		size = fs.statSync(filePath).size;
	} catch {
		return;
	}

	// Gate on BOTH caps. Byte cap: pure stat. Record cap: only read+count in the
	// band where the count could exceed maxRecords; below that neither cap can be
	// exceeded, so skip cheaply and keep the append path read-free.
	if (size <= maxBytes) {
		if (size < maxRecords * MIN_DECISION_RECORD_BYTES) return;
		let probe: string;
		try {
			probe = fs.readFileSync(filePath, 'utf-8');
		} catch {
			return;
		}
		if (countRecords(probe) <= maxRecords) return;
	}

	const lockPath = `${filePath}.lock`;
	const lockToken = mutationLockHeld ? undefined : acquireLock(lockPath);
	if (lockToken === null) return; // another process is compacting

	const tmpPath = `${filePath}.${process.pid}.tmp`;
	try {
		let content: string;
		try {
			content = fs.readFileSync(filePath, 'utf-8');
		} catch {
			return;
		}
		const trimmed = trimJsonlToFit(content, maxRecords, maxBytes);
		if (trimmed === content) return;

		// Merge-before-rename: re-read the live file. If appenders added lines since
		// our snapshot, fold the delta in and RE-TRIM so the result still honors both
		// caps (a naive append could otherwise leave the renamed file over a cap).
		const fresh = fs.readFileSync(filePath, 'utf-8');
		let finalContent: string;
		if (fresh === content) {
			finalContent = trimmed;
		} else if (fresh.startsWith(content) && fresh.length > content.length) {
			finalContent = trimJsonlToFit(trimmed + fresh.slice(content.length), maxRecords, maxBytes);
		} else {
			// Diverged (another compactor, or a truncation): abort rather than risk
			// dropping records.
			return;
		}

		fs.writeFileSync(tmpPath, finalContent, 'utf-8');

		// Final guard: only replace the live file if it STILL exactly equals what we
		// merged. If another process appended after our `fresh` read, abort and let a
		// later append re-trigger compaction - we never rename over un-merged records.
		let live: string;
		try {
			live = fs.readFileSync(filePath, 'utf-8');
		} catch {
			removeTemp(tmpPath);
			return;
		}
		if (live !== fresh) {
			removeTemp(tmpPath);
			return;
		}

		fs.renameSync(tmpPath, filePath);
	} catch {
		removeTemp(tmpPath);
	} finally {
		if (lockToken !== undefined) releaseLock(lockPath, lockToken);
	}
}
