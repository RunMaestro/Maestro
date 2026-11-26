/**
 * Write-back for a remote file opened on this machine.
 *
 * Open in Default App and Reveal on a file of an SSH (or hosted) agent act on a
 * copy fetched to this machine's temp folder, because the OS apps can only open
 * a local path. Without this service a change saved in that app stays in the
 * copy and never reaches the remote file. Here, each opened copy is watched
 * while Maestro runs, and a saved change goes back to the remote file through
 * the remote write.
 *
 * It never overwrites silently, and it never drops the user's change:
 * - The remote write is conditional: it lands only if the remote file still
 *   holds the bytes this copy was fetched from (or last wrote). Otherwise the
 *   remote is left alone, the user's version is kept beside the copy, and a
 *   toast says where.
 * - A fetch of the same file again (a second Open) does not replace a copy that
 *   holds a change the remote does not have yet: the copy stays, and the
 *   write is tried again.
 */

import { createHash } from 'crypto';
import path from 'path';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { fileTimestampSlug } from '../../shared/formatters';

/** What happened to one saved change, for the user to hear about. */
export type RemoteCopyWriteBackEvent =
	| { kind: 'saved'; remotePath: string; sshRemoteId: string }
	| { kind: 'conflict'; remotePath: string; sshRemoteId: string; keptAt: string }
	| { kind: 'failed'; remotePath: string; sshRemoteId: string; message: string };

/** A watcher on one local file; `close()` stops it. */
export interface RemoteCopyWatcher {
	close(): unknown;
}

export interface RemoteCopyWriteBackDeps {
	/** Watch one local file; call `onChange` when it is written, replaced, or created. */
	watchFile(localPath: string, onChange: () => void): RemoteCopyWatcher;
	/** The copy's bytes; rejects with ENOENT while an app's atomic save has it moved away. */
	readLocal(localPath: string): Promise<Buffer>;
	/** Create a NEW local file (the user's version on a conflict); rejects with EEXIST if it exists. */
	createLocal(localPath: string, bytes: Buffer): Promise<void>;
	/** The remote file's bytes now; rejects when the remote cannot be read. */
	readRemote(remotePath: string, sshRemoteId: string): Promise<Buffer>;
	/**
	 * Write the remote file only if it still holds the bytes hashed `expectedSha256`.
	 * Resolves `changed` (and leaves the remote alone) when it does not; rejects when
	 * the write fails.
	 */
	writeRemote(
		remotePath: string,
		bytes: Buffer,
		sshRemoteId: string,
		expectedSha256: string
	): Promise<'written' | 'changed'>;
	/** Tell the user what happened. */
	notify(event: RemoteCopyWriteBackEvent): void;
	/** Quiet time after the last change before the copy is read (an app may write in steps). */
	debounceMs?: number;
	/** The most copies watched at once; the oldest watch stops first. */
	maxWatched?: number;
	/** Clock for the kept-version name. */
	now?: () => Date;
}

export interface RemoteCopyWriteBack {
	/**
	 * Watch the copy at `localPath` of `remotePath`. A new watch takes the copy's
	 * bytes now as the baseline: call this right after the copy was fetched.
	 */
	watch(input: { localPath: string; remotePath: string; sshRemoteId: string }): Promise<void>;
	/**
	 * Before a fetch replaces the copy at `localPath`: `keep` when the copy holds
	 * a change the remote does not have and that is kept nowhere else (the fetch
	 * must leave it, and the write is tried again), else `fetch`.
	 */
	beforeRefetch(localPath: string): Promise<'fetch' | 'keep'>;
	/** After a fetch put `bytes` (the remote's now) at `localPath`: they are the baseline. */
	noteFetched(localPath: string, bytes: Buffer): Promise<void>;
	/** Resolves once every change seen so far has been handled. */
	idle(): Promise<void>;
	/** Stop every watch. */
	dispose(): void;
}

