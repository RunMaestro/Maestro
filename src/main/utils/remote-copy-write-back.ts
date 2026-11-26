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
 *   again. A copy it has no record of (an earlier run of the app, one forgotten
 *   past the cap, a crash) that differs from the fetched bytes is kept beside
 *   it before they replace it.
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

/**
 * `watch()` refuses a copy that does not save back; the message says why, in
 * words for the user. The copy stays known, so a fresh Open keeps a change made
 * in it beside it instead of replacing it.
 */
export class RemoteCopyNotSavedBackError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'RemoteCopyNotSavedBackError';
	}
}

/** The copy is bigger than the write-back sends; nothing watches it. */
export class RemoteCopyTooLargeError extends RemoteCopyNotSavedBackError {
	constructor(maxBytes = REMOTE_COPY_WRITE_BACK_MAX_BYTES) {
		super(remoteCopyTooLargeMessage(maxBytes));
		this.name = 'RemoteCopyTooLargeError';
	}
}

/** What happened to one saved change, for the user to hear about. */
export type RemoteCopyWriteBackEvent =
	| { kind: 'saved'; remotePath: string; sshRemoteId: string }
	| { kind: 'conflict'; remotePath: string; sshRemoteId: string; keptAt: string }
	/**
	 * A copy that no longer saved back was opened again; the change it held is
	 * kept at `keptAt`. `replaced`: the copy now holds the remote's bytes (false
	 * when the fetch failed, or the app saved the copy again meanwhile).
	 */
	| {
			kind: 'kept';
			remotePath: string;
			sshRemoteId: string;
			keptAt: string;
			replaced: boolean;
	  }
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
	/** The most copies watched at once; the oldest watch stops first (its copy stays known). */
	maxWatched?: number;
	/** The most copies known at all (watched or not); the oldest is forgotten first. */
	maxKnown?: number;
	/** The largest copy written back (default {@link REMOTE_COPY_WRITE_BACK_MAX_BYTES}). */
	maxBytes?: number;
	/** Clock for the kept-version name. */
	now?: () => Date;
}

/** Fetched bytes written beside the copy, not yet in its place. */
export interface StagedCopy {
	/** Put the staged bytes at the copy's path (a rename). */
	commit(): Promise<void>;
	/** Remove the staged bytes; the copy stays as it is. */
	discard(): Promise<void>;
}

export interface RemoteCopyWriteBack {
	/**
	 * Watch the copy at `localPath` of `remotePath`. A new watch takes the copy's
	 * bytes now as the baseline: call this right after the copy was fetched.
	 * Rejects with {@link RemoteCopyNotSavedBackError} (its message says why)
	 * for a copy that does not save back: one bigger than the write-back sends
	 * ({@link RemoteCopyTooLargeError}), or one a refetch could not start over.
	 */
	watch(input: { localPath: string; remotePath: string; sshRemoteId: string }): Promise<void>;
	/**
	 * Fetch the remote file again into the copy at `localPath` of `remotePath` (a
	 * second Open), as one step of the copy's own queue, so no save of it
	 * interleaves:
	 * 1. A save not sent yet is sent first.
	 * 2. A change the remote still does not have (the write failed) keeps the
	 *    copy: resolves `kept`, and no bytes are fetched. On a copy that no
	 *    longer saves back, that change is kept beside it instead, and the fetch
	 *    goes on.
	 * 3. `download()` gets the remote's bytes and `stage()` writes them beside
	 *    the copy. Only then is the copy read one last time: a save the app made
	 *    meanwhile keeps the copy (and goes to the remote), the staged bytes are
	 *    discarded, and it resolves `kept`. Otherwise `commit()` puts them in
	 *    place, and they are the new baseline.
	 *
	 * A copy this service does not know (an earlier run of the app, one forgotten
	 * past {@link RemoteCopyWriteBackDeps.maxKnown}, a crash) has no baseline, so
	 * a change in it cannot be told from bytes the remote held: when the copy is
	 * there and differs from the fetched bytes, it is kept beside the copy before
	 * they replace it, and the user is told where. From then on the copy is known,
	 * over the fetched bytes: a save made before the next `watch()` is sent.
	 */
	refetch(
		copy: { localPath: string; remotePath: string; sshRemoteId: string },
		io: { download(): Promise<Buffer>; stage(bytes: Buffer): Promise<StagedCopy> }
	): Promise<'fetched' | 'kept'>;
	/** Resolves once every change seen so far has been handled. */
	idle(): Promise<void>;
	/**
	 * The copies with a change not on the remote yet: a save waiting out its
	 * debounce, queued, or being sent, and a copy whose last send failed. The
	 * quit path names them when it stops waiting.
	 */
	pendingCopies(): Array<{ remotePath: string; sshRemoteId: string }>;
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
	/** Hash of bytes sent in a write that failed: it may still have landed on the remote. */
	unconfirmed: string | null;
	/**
	 * Why this copy no longer saves back, once the user was told: the remote
	 * changed under it, it grew past the cap, or its watcher failed. A fresh
	 * fetch clears it.
	 */
	halted: 'conflict' | 'too-large' | 'unwatched' | null;
	watcher: RemoteCopyWatcher;
	/** The watcher failed and was closed; the next `watch()` starts a new one. */
	watcherLost: boolean;
	/** Forgotten past `maxKnown`: a send of it that fails is no longer recorded. */
	forgotten: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	/** Size and modification time at the last poll (or watch), as `size:mtimeMs`. */
	lastStat: string | null;
}

