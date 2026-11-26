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
 *   toast says where. From then on the copy no longer saves back (every later
 *   save would conflict again); the toast says so once, and opening the file
 *   again starts over from the remote's bytes.
 * - A fetch of the same file again (a second Open) runs in the copy's own
 *   queue, after any save not sent yet, and never replaces a copy that holds a
 *   change the remote does not have: the copy stays, and the write is tried
 *   again.
 */

import { createHash } from 'crypto';
import path from 'path';
import { createKeyedWriteQueue } from '../../shared/keyedWriteQueue';
import { fileTimestampSlug, formatSize } from '../../shared/formatters';

/**
 * The largest copy written back to its remote file. Each save sends the whole
 * file over SSH (as base64 on stdin), so a bigger copy is refused, with a
 * message, instead of tying up the connection.
 */
export const REMOTE_COPY_WRITE_BACK_MAX_BYTES = 32 * 1024 * 1024;

/** Why a copy does not save back: it is bigger than the write-back sends. */
export function remoteCopyTooLargeMessage(maxBytes = REMOTE_COPY_WRITE_BACK_MAX_BYTES): string {
	return `The file is too large to save back to the remote host (over ${formatSize(maxBytes)})`;
}

/** `watch()` refuses a copy bigger than the write-back sends; nothing watches it. */
export class RemoteCopyTooLargeError extends Error {
	constructor(maxBytes = REMOTE_COPY_WRITE_BACK_MAX_BYTES) {
		super(remoteCopyTooLargeMessage(maxBytes));
		this.name = 'RemoteCopyTooLargeError';
	}
}

/** What happened to one saved change, for the user to hear about. */
export type RemoteCopyWriteBackEvent =
	| { kind: 'saved'; remotePath: string; sshRemoteId: string }
	| { kind: 'conflict'; remotePath: string; sshRemoteId: string; keptAt: string }
	/** A copy that no longer saved back was fetched again; the change it held is kept here. */
	| { kind: 'kept'; remotePath: string; sshRemoteId: string; keptAt: string }
	| { kind: 'failed'; remotePath: string; sshRemoteId: string; message: string }
	/** The copy can no longer be watched (the watcher failed): later saves stay on this machine. */
	| { kind: 'unwatched'; remotePath: string; sshRemoteId: string };

/** A watcher on one local file; `close()` stops it. */
export interface RemoteCopyWatcher {
	close(): unknown;
}

export interface RemoteCopyWriteBackDeps {
	/**
	 * Watch one local file; call `onChange` when it is written, replaced, or
	 * created, and `onError` when the watch fails and will report no more.
	 */
	watchFile(
		localPath: string,
		onChange: () => void,
		onError: (error: unknown) => void
	): RemoteCopyWatcher;
	/**
	 * The copy's size and modification time, or null while it is moved away.
	 * Polled for every watched copy, so a save is seen even when the OS file
	 * events never arrive.
	 */
	statLocal(localPath: string): Promise<{ size: number; mtimeMs: number } | null>;
	/** The copy's bytes; rejects with ENOENT while an app's atomic save has it moved away. */
	readLocal(localPath: string): Promise<Buffer>;
	/** Create a NEW local file (the user's version on a conflict); rejects with EEXIST if it exists. */
	createLocal(localPath: string, bytes: Buffer): Promise<void>;
	/**
	 * The SHA-256 (hex) of the remote file now, taken on the remote (its bytes
	 * never cross); `null` when it is gone. Rejects when the remote cannot be read.
	 */
	hashRemote(remotePath: string, sshRemoteId: string): Promise<string | null>;
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
	/** How often each watched copy's size and modification time are compared (no file events needed). */
	pollMs?: number;
	/** The most copies watched at once; the oldest watch stops first. */
	maxWatched?: number;
	/** The largest copy written back (default {@link REMOTE_COPY_WRITE_BACK_MAX_BYTES}). */
	maxBytes?: number;
	/** Clock for the kept-version name. */
	now?: () => Date;
}