interface WatchedCopy {
	localPath: string;
	remotePath: string;
	sshRemoteId: string;
	/** Hash of the bytes the remote file held when this copy last matched it. */
	baseline: string;
	/** Hash of the copy's bytes last kept beside it after a conflict (safe to replace). */
	kept: string | null;
	watcher: RemoteCopyWatcher;
	timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_MAX_WATCHED = 64;
/** How many kept-version names are tried before giving up. */
const MAX_KEPT_NAME_ATTEMPTS = 100;

function hashOf(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function codeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * `report.pdf` -> `report (your version 20261126-101500).pdf`, beside the copy;
 * `attempt` 2 and up add a number, so two conflicts in one second keep both.
 */
export function keptVersionPath(localPath: string, when: Date, attempt = 1): string {
	const ext = path.extname(localPath);
	const stem = path.basename(localPath, ext);
	const suffix = attempt > 1 ? ` ${attempt}` : '';
	return path.join(
		path.dirname(localPath),
		`${stem} (your version ${fileTimestampSlug(when)}${suffix})${ext}`
	);
}

export function createRemoteCopyWriteBack(deps: RemoteCopyWriteBackDeps): RemoteCopyWriteBack {
	const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const maxWatched = deps.maxWatched ?? DEFAULT_MAX_WATCHED;
	const now = deps.now ?? (() => new Date());
	/** Local copy path -> its watch. Insertion order is age, for eviction. */
	const watched = new Map<string, WatchedCopy>();
	/** One step at a time per copy, so a save, a refetch, and a watch never interleave. */
	const queue = createKeyedWriteQueue();
	const pending = new Set<Promise<void>>();

	function stop(entry: WatchedCopy): void {
		if (entry.timer) clearTimeout(entry.timer);
		entry.watcher.close();
		watched.delete(entry.localPath);
	}

	/** Keep the user's version under a name no earlier version holds. */
	async function keepVersion(localPath: string, bytes: Buffer): Promise<string> {
		const when = now();
		for (let attempt = 1; attempt <= MAX_KEPT_NAME_ATTEMPTS; attempt++) {
			const keptAt = keptVersionPath(localPath, when, attempt);
			try {
				await deps.createLocal(keptAt, bytes);
				return keptAt;
			} catch (error) {
				if (codeOf(error) !== 'EEXIST') throw error;
			}
		}
		throw new Error(`No free name to keep your version beside ${localPath}`);
	}

	/** The copy's bytes, or null while an app's atomic save has it moved away. */
	async function readCopy(localPath: string): Promise<Buffer | null> {
		try {
			return await deps.readLocal(localPath);
		} catch (error) {
			if (codeOf(error) === 'ENOENT') return null;
			throw error;
		}
	}

	async function sync(entry: WatchedCopy): Promise<void> {
		const { localPath, remotePath, sshRemoteId } = entry;
		try {
			const local = await readCopy(localPath);
			// The next change event reads it once the save has put it back.
			if (!local) return;
			const localHash = hashOf(local);
			if (localHash === entry.baseline || localHash === entry.kept) return;
			// The copy holds what the remote holds (a fresh fetch replaced it): nothing to send.
			if (hashOf(await deps.readRemote(remotePath, sshRemoteId)) === localHash) {
				entry.baseline = localHash;
				return;
			}
			const outcome = await deps.writeRemote(remotePath, local, sshRemoteId, entry.baseline);
			if (outcome === 'written') {
				entry.baseline = localHash;
				entry.kept = null;
				deps.notify({ kind: 'saved', remotePath, sshRemoteId });
				return;
			}
			const keptAt = await keepVersion(localPath, local);
			entry.kept = localHash;
			deps.notify({ kind: 'conflict', remotePath, sshRemoteId, keptAt });
		} catch (error) {
			deps.notify({ kind: 'failed', remotePath, sshRemoteId, message: messageOf(error) });
		}
	}

	function runSync(entry: WatchedCopy): void {
		// A watch that stopped (evicted, disposed) while waiting sends nothing.
		if (watched.get(entry.localPath) !== entry) return;
		const run = queue.enqueue(entry.localPath, () => sync(entry));
		pending.add(run);
		void run.finally(() => pending.delete(run));
	}

	function schedule(entry: WatchedCopy): void {
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			entry.timer = null;
			runSync(entry);
		}, debounceMs);
	}

	return {
		async watch({ localPath, remotePath, sshRemoteId }) {
			await queue.enqueue(localPath, async () => {
				const existing = watched.get(localPath);
				if (existing) {
					// The baseline is already right: a refetch set it, or kept the copy's change.
					existing.remotePath = remotePath;
					existing.sshRemoteId = sshRemoteId;
					return;
				}
				const entry: WatchedCopy = {
					localPath,
					remotePath,
					sshRemoteId,
					baseline: hashOf(await deps.readLocal(localPath)),
					kept: null,
					watcher: { close: () => undefined },
					timer: null,
				};
				entry.watcher = deps.watchFile(localPath, () => schedule(entry));
				watched.set(localPath, entry);
				while (watched.size > maxWatched) {
					stop(watched.values().next().value as WatchedCopy);
				}
			});
		},
		async beforeRefetch(localPath) {
			const entry = watched.get(localPath);
			if (!entry) return 'fetch';
			const verdict = await queue.enqueue(localPath, async () => {
				const local = await readCopy(localPath);
				if (!local) return 'fetch' as const;
				const localHash = hashOf(local);
				return localHash === entry.baseline || localHash === entry.kept
					? ('fetch' as const)
					: ('keep' as const);
			});
			if (verdict === 'keep') {
				// A save still waiting, or one that failed: send it now instead.
				if (entry.timer) clearTimeout(entry.timer);
				entry.timer = null;
				runSync(entry);
			}
			return verdict;
		},
		async noteFetched(localPath, bytes) {
			const entry = watched.get(localPath);
			if (!entry) return;
			await queue.enqueue(localPath, async () => {
				entry.baseline = hashOf(bytes);
				entry.kept = null;
			});
		},
		async idle() {
			while (pending.size > 0) await Promise.all([...pending]);
		},
		dispose() {
			for (const entry of [...watched.values()]) stop(entry);
		},
	};
}