const DEFAULT_DEBOUNCE_MS = 400;
/** Slow on purpose: it only backs up the file events, and costs one stat per watched copy. */
const DEFAULT_POLL_MS = 3000;
const DEFAULT_MAX_WATCHED = 64;
/** A known copy costs a few hashes of memory; this only bounds a very long session. */
const DEFAULT_MAX_KNOWN = 1024;
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
	const maxKnown = Math.max(deps.maxKnown ?? DEFAULT_MAX_KNOWN, maxWatched);
	const maxBytes = deps.maxBytes ?? REMOTE_COPY_WRITE_BACK_MAX_BYTES;

	/** Why a halted copy does not save back, for `watch()` to say instead of "saves back". */
	function haltError(halted: NonNullable<WatchedCopy['halted']>): RemoteCopyNotSavedBackError {
		if (halted === 'too-large') return new RemoteCopyTooLargeError(maxBytes);
		return new RemoteCopyNotSavedBackError(
			halted === 'conflict'
				? 'The remote file changed since this copy was made, so the copy does not save back'
				: 'Maestro cannot watch this copy, so it does not save back'
		);
	}
	const now = deps.now ?? (() => new Date());
	/** Local copy path -> its watch. Insertion order is age, for eviction. */
	const watched = new Map<string, WatchedCopy>();
	/** One step at a time per copy, so a save, a refetch, and a watch never interleave. */
	const queue = createKeyedWriteQueue();
	/** Work in flight, with the copy it is for (for `idle()`, `dispose()`, `pendingCopies()`). */
	const pending = new Map<Promise<void>, WatchedCopy>();
	/**
	 * Copies whose change is only in the copy: the last send failed, or the copy
	 * grew past the size cap. Cleared when the change is sent, kept beside the
	 * copy, or replaced by a fetch, or the copy is forgotten. Kept past
	 * `dispose()`, so the quit can still name them.
	 */
	const failed = new Set<WatchedCopy>();
	/** Copies with a sync queued that has not started: it reads the copy when it runs. */
	const queuedSync = new Set<WatchedCopy>();
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
				if (entry.halted || entry.watcherLost) continue;
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
		const anyWatcher = [...watched.values()].some((entry) => !entry.watcherLost);
		if (anyWatcher && !poller) {
			poller = setInterval(() => void poll(), pollMs);
			// Never what keeps the process alive.
			(poller as { unref?: () => void }).unref?.();
		} else if (!anyWatcher && poller) {
			clearInterval(poller);
			poller = null;
		}
	}

	/**
	 * Stop one copy's watcher (evicted at the cap, or disposed). A save the user
	 * made just before must still reach the remote: the copy is read once more
	 * and any change not sent yet goes now, instead of being dropped with its
	 * timer. The copy stays known (its baseline, its kept version), so a fresh
	 * Open still keeps a change made in it; the next `watch()` starts a new one.
	 */
	function retire(entry: WatchedCopy): void {
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = null;
		runSync(entry);
		if (!entry.watcherLost) entry.watcher.close();
		entry.watcherLost = true;
		updatePoller();
	}

	/** Retire the copy's watcher and forget the copy (dispose, or past {@link maxKnown}). */
	function stop(entry: WatchedCopy): void {
		retire(entry);
		watched.delete(entry.localPath);
		updatePoller();
	}

	/** Keep at most `maxWatched` watchers and `maxKnown` copies; the oldest go first. */
	function enforceCaps(): void {
		const live = [...watched.values()].filter((entry) => !entry.watcherLost);
		for (const entry of live.slice(0, Math.max(0, live.length - maxWatched))) retire(entry);
		while (watched.size > maxKnown) {
			const oldest = watched.values().next().value as WatchedCopy;
			// Forgotten for good (a fresh Open of it keeps an unsent change beside
			// it): its last send, queued by stop(), records nothing when it fails.
			oldest.forgotten = true;
			failed.delete(oldest);
			stop(oldest);
		}
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
		updatePoller();
		track(
			entry,
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

	/**
	 * Know a copy a refetch fetched with no record of it: `fetched` is what the
	 * remote holds, so it is the baseline, never the copy's bytes at the next
	 * `watch()` (a save made in between would read as already sent). No watcher
	 * yet; the next `watch()` starts one. `copySize`: the copy's size, when a save
	 * kept it from being replaced; whether it is too large to send is its own.
	 */
	function remember(
		copy: { localPath: string; remotePath: string; sshRemoteId: string },
		fetched: Buffer,
		copySize = fetched.length
	): WatchedCopy {
		const entry: WatchedCopy = {
			...copy,
			baseline: hashOf(fetched),
			kept: null,
			unconfirmed: null,
			halted: copySize > maxBytes ? 'too-large' : null,
			watcher: { close: () => undefined },
			watcherLost: true,
			forgotten: false,
			timer: null,
			// Unknown: the first poll after `watch()` reads the copy once.
			lastStat: null,
		};
		watched.set(copy.localPath, entry);
		enforceCaps();
		return entry;
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
			// An unconfirmed write (it failed with its connection) may have landed:
			// the baseline is not known until the remote is asked, so no shortcut.
			if (
				entry.unconfirmed === null &&
				(localHash === entry.baseline || localHash === entry.kept)
			) {
				failed.delete(entry);
				return;
			}
			// Said once already; a fresh Open starts over from the remote's bytes.
			if (entry.halted) return;
			if (local.length > maxBytes) {
				entry.halted = 'too-large';
				// Not on the remote, and only in the copy: the quit names it.
				if (!entry.forgotten) failed.add(entry);
				deps.notify({
					kind: 'failed',
					remotePath,
					sshRemoteId,
					message: remoteCopyTooLargeMessage(maxBytes),
				});
				return;
			}
			const remoteHash = await deps.hashRemote(remotePath, sshRemoteId);
			// The copy holds what the remote holds (a fresh fetch replaced it): nothing to send.
			if (remoteHash === localHash) {
				entry.baseline = localHash;
				entry.unconfirmed = null;
				failed.delete(entry);
				return;
			}
			// A write that failed with its connection may have landed after all (it
			// finishes on the remote): those bytes are this copy's, not a change by
			// someone else.
			if (entry.unconfirmed !== null && remoteHash === entry.unconfirmed) {
				entry.baseline = entry.unconfirmed;
			}
			entry.unconfirmed = localHash;
			const outcome = await deps.writeRemote(remotePath, local, sshRemoteId, entry.baseline);
			if (outcome === 'written') {
				entry.baseline = localHash;
				entry.unconfirmed = null;
				entry.kept = null;
				failed.delete(entry);
				deps.notify({ kind: 'saved', remotePath, sshRemoteId });
				return;
			}
			entry.unconfirmed = null;
			const keptAt = await keepVersion(localPath, local);
			entry.kept = localHash;
			entry.halted = 'conflict';
			// Kept beside the copy, and the user was told where: not lost at quit.
			failed.delete(entry);
			deps.notify({ kind: 'conflict', remotePath, sshRemoteId, keptAt });
		} catch (error) {
			if (!entry.forgotten) failed.add(entry);
			deps.notify({ kind: 'failed', remotePath, sshRemoteId, message: messageOf(error) });
		}
	}

	function runSync(entry: WatchedCopy): void {
		// A watch that stopped (evicted, disposed) while waiting sends nothing.
		if (watched.get(entry.localPath) !== entry) return;
		// One already waiting reads the copy as it is then: a second would only send
		// it (or fail, and say so) twice, as when a copy is retired and forgotten at once.
		if (queuedSync.has(entry)) return;
		queuedSync.add(entry);
		track(
			entry,
			queue.enqueue(entry.localPath, () => {
				queuedSync.delete(entry);
				return sync(entry);
			})
		);
	}

	/** Count `run` as work in flight for `entry` until it settles. */
	function track(entry: WatchedCopy, run: Promise<void>): void {
		pending.set(run, entry);
		void run.finally(() => pending.delete(run));
	}

	async function settle(): Promise<void> {
		while (pending.size > 0) await Promise.all([...pending.keys()]);
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
					// The copy still does not save back (a refetch could not start it over,
					// or put a copy too large to send back here): say so, not "saves back".
					if (existing.halted) throw haltError(existing.halted);
					if (existing.watcherLost) {
						existing.watcherLost = false;
						// Unknown, not "now": the next poll reads the copy once, so a save
						// made before this watcher started is still sent.
						existing.lastStat = null;
						existing.watcher = deps.watchFile(
							localPath,
							() => schedule(existing),
							() => lose(existing)
						);
						// Newest again: it is the last to lose its watcher.
						watched.delete(localPath);
						watched.set(localPath, existing);
						updatePoller();
						enforceCaps();
					}
					return;
				}
				const fetched = await deps.readLocal(localPath);
				// A copy too large to send back is not watched, but stays known with its
				// baseline: a fresh Open must keep a change made in it, not replace it.
				const tooLarge = fetched.length > maxBytes;
				const entry: WatchedCopy = {
					localPath,
					remotePath,
					sshRemoteId,
					baseline: hashOf(fetched),
					kept: null,
					unconfirmed: null,
					halted: tooLarge ? 'too-large' : null,
					watcher: { close: () => undefined },
					watcherLost: tooLarge,
					forgotten: false,
					timer: null,
					lastStat: await statKey(localPath),
				};
				if (!tooLarge) {
					entry.watcher = deps.watchFile(
						localPath,
						() => schedule(entry),
						() => lose(entry)
					);
				}
				watched.set(localPath, entry);
				updatePoller();
				// Only copies with a watcher count toward `maxWatched`: a copy too large
				// to send back never evicts a live one.
				enforceCaps();
				if (tooLarge) throw new RemoteCopyTooLargeError(maxBytes);
			});
		},
		async refetch({ localPath, remotePath, sshRemoteId }, { download, stage }) {
			const outcome = await queue.enqueue(localPath, async () => {
				const entry = watched.get(localPath);
				let checked: string | null = null;
				/** Where a change this copy could not send was kept, told once the fetch is done. */
				let keptAt: string | null = null;
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
						// While a write is unconfirmed the baseline is not known, so the copy
						// is not clean until the remote is asked (the sync above did, unless
						// it failed).
						const clean =
							entry.unconfirmed === null &&
							(localHash === entry.baseline || localHash === entry.kept);
						if (!clean) {
							// Still not on the remote (the write failed): the copy stays,
							// and the next save tries again.
							if (!entry.halted) return 'kept' as const;
							// This copy no longer saves back, and it holds a change kept
							// nowhere else: keep that beside it, and start over.
							keptAt = await keepVersion(localPath, local);
							entry.kept = localHash;
							failed.delete(entry);
						}
					}
				}
				let replaced = false;
				try {
					const bytes = await download();
					const staged = await stage(bytes);
					try {
						// The app may have saved the copy while the bytes were coming or
						// being staged (this queue orders Maestro's own steps, not the
						// app's): that save stays, and goes to the remote, instead of being
						// replaced. Checked after staging, so only the rename is left in the
						// window, and checked even when the watch was evicted meanwhile.
						const local = await readCopy(localPath);
						if (entry) {
							if (local && hashOf(local) !== checked) return 'saved-during-fetch' as const;
						} else if (local && hashOf(local) !== hashOf(bytes)) {
							// No baseline (an earlier run, forgotten, a crash): bytes that
							// differ may be a change never sent, so they are kept, never
							// replaced unseen.
							keptAt = await keepVersion(localPath, local);
							// A save the app made while that was written is in neither the
							// kept version nor the fetched bytes: the copy stays as it is.
							const after = await readCopy(localPath);
							if (after && hashOf(after) !== hashOf(local)) {
								// That save is not on the remote: known from now on over the
								// fetched bytes, it is sent like any save.
								remember({ localPath, remotePath, sshRemoteId }, bytes, after.length);
								return 'saved-during-fetch' as const;
							}
						}
						await staged.commit();
						replaced = true;
					} finally {
						if (!replaced) await staged.discard().catch(() => undefined);
					}
					if (entry) {
						// The next poll reads the copy once (a save may have landed beside the
						// rename); the read sends nothing when it holds these bytes.
						entry.lastStat = null;
						entry.baseline = hashOf(bytes);
						entry.kept = null;
						entry.unconfirmed = null;
						failed.delete(entry);
						// A fresh copy saves back again, unless it is too large to.
						entry.halted = bytes.length > maxBytes ? 'too-large' : null;
					} else {
						remember({ localPath, remotePath, sshRemoteId }, bytes);
					}
					return 'fetched' as const;
				} finally {
					// Said after the fetch, so the words match what the copy holds now.
					if (keptAt) {
						deps.notify({
							kind: 'kept',
							remotePath: entry?.remotePath ?? remotePath,
							sshRemoteId: entry?.sshRemoteId ?? sshRemoteId,
							keptAt,
							replaced,
						});
					}
				}
			});
			if (outcome === 'saved-during-fetch') {
				const entry = watched.get(localPath);
				if (entry) runSync(entry);
				return 'kept';
			}
			return outcome;
		},
		idle: settle,
		pendingCopies() {
			const copies = new Set([...pending.values(), ...failed]);
			for (const entry of watched.values()) if (entry.timer) copies.add(entry);
			return [...copies].map(({ remotePath, sshRemoteId }) => ({ remotePath, sshRemoteId }));
		},
		async dispose() {
			for (const entry of [...watched.values()]) stop(entry);
			await settle();
		},
	};
}