export interface RemoteCopyWriteBack {
	/**
	 * Watch the copy at `localPath` of `remotePath`. A new watch takes the copy's
	 * bytes now as the baseline: call this right after the copy was fetched.
	 * Rejects with {@link RemoteCopyTooLargeError} for a copy bigger than the
	 * write-back sends.
	 */
	watch(input: { localPath: string; remotePath: string; sshRemoteId: string }): Promise<void>;
	/**
	 * Fetch the remote file again into the copy at `localPath` (a second Open),
	 * as one step of the copy's own queue, so no save of it interleaves:
	 * 1. A save not sent yet is sent first.
	 * 2. A change the remote still does not have (the write failed) keeps the
	 *    copy: resolves `kept`, and no bytes are fetched. On a copy that no
	 *    longer saves back, that change is kept beside it instead, and the fetch
	 *    goes on.
	 * 3. `download()` gets the remote's bytes; `place()` puts them at the copy,
	 *    and they are the new baseline. A save the app made while they were
	 *    coming keeps the copy instead (and goes to the remote): `kept`.
	 */
	refetch(
		localPath: string,
		io: { download(): Promise<Buffer>; place(bytes: Buffer): Promise<void> }
	): Promise<'fetched' | 'kept'>;
	/** Resolves once every change seen so far has been handled. */
	idle(): Promise<void>;
	/**
	 * Stop every watch. Each copy's change not sent yet (one waiting out the
	 * debounce, or one no event reported) is sent first; resolves when those are
	 * done. The app's quit waits on it, for a bounded time.
	 */
	dispose(): Promise<void>;
}

interface WatchedCopy {
	localPath: string;
	remotePath: string;
	sshRemoteId: string;
	/** Hash of the bytes the remote file held when this copy last matched it. */
	baseline: string;
	/** Hash of the copy's bytes last kept beside it after a conflict (safe to replace). */
	kept: string | null;
	/**
	 * Why this copy no longer saves back, once the user was told: the remote
	 * changed under it, it grew past the cap, or its watcher failed. A fresh
	 * fetch clears it.
	 */
	halted: 'conflict' | 'too-large' | 'unwatched' | null;
	watcher: RemoteCopyWatcher;
	/** The watcher failed and was closed; the next `watch()` starts a new one. */
	watcherLost: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	/** Size and modification time at the last poll (or watch), as `size:mtimeMs`. */
	lastStat: string | null;
}

