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
 * It never overwrites silently. Before each write the remote file is read
 * again: when it no longer holds the bytes this copy was fetched from (or last
 * wrote), someone else changed it, so the write is refused, the user's version
 * is kept beside the copy, and a toast says where.
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
	/** Put bytes at a local path (the user's version on a conflict). */
	writeLocal(localPath: string, bytes: Buffer): Promise<void>;
	/** The remote file's bytes now; rejects when the remote cannot be read. */
	readRemote(remotePath: string, sshRemoteId: string): Promise<Buffer>;
	/** Write the remote file; rejects when the write fails. */
	writeRemote(remotePath: string, bytes: Buffer, sshRemoteId: string): Promise<void>;
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
	 * Watch the copy at `localPath` of `remotePath`. The copy's bytes now are the
	 * baseline: call this right after the copy was fetched. Watching a copy again
	 * (a second open) takes the new bytes as the baseline.
	 */
	watch(input: { localPath: string; remotePath: string; sshRemoteId: string }): Promise<void>;
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
	watcher: RemoteCopyWatcher;
	timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_MAX_WATCHED = 64;

function hashOf(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `report.pdf` -> `report (your version 20261126-101500).pdf`, beside the copy. */
export function keptVersionPath(localPath: string, when: Date): string {
	const ext = path.extname(localPath);
	const stem = path.basename(localPath, ext);
	return path.join(
		path.dirname(localPath),
		`${stem} (your version ${fileTimestampSlug(when)})${ext}`
	);
}

export function createRemoteCopyWriteBack(deps: RemoteCopyWriteBackDeps): RemoteCopyWriteBack {
	const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const maxWatched = deps.maxWatched ?? DEFAULT_MAX_WATCHED;
	const now = deps.now ?? (() => new Date());
	/** Local copy path -> its watch. Insertion order is age, for eviction. */
	const watched = new Map<string, WatchedCopy>();
	/** One sync at a time per copy, so two saves never race each other's remote check. */
	const queue = createKeyedWriteQueue();
	const pending = new Set<Promise<void>>();

	function stop(entry: WatchedCopy): void {
		if (entry.timer) clearTimeout(entry.timer);
		entry.watcher.close();
		watched.delete(entry.localPath);
	}

	async function sync(entry: WatchedCopy): Promise<void> {
		const { localPath, remotePath, sshRemoteId } = entry;
		let local: Buffer;
		try {
			local = await deps.readLocal(localPath);
		} catch (error) {
			// An app saving by rename moves the file away for a moment; the next event reads it.
			if (isMissing(error)) return;
			deps.notify({ kind: 'failed', remotePath, sshRemoteId, message: messageOf(error) });
			return;
		}
		const localHash = hashOf(local);
		if (localHash === entry.baseline) return;
		try {
			const remoteHash = hashOf(await deps.readRemote(remotePath, sshRemoteId));
			// The copy holds what the remote holds (a fresh fetch replaced it): nothing to send.
			if (remoteHash === localHash) {
				entry.baseline = localHash;
				return;
			}
			if (remoteHash !== entry.baseline) {
				const keptAt = keptVersionPath(localPath, now());
				await deps.writeLocal(keptAt, local);
				deps.notify({ kind: 'conflict', remotePath, sshRemoteId, keptAt });
				return;
			}
			await deps.writeRemote(remotePath, local, sshRemoteId);
			entry.baseline = localHash;
			deps.notify({ kind: 'saved', remotePath, sshRemoteId });
		} catch (error) {
			deps.notify({ kind: 'failed', remotePath, sshRemoteId, message: messageOf(error) });
		}
	}

	function schedule(entry: WatchedCopy): void {
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			entry.timer = null;
			// A watch that stopped (evicted, disposed) while waiting sends nothing.
			if (watched.get(entry.localPath) !== entry) return;
			const run = queue.enqueue(entry.localPath, () => sync(entry));
			pending.add(run);
			void run.finally(() => pending.delete(run));
		}, debounceMs);
	}

	return {
		async watch({ localPath, remotePath, sshRemoteId }) {
			const baseline = hashOf(await deps.readLocal(localPath));
			const existing = watched.get(localPath);
			if (existing) {
				// Wait for a save already being sent, so its result does not replace this baseline.
				await queue.enqueue(localPath, async () => {
					existing.baseline = baseline;
					existing.remotePath = remotePath;
					existing.sshRemoteId = sshRemoteId;
				});
				return;
			}
			const entry: WatchedCopy = {
				localPath,
				remotePath,
				sshRemoteId,
				baseline,
				watcher: { close: () => undefined },
				timer: null,
			};
			entry.watcher = deps.watchFile(localPath, () => schedule(entry));
			watched.set(localPath, entry);
			while (watched.size > maxWatched) {
				const oldest = watched.values().next().value as WatchedCopy;
				stop(oldest);
			}
		},
		async idle() {
			while (pending.size > 0) await Promise.all([...pending]);
		},
		dispose() {
			for (const entry of [...watched.values()]) stop(entry);
		},
	};
}
