/**
 * The restart record of durable SSH turns ("Keep turns running when the
 * connection drops"): which turns were still running on their remote when
 * this app quit, so the next launch picks each one up again.
 *
 * A record is written when a durable turn starts and removed when it
 * settles. At quit the turn is detached, not stopped: its remote agent keeps
 * working, and the record is written once more with the offsets the tab has
 * received. The next launch reads the file once and reattaches every turn it
 * names (see `ChildProcessSpawner.reattachRecordedDurableTurns()`).
 *
 * Writes are synchronous: the file is small, changes at a turn's start and
 * settle and at most every few seconds between, and the write at quit must
 * land before the process exits.
 *
 * What a record holds is what a reattach needs and nothing secret: the ssh
 * binary and its connection arguments (the agent's command and env travel on
 * stdin, never in argv), the remote turn dir and pid file, the offsets, and
 * the tab's identity. While a turn runs, its offsets are rewritten every few
 * seconds ({@link keepDurableOffsetsCurrent}), so after a crash (no quit) the
 * reattach repeats at most those last seconds of output, which the tab's log
 * merge already holds; it never replays the turn from its start.
 */

import { readFileSync, unlinkSync } from 'fs';
import path from 'path';

import { captureException } from '../utils/sentry';
import { getAppUserDataDir } from '../utils/app-user-data';
import { atomicWriteJsonSync } from '../utils/atomic-json-store';
import { logger } from '../utils/logger';
import type { DurableTurnOffsets } from '../../shared/maestro-lib/control/ssh-durable-turn';
import type { ManagedProcess } from './types';

/** Records older than this are dropped unread: no remote keeps a turn that long. */
const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DurableTurnRecord extends DurableTurnOffsets {
	/** The process key, `{agentId}-ai-{tabId}`. */
	sessionId: string;
	toolType: string;
	cwd: string;
	/** The local ssh binary and its connection arguments. */
	sshCommand: string;
	sshArgs: string[];
	/** The remote turn dir and pid file the launch named. */
	dir: string;
	pidFile: string;
	isStreamJsonMode: boolean;
	isBatchMode: boolean;
	tabId?: string;
	projectPath?: string;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	agentSessionId?: string;
	contextWindow?: number;
	querySource?: ManagedProcess['querySource'];
	/** When the turn started. */
	startTime: number;
}

const FILE_NAME = 'durable-ssh-turns.json';

let records: Map<string, DurableTurnRecord> | null = null;

function filePath(): string {
	return path.join(getAppUserDataDir(), FILE_NAME);
}

function isRecord(value: unknown): value is DurableTurnRecord {
	if (!value || typeof value !== 'object') return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.sessionId === 'string' &&
		typeof r.toolType === 'string' &&
		typeof r.cwd === 'string' &&
		typeof r.sshCommand === 'string' &&
		Array.isArray(r.sshArgs) &&
		r.sshArgs.every((arg) => typeof arg === 'string') &&
		typeof r.dir === 'string' &&
		typeof r.pidFile === 'string' &&
		Number.isSafeInteger(r.outOffset) &&
		(r.outOffset as number) >= 0 &&
		Number.isSafeInteger(r.errOffset) &&
		(r.errOffset as number) >= 0 &&
		typeof r.isStreamJsonMode === 'boolean' &&
		typeof r.isBatchMode === 'boolean' &&
		typeof r.startTime === 'number'
	);
}

function load(): Map<string, DurableTurnRecord> {
	if (records) return records;
	records = new Map();
	let text: string;
	try {
		text = readFileSync(filePath(), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') void captureException(error);
		return records;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		const list = Array.isArray(parsed) ? parsed : [];
		const now = Date.now();
		for (const entry of list) {
			if (isRecord(entry) && now - entry.startTime < RECORD_MAX_AGE_MS)
				records.set(entry.sessionId, entry);
		}
	} catch (error) {
		// A torn file names no turn this launch can trust; the remote's own
		// sweep removes the dirs a lost record leaves behind.
		logger.warn('Durable SSH turn records are not JSON; starting empty', 'ProcessManager', {
			error: String(error),
		});
	}
	return records;
}

function persist(): void {
	const all = [...load().values()];
	try {
		if (all.length === 0) {
			try {
				unlinkSync(filePath());
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		} else {
			atomicWriteJsonSync(filePath(), all);
		}
	} catch (error) {
		// The turn itself is unaffected; only a restart would not find it.
		void captureException(error);
		logger.error('Could not write the durable SSH turn records', 'ProcessManager', {
			error: String(error),
		});
	}
}

/** Record a durable turn (at its start, and again at a detach). */
export function noteDurableTurn(record: DurableTurnRecord): void {
	load().set(record.sessionId, record);
	persist();
}

/** The turn settled: nothing is left to pick up. */
export function forgetDurableTurn(sessionId: string, dir: string): void {
	const map = load();
	// A newer turn on the same tab owns the record once it started.
	if (map.get(sessionId)?.dir !== dir) return;
	map.delete(sessionId);
	persist();
}

/** Every turn recorded by an earlier run of this app, read once at launch. */
export function recordedDurableTurns(): DurableTurnRecord[] {
	return [...load().values()];
}

/** For tests: forget the in-memory copy so the next call reads the file. */
export function __resetDurableTurnRecordsForTests(): void {
	records = null;
}

/** How often a running durable turn's offsets are written to its record. */
export const DURABLE_OFFSETS_PERSIST_MS = 5_000;

/**
 * Rewrite a running durable turn's record with its offsets every
 * {@link DURABLE_OFFSETS_PERSIST_MS} while they move, until the turn settles
 * or is detached. `write` gets the offsets; `isDetached` stops it at quit,
 * where the detach writes the last record itself.
 */
export function keepDurableOffsetsCurrent(
	turn: { done: Promise<unknown>; restartOffsets: () => DurableTurnOffsets },
	from: DurableTurnOffsets,
	write: (offsets: DurableTurnOffsets) => void,
	isDetached: () => boolean
): void {
	let last = `${from.outOffset}:${from.errOffset}`;
	let settled = false;
	const timer = setInterval(() => {
		if (settled || isDetached()) return;
		const offsets = turn.restartOffsets();
		const key = `${offsets.outOffset}:${offsets.errOffset}`;
		if (key === last) return;
		last = key;
		write(offsets);
	}, DURABLE_OFFSETS_PERSIST_MS);
	timer.unref?.();
	const stop = () => {
		settled = true;
		clearInterval(timer);
	};
	turn.done.then(stop, stop);
}