const DEFAULT_DEBOUNCE_MS = 400;
/** Slow on purpose: it only backs up the file events, and costs one stat per watched copy. */
const DEFAULT_POLL_MS = 3000;
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
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const maxWatched = deps.maxWatched ?? DEFAULT_MAX_WATCHED;
	const maxBytes = deps.maxBytes ?? REMOTE_COPY_WRITE_BACK_MAX_BYTES;
	const now = deps.now ?? (() => new Date());
	/** Local copy path -> its watch. Insertion order is age, for eviction. */
	const watched = new Map<string, WatchedCopy>();
	/** One step at a time per copy, so a save, a refetch, and a watch never interleave. */
	const queue = createKeyedWriteQueue();
	const pending = new Set<Promise<void>>();
	/** One interval for every watched copy; runs only while a copy is watched. */
	let poller: ReturnType<typeof setInterval> | null = null;
	let polling = false;

	async function statKey(localPath: string): Promise<string | null> {
		try {
			const stat = await deps.statLocal(localPath);
			return stat ? `${stat.size}:${stat.mtimeMs}` : null;
		} catch {
			// A stat that fails reads as no change; the file events still apply.
			return null;
		}
	}

	/**
	 * The fallback that does not depend on file events (some machines never
	 * deliver them): a copy whose size or modification time moved since the last
	 * look is read as saved.
	 */
	async function poll(): Promise<void> {
		if (polling) return;
		polling = true;
		try {
			for (const entry of [...watched.values()]) {
				// A copy that no longer saves back has nothing to look for.
				if (entry.halted) continue;
				const key = await statKey(entry.localPath);
				if (key === null || key === entry.lastStat) continue;
				entry.lastStat = key;
				if (watched.get(entry.localPath) === entry && !entry.timer) schedule(entry);
			}
		} finally {
			polling = false;
		}
	}

	function updatePoller(): void {
		if (watched.size > 0 && !poller) {
			poller = setInterval(() => void poll(), pollMs);
			// Never what keeps the process alive.
			(poller as { unref?: () => void }).unref?.();
		} else if (watched.size === 0 && poller) {
			clearInterval(poller);
			poller = null;
		}
	}

	/**
	 * Stop one watch (evicted at the cap, or disposed). A save the user made just
	 * before must still reach the remote: the copy is read once more and any
	 * change not sent yet goes now, instead of being dropped with its timer.
	 */
	function stop(entry: WatchedCopy): void {
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = null;
		runSync(entry);
		entry.watcher.close();
		watched.delete(entry.localPath);
		updatePoller();
	}

	/**
	 * The watcher failed: send what the copy holds now, then say once that later
	 * saves stay on this machine. The copy stays known (so a fresh Open keeps an
	 * unsent change beside it, and watches it again).
	 */
	function lose(entry: WatchedCopy): void {
		if (watched.get(entry.localPath) !== entry || entry.watcherLost) return;
		entry.watcherLost = true;
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = null;
		entry.watcher.close();
		track(
			queue.enqueue(entry.localPath, async () => {
				await sync(entry);
				// Already told why it does not save back (a conflict, the cap).
				if (entry.halted) return;
				entry.halted = 'unwatched';
				deps.notify({
					kind: 'unwatched',
					remotePath: entry.remotePath,
					sshRemoteId: entry.sshRemoteId,
				});
			})
		);
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
			// Said once already; a fresh Open starts over from the remote's bytes.
			if (entry.halted) return;
			if (local.length > maxBytes) {
				entry.halted = 'too-large';
				deps.notify({
					kind: 'failed',
					remotePath,
					sshRemoteId,
					message: remoteCopyTooLargeMessage(maxBytes),
				});
				return;
			}
			// The copy holds what the remote holds (a fresh fetch replaced it): nothing to send.
			if ((await deps.hashRemote(remotePath, sshRemoteId)) === localHash) {
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
			entry.halted = 'conflict';
			deps.notify({ kind: 'conflict', remotePath, sshRemoteId, keptAt });
		} catch (error) {
			deps.notify({ kind: 'failed', remotePath, sshRemoteId, message: messageOf(error) });
		}
	}

	function runSync(entry: WatchedCopy): void {
		// A watch that stopped (evicted, disposed) while waiting sends nothing.
		if (watched.get(entry.localPath) !== entry) return;
		track(queue.enqueue(entry.localPath, () => sync(entry)));
	}

	/** Count `run` as work in flight until it settles (for `idle()` and `dispose()`). */
	function track(run: Promise<void>): void {
		pending.add(run);
		void run.finally(() => pending.delete(run));
	}

	async function settle(): Promise<void> {
		while (pending.size > 0) await Promise.all([...pending]);
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
					// The fetch just put a copy too large to send back here.
					if (existing.halted === 'too-large') throw new RemoteCopyTooLargeError(maxBytes);
					if (existing.watcherLost) {
						existing.watcherLost = false;
						existing.watcher = deps.watchFile(
							localPath,
							() => schedule(existing),
							() => lose(existing)
						);
					}
					return;
				}
				const fetched = await deps.readLocal(localPath);
				if (fetched.length > maxBytes) throw new RemoteCopyTooLargeError(maxBytes);
				const entry: WatchedCopy = {
					localPath,
					remotePath,
					sshRemoteId,
					baseline: hashOf(fetched),
					kept: null,
					halted: null,
					watcher: { close: () => undefined },
					watcherLost: false,
					timer: null,
					lastStat: await statKey(localPath),
				};
				entry.watcher = deps.watchFile(
					localPath,
					() => schedule(entry),
					() => lose(entry)
				);
				watched.set(localPath, entry);
				updatePoller();
				while (watched.size > maxWatched) {
					stop(watched.values().next().value as WatchedCopy);
				}
			});
		},
		async refetch(localPath, { download, place }) {
			const outcome = await queue.enqueue(localPath, async () => {
				const entry = watched.get(localPath);
				let checked: string | null = null;
				if (entry) {
					// A save still waiting out its debounce, or one that failed, goes
					// first: the fetch must not land over a change the remote lacks.
					if (entry.timer) clearTimeout(entry.timer);
					entry.timer = null;
					await sync(entry);
					const local = await readCopy(localPath);
					if (local) {
						const localHash = hashOf(local);
						checked = localHash;
						if (localHash !== entry.baseline && localHash !== entry.kept) {
							// Still not on the remote (the write failed): the copy stays,
							// and the next save tries again.
							if (!entry.halted) return 'kept' as const;
							// This copy no longer saves back, and it holds a change kept
							// nowhere else: keep that beside it, say where, and start over.
							const keptAt = await keepVersion(localPath, local);
							entry.kept = localHash;
							deps.notify({
								kind: 'kept',
								remotePath: entry.remotePath,
								sshRemoteId: entry.sshRemoteId,
								keptAt,
							});
						}
					}
				}
				const bytes = await download();
				// The app may have saved the copy while the bytes were coming (this
				// queue orders Maestro's own steps, not the app's): that save stays,
				// and goes to the remote, instead of being replaced.
				if (entry && watched.get(localPath) === entry) {
					const local = await readCopy(localPath);
					if (local && hashOf(local) !== checked) return 'saved-during-fetch' as const;
				}
				await place(bytes);
				if (entry) {
					entry.lastStat = await statKey(localPath);
					entry.baseline = hashOf(bytes);
					entry.kept = null;
					// A fresh copy saves back again, unless it is too large to.
					entry.halted = bytes.length > maxBytes ? 'too-large' : null;
				}
				return 'fetched' as const;
			});
			if (outcome === 'saved-during-fetch') {
				const entry = watched.get(localPath);
				if (entry) runSync(entry);
				return 'kept';
			}
			return outcome;
		},
		idle: settle,
		async dispose() {
			for (const entry of [...watched.values()]) stop(entry);
			await settle();
		},
	};
}
