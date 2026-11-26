/**
 * @fileoverview The write-back of a remote file's copy opened in another app: a
 * saved change goes to the remote file, a remote file that changed since the
 * fetch is never overwritten, a fresh fetch of the copy sends nothing, and a
 * fetch never replaces a change the remote does not have yet.
 */

import { createHash } from 'crypto';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
	createRemoteCopyWriteBack,
	keptVersionPath,
	RemoteCopyNotSavedBackError,
	RemoteCopyTooLargeError,
	remoteCopyTooLargeMessage,
	type RemoteCopyWriteBackEvent,
} from '../../../main/utils/remote-copy-write-back';

const LOCAL = path.join('tmp', 'maestro-remote-downloads', 'abc', 'notes.md');
const REMOTE = '/home/me/project/notes.md';
const WHEN = new Date(2026, 10, 26, 10, 15, 0);
/** The copy a refetch fetches into, named as `watch()` names it. */
const COPY = { localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' };

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let localFiles: Map<string, Buffer>;
let remoteFile: Buffer;
let onChange: (() => void) | null;
let onError: ((error: unknown) => void) | null;
let hashRemoteFails: boolean;
/** Modification time of each local file, bumped by every write a test makes through `writeCopy`. */
let mtimes: Map<string, number>;
let events: RemoteCopyWriteBackEvent[];
let writeRemote: Mock<
	(
		remotePath: string,
		bytes: Buffer,
		sshRemoteId: string,
		expectedSha256: string
	) => Promise<'written' | 'changed'>
>;
let close: Mock<() => void>;

function service(overrides: { maxWatched?: number; maxBytes?: number; fileEvents?: boolean } = {}) {
	return createRemoteCopyWriteBack(baseDeps(overrides));
}

/** The test's in-memory files and remote, as the service's dependencies. */
function baseDeps(
	overrides: { maxWatched?: number; maxBytes?: number; fileEvents?: boolean } = {}
): Parameters<typeof createRemoteCopyWriteBack>[0] {
	const { fileEvents = true, ...rest } = overrides;
	return {
		watchFile: (_localPath, handler, errorHandler) => {
			// Without file events (as on a machine that never delivers them) only the poll sees a save.
			if (fileEvents) onChange = handler;
			onError = errorHandler;
			return { close };
		},
		statLocal: async (localPath) => {
			const bytes = localFiles.get(localPath);
			return bytes ? { size: bytes.length, mtimeMs: mtimes.get(localPath) ?? 0 } : null;
		},
		readLocal: async (localPath) => {
			const bytes = localFiles.get(localPath);
			if (!bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			return bytes;
		},
		createLocal: async (localPath: string, bytes: Buffer) => {
			if (localFiles.has(localPath)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
			localFiles.set(localPath, bytes);
		},
		// The remote hashes its own file: its bytes never come here.
		hashRemote: async () => {
			if (hashRemoteFails) throw new Error('Connection refused');
			return sha(remoteFile);
		},
		writeRemote,
		notify: (event) => events.push(event),
		debounceMs: 50,
		pollMs: 1000,
		now: () => WHEN,
		...rest,
	};
}

/** The app saves the copy; the watcher fires and the debounce runs out. */
async function saveCopy(writeBack: ReturnType<typeof service>, text: string): Promise<void> {
	localFiles.set(LOCAL, Buffer.from(text));
	onChange?.();
	await vi.advanceTimersByTimeAsync(60);
	await writeBack.idle();
}

/** A second Open: the fetch puts the remote's bytes at the copy. */
/** Staging that puts the bytes at the copy on commit; `discarded` counts discards. */
let discarded: number;
function stageAt(localPath: string, onStage?: () => void) {
	return async (bytes: Buffer) => {
		onStage?.();
		return {
			commit: async () => {
				localFiles.set(localPath, bytes);
			},
			discard: async () => {
				discarded++;
			},
		};
	};
}

function reopen(
	writeBack: ReturnType<typeof service>,
	{ duringDownload, duringStage }: { duringDownload?: () => void; duringStage?: () => void } = {}
) {
	return writeBack.refetch(COPY, {
		download: async () => {
			duringDownload?.();
			return remoteFile;
		},
		stage: stageAt(LOCAL, duringStage),
	});
}

async function watched() {
	const writeBack = service();
	await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
	return writeBack;
}

beforeEach(() => {
	vi.useFakeTimers();
	localFiles = new Map([[LOCAL, Buffer.from('fetched')]]);
	remoteFile = Buffer.from('fetched');
	onChange = null;
	onError = null;
	hashRemoteFails = false;
	discarded = 0;
	mtimes = new Map();
	events = [];
	close = vi.fn<() => void>();
	// The remote's own check: the write lands only over the expected bytes.
	writeRemote = vi.fn(async (_remotePath: string, bytes: Buffer, _id: string, expected: string) => {
		if (sha(remoteFile) !== expected) return 'changed' as const;
		remoteFile = bytes;
		return 'written' as const;
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('remote copy write-back', () => {
	it('an Open after a restart keeps a change the last run never sent, before the fetch replaces it', async () => {
		// The last run saved the copy, then quit while the remote was down: the
		// change is only here, and this run has no record of the copy.
		localFiles.set(LOCAL, Buffer.from('unsent change'));
		const writeBack = service();
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		const keptAt = keptVersionPath(LOCAL, WHEN);
		expect(localFiles.get(keptAt)?.toString()).toBe('unsent change');
		expect(localFiles.get(LOCAL)?.toString()).toBe('fetched');
		expect(events).toEqual([
			{ kind: 'kept', remotePath: REMOTE, sshRemoteId: 'r1', keptAt, replaced: true },
		]);
	});

	it('an Open with no record of the copy keeps nothing when the copy already holds the remote bytes', async () => {
		const writeBack = service();
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		expect([...localFiles.keys()]).toEqual([LOCAL]);
		expect(events).toEqual([]);
	});

	it('an Open with no record of the copy keeps it, and fetches nothing over it, when keeping fails', async () => {
		localFiles.set(LOCAL, Buffer.from('unsent change'));
		const writeBack = createRemoteCopyWriteBack({
			...baseDeps(),
			createLocal: async () => {
				throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
			},
		});
		await expect(reopen(writeBack)).rejects.toThrow('EACCES');
		expect(localFiles.get(LOCAL)?.toString()).toBe('unsent change');
		expect(discarded).toBe(1);
	});

	it('an Open with no record of the copy leaves it alone when the app saves it while it is being kept', async () => {
		localFiles.set(LOCAL, Buffer.from('unsent change'));
		const writeBack = createRemoteCopyWriteBack({
			...baseDeps(),
			createLocal: async (keptAt, bytes) => {
				localFiles.set(keptAt, bytes);
				// The editor still has the copy open and saves it now.
				localFiles.set(LOCAL, Buffer.from('saved while keeping'));
			},
		});
		await expect(reopen(writeBack)).resolves.toBe('kept');
		expect(localFiles.get(LOCAL)?.toString()).toBe('saved while keeping');
		const keptAt = keptVersionPath(LOCAL, WHEN);
		expect(localFiles.get(keptAt)?.toString()).toBe('unsent change');
		expect(discarded).toBe(1);
		expect(events).toEqual([
			{ kind: 'kept', remotePath: REMOTE, sshRemoteId: 'r1', keptAt, replaced: false },
		]);
	});

	it('still names a copy whose send failed after its watch stopped, beside one still being sent', async () => {
		const other = path.join('tmp', 'maestro-remote-downloads', 'abc', 'other.md');
		localFiles.set(other, Buffer.from('x'));
		const writeBack = await watched();
		await writeBack.watch({ localPath: other, remotePath: '/home/me/other.md', sshRemoteId: 'r1' });
		// notes.md fails at once; other.md hangs (a dead connection).
		writeRemote.mockImplementation(async (remotePath) => {
			if (remotePath === REMOTE) throw new Error('Connection refused');
			return new Promise(() => undefined);
		});
		localFiles.set(LOCAL, Buffer.from('edited'));
		localFiles.set(other, Buffer.from('edited too'));
		void writeBack.dispose();
		await vi.advanceTimersByTimeAsync(0);
		expect(events.map((e) => e.kind)).toEqual(['failed']);
		expect(writeBack.pendingCopies()).toEqual(
			expect.arrayContaining([
				{ remotePath: REMOTE, sshRemoteId: 'r1' },
				{ remotePath: '/home/me/other.md', sshRemoteId: 'r1' },
			])
		);
		expect(writeBack.pendingCopies()).toHaveLength(2);
	});

	it('stops naming a copy once a later send of it lands', async () => {
		writeRemote.mockRejectedValueOnce(new Error('Connection refused'));
		const writeBack = await watched();
		await saveCopy(writeBack, 'edited');
		expect(writeBack.pendingCopies()).toEqual([{ remotePath: REMOTE, sshRemoteId: 'r1' }]);
		await saveCopy(writeBack, 'edited again');
		expect(writeBack.pendingCopies()).toEqual([]);
	});

	it('names the copies whose change is not sent yet', async () => {
		writeRemote.mockImplementation(() => new Promise(() => undefined));
		const writeBack = await watched();
		expect(writeBack.pendingCopies()).toEqual([]);
		localFiles.set(LOCAL, Buffer.from('edited'));
		onChange?.();
		// Waiting out its debounce, then being sent: pending both times.
		expect(writeBack.pendingCopies()).toEqual([{ remotePath: REMOTE, sshRemoteId: 'r1' }]);
		await vi.advanceTimersByTimeAsync(60);
		expect(writeRemote).toHaveBeenCalledTimes(1);
		expect(writeBack.pendingCopies()).toEqual([{ remotePath: REMOTE, sshRemoteId: 'r1' }]);
	});

	it('writes a saved change back to the remote file, over the bytes it was fetched from', async () => {
		const writeBack = await watched();
		await saveCopy(writeBack, 'edited');
		expect(writeRemote).toHaveBeenCalledWith(
			REMOTE,
			Buffer.from('edited'),
			'r1',
			sha(Buffer.from('fetched'))
		);
		expect(events).toEqual([{ kind: 'saved', remotePath: REMOTE, sshRemoteId: 'r1' }]);
	});

	it('saves a second change on top of the first', async () => {
		const writeBack = await watched();
		await saveCopy(writeBack, 'edited');
		await saveCopy(writeBack, 'edited again');
		expect(writeRemote).toHaveBeenCalledTimes(2);
		expect(remoteFile.toString()).toBe('edited again');
	});

	it('never overwrites a remote file that changed since the fetch, and keeps the user version', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'edited');
		expect(remoteFile.toString()).toBe('someone else');
		const keptAt = keptVersionPath(LOCAL, WHEN);
		expect(localFiles.get(keptAt)?.toString()).toBe('edited');
		expect(events).toEqual([{ kind: 'conflict', remotePath: REMOTE, sshRemoteId: 'r1', keptAt }]);
	});

	it('refuses a remote change that lands between its read and its write', async () => {
		const writeBack = await watched();
		// The remote check runs where the write runs, so a late change is still caught.
		writeRemote.mockImplementationOnce(async () => 'changed');
		await saveCopy(writeBack, 'edited');
		expect(events.map((e) => e.kind)).toEqual(['conflict']);
	});

	it('after a conflict, stops saving that copy back and says so only once', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'first');
		await saveCopy(writeBack, 'second');
		await saveCopy(writeBack, 'third');
		expect(writeRemote).toHaveBeenCalledTimes(1);
		expect(events.map((e) => e.kind)).toEqual(['conflict']);
		expect(remoteFile.toString()).toBe('someone else');
		// One kept version, and the later saves are still in the copy.
		expect(localFiles.get(keptVersionPath(LOCAL, WHEN))?.toString()).toBe('first');
		expect(localFiles.has(keptVersionPath(LOCAL, WHEN, 2))).toBe(false);
		expect(localFiles.get(LOCAL)?.toString()).toBe('third');
	});

	it('a fresh Open after a conflict keeps the unsent change beside the copy and saves back again', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'first');
		await saveCopy(writeBack, 'second');

		// Open again: the change in the copy is kept under a name no earlier version holds.
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		const keptAt = keptVersionPath(LOCAL, WHEN, 2);
		expect(localFiles.get(keptAt)?.toString()).toBe('second');
		expect(events.at(-1)).toEqual({
			kind: 'kept',
			remotePath: REMOTE,
			sshRemoteId: 'r1',
			keptAt,
			replaced: true,
		});

		// The fetch put the remote's bytes in the copy: a new baseline.
		expect(localFiles.get(LOCAL)?.toString()).toBe('someone else');
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await saveCopy(writeBack, 'edited on top of theirs');
		expect(remoteFile.toString()).toBe('edited on top of theirs');
		expect(events.at(-1)).toEqual({ kind: 'saved', remotePath: REMOTE, sshRemoteId: 'r1' });
	});

	it('sends nothing when the copy is replaced by a fresh fetch', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('newer on the remote');
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		await saveCopy(writeBack, 'newer on the remote');
		expect(writeRemote).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		// The fresh bytes are the new baseline: the next save goes through.
		await saveCopy(writeBack, 'edited');
		expect(remoteFile.toString()).toBe('edited');
	});

	it('a refetch sends a change that failed before, then fetches over it', async () => {
		writeRemote.mockRejectedValueOnce(new Error('Connection refused'));
		const writeBack = await watched();
		await saveCopy(writeBack, 'edited');
		expect(events.map((e) => e.kind)).toEqual(['failed']);

		await expect(reopen(writeBack)).resolves.toBe('fetched');
		expect(remoteFile.toString()).toBe('edited');
		expect(localFiles.get(LOCAL)?.toString()).toBe('edited');
		expect(events.map((e) => e.kind)).toEqual(['failed', 'saved']);
	});

	it('a refetch keeps a copy whose change still cannot reach the remote, and fetches nothing', async () => {
		writeRemote.mockRejectedValue(new Error('Connection refused'));
		const writeBack = await watched();
		await saveCopy(writeBack, 'edited');
		const download = vi.fn(async () => remoteFile);
		await expect(writeBack.refetch(COPY, { download, stage: stageAt(LOCAL) })).resolves.toBe(
			'kept'
		);
		expect(download).not.toHaveBeenCalled();
		expect(localFiles.get(LOCAL)?.toString()).toBe('edited');
	});

	it('a refetch inside the save debounce sends the save first, then fetches', async () => {
		const writeBack = await watched();
		localFiles.set(LOCAL, Buffer.from('just saved'));
		onChange?.();
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		expect(writeRemote).toHaveBeenCalledTimes(1);
		expect(remoteFile.toString()).toBe('just saved');
		expect(localFiles.get(LOCAL)?.toString()).toBe('just saved');
	});

	it('a save made while the refetch downloads stays in the copy and goes to the remote', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('newer on the remote');
		await expect(
			reopen(writeBack, {
				duringDownload: () => {
					localFiles.set(LOCAL, Buffer.from('saved during the download'));
					onChange?.();
				},
			})
		).resolves.toBe('kept');
		expect(localFiles.get(LOCAL)?.toString()).toBe('saved during the download');
		await vi.advanceTimersByTimeAsync(60);
		await writeBack.idle();
		// The remote changed since the copy's baseline: refused, and the save is kept beside.
		expect(remoteFile.toString()).toBe('newer on the remote');
		expect(events.map((e) => e.kind)).toEqual(['conflict']);
		expect(localFiles.get(keptVersionPath(LOCAL, WHEN))?.toString()).toBe(
			'saved during the download'
		);
	});

	it('a refetch replaces a copy with no unsent change, or one already kept beside it', async () => {
		const writeBack = await watched();
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'edited');
		// The conflict kept "edited" beside the copy, so a fetch may replace the copy.
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		expect(localFiles.get(LOCAL)?.toString()).toBe('someone else');
		await expect(reopen(service())).resolves.toBe('fetched');
	});

	it('ignores a moment when an atomic save has the copy moved away', async () => {
		const writeBack = await watched();
		localFiles.delete(LOCAL);
		onChange?.();
		await vi.advanceTimersByTimeAsync(60);
		await writeBack.idle();
		expect(events).toEqual([]);
		expect(writeRemote).not.toHaveBeenCalled();
	});

	it('reports a failed remote write, and the change stays in the copy', async () => {
		writeRemote.mockRejectedValueOnce(new Error('Connection refused'));
		const writeBack = await watched();
		await saveCopy(writeBack, 'edited');
		expect(events).toEqual([
			{ kind: 'failed', remotePath: REMOTE, sshRemoteId: 'r1', message: 'Connection refused' },
		]);
		expect(localFiles.get(LOCAL)?.toString()).toBe('edited');
	});

	it('runs once for a burst of change events', async () => {
		const writeBack = await watched();
		localFiles.set(LOCAL, Buffer.from('edited'));
		onChange?.();
		await vi.advanceTimersByTimeAsync(20);
		onChange?.();
		await vi.advanceTimersByTimeAsync(60);
		await writeBack.idle();
		expect(writeRemote).toHaveBeenCalledTimes(1);
	});

	it('stops the oldest watch past the limit, and every watch on dispose', async () => {
		const writeBack = service({ maxWatched: 1 });
		const other = path.join('tmp', 'maestro-remote-downloads', 'abc', 'other.md');
		localFiles.set(other, Buffer.from('x'));
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await writeBack.watch({ localPath: other, remotePath: '/home/me/other.md', sshRemoteId: 'r1' });
		expect(close).toHaveBeenCalledTimes(1);
		writeBack.dispose();
		expect(close).toHaveBeenCalledTimes(2);
	});

	it('refuses to watch a copy too large to send back', async () => {
		const writeBack = service({ maxBytes: 4 });
		await expect(
			writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' })
		).rejects.toBeInstanceOf(RemoteCopyTooLargeError);
		expect(onChange).toBeNull();
	});

	it('says a save that grew past the cap is too large to save back, and sends nothing', async () => {
		const writeBack = service({ maxBytes: 8 });
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await saveCopy(writeBack, 'far too long to send');
		expect(writeRemote).not.toHaveBeenCalled();
		expect(events).toEqual([
			{
				kind: 'failed',
				remotePath: REMOTE,
				sshRemoteId: 'r1',
				message: remoteCopyTooLargeMessage(8),
			},
		]);
		expect(localFiles.get(LOCAL)?.toString()).toBe('far too long to send');
		// Said once: the next save is not sent and not announced again.
		await saveCopy(writeBack, 'still far too long');
		expect(events).toHaveLength(1);
	});

	it('a fresh Open that fetches a copy too large to send back says so', async () => {
		const writeBack = service({ maxBytes: 8 });
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		remoteFile = Buffer.from('now far too long');
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		await expect(
			writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' })
		).rejects.toBeInstanceOf(RemoteCopyTooLargeError);
	});

	it('sends a save still waiting out its debounce when its watch is evicted at the cap', async () => {
		const writeBack = service({ maxWatched: 1 });
		const other = path.join('tmp', 'maestro-remote-downloads', 'abc', 'other.md');
		localFiles.set(other, Buffer.from('x'));
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		localFiles.set(LOCAL, Buffer.from('saved just before'));
		onChange?.();
		// A second Open evicts the first watch before its debounce runs out.
		await writeBack.watch({ localPath: other, remotePath: '/home/me/other.md', sshRemoteId: 'r1' });
		await writeBack.idle();
		expect(remoteFile.toString()).toBe('saved just before');
		expect(events).toEqual([{ kind: 'saved', remotePath: REMOTE, sshRemoteId: 'r1' }]);
	});

	it('dispose sends every change not sent yet, even one no event reported, and resolves after', async () => {
		const writeBack = await watched();
		// Saved, but the watcher has not reported it (or its debounce is still waiting).
		localFiles.set(LOCAL, Buffer.from('saved at quit'));
		await writeBack.dispose();
		expect(remoteFile.toString()).toBe('saved at quit');
		expect(close).toHaveBeenCalledTimes(1);
		// Nothing more is sent once the watch is gone.
		localFiles.set(LOCAL, Buffer.from('after'));
		onChange?.();
		await vi.advanceTimersByTimeAsync(60);
		await writeBack.idle();
		expect(remoteFile.toString()).toBe('saved at quit');
	});

	it('sees a save with no file events, by its size and modification time, and sends it', async () => {
		const writeBack = service({ fileEvents: false });
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		expect(onChange).toBeNull();
		// Same size as before: only the modification time moved.
		localFiles.set(LOCAL, Buffer.from('edited!'));
		mtimes.set(LOCAL, 1);
		await vi.advanceTimersByTimeAsync(1000 + 60);
		await writeBack.idle();
		expect(remoteFile.toString()).toBe('edited!');
		expect(events).toEqual([{ kind: 'saved', remotePath: REMOTE, sshRemoteId: 'r1' }]);
		// Nothing moved since: the poll sends nothing more.
		await vi.advanceTimersByTimeAsync(3000);
		await writeBack.idle();
		expect(writeRemote).toHaveBeenCalledTimes(1);
	});

	it('stops polling once no copy is watched', async () => {
		const writeBack = service({ fileEvents: false });
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		expect(vi.getTimerCount()).toBe(1);
		await writeBack.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('says once that a copy whose watcher failed no longer saves back, and a fresh Open watches it again', async () => {
		const writeBack = await watched();
		// Saved just before the watcher failed: still sent.
		localFiles.set(LOCAL, Buffer.from('saved before the failure'));
		onError?.(new Error('EMFILE'));
		onError?.(new Error('EMFILE'));
		await writeBack.idle();
		expect(remoteFile.toString()).toBe('saved before the failure');
		expect(close).toHaveBeenCalledTimes(1);
		expect(events.map((e) => e.kind)).toEqual(['saved', 'unwatched']);

		// A later save stays in the copy, even when the poll sees it.
		localFiles.set(LOCAL, Buffer.from('after the failure'));
		mtimes.set(LOCAL, 2);
		await vi.advanceTimersByTimeAsync(2000);
		await writeBack.idle();
		expect(writeRemote).toHaveBeenCalledTimes(1);

		// Open again: the unsent change is kept beside, and the copy is watched again.
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		expect(localFiles.get(keptVersionPath(LOCAL, WHEN))?.toString()).toBe('after the failure');
		onChange = null;
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		expect(onChange).not.toBeNull();
		await saveCopy(writeBack, 'watched again');
		expect(remoteFile.toString()).toBe('watched again');
	});

	it('a fresh Open of a copy too large to send back keeps a change made in it', async () => {
		const writeBack = service({ maxBytes: 4 });
		await expect(
			writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' })
		).rejects.toBeInstanceOf(RemoteCopyTooLargeError);
		localFiles.set(LOCAL, Buffer.from('edited the big copy'));
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		expect(localFiles.get(keptVersionPath(LOCAL, WHEN))?.toString()).toBe('edited the big copy');
		expect(localFiles.get(LOCAL)?.toString()).toBe('fetched');
		expect(writeRemote).not.toHaveBeenCalled();
	});

	it('watch says a copy a refetch could not start over does not save back', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'first');
		// Open again, and the app saves while the bytes download: the copy keeps that save.
		await expect(
			reopen(writeBack, {
				duringDownload: () => localFiles.set(LOCAL, Buffer.from('saved during the download')),
			})
		).resolves.toBe('kept');
		await expect(
			writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' })
		).rejects.toThrow(
			new RemoteCopyNotSavedBackError(
				'The remote file changed since this copy was made, so the copy does not save back'
			)
		);
	});

	it('says a change was kept without claiming the copy was replaced when the fetch fails', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'first');
		await saveCopy(writeBack, 'second');
		await expect(
			writeBack.refetch(COPY, {
				download: async () => {
					throw new Error('Connection refused');
				},
				stage: stageAt(LOCAL),
			})
		).rejects.toThrow('Connection refused');
		expect(events.at(-1)).toMatchObject({ kind: 'kept', replaced: false });
		expect(localFiles.get(LOCAL)?.toString()).toBe('second');
	});

	it('a save made while the refetch downloads stays, even when another Open evicted the watch', async () => {
		const writeBack = service({ maxWatched: 1 });
		const other = path.join('tmp', 'maestro-remote-downloads', 'abc', 'other.md');
		localFiles.set(other, Buffer.from('x'));
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await expect(
			writeBack.refetch(COPY, {
				download: async () => {
					await writeBack.watch({
						localPath: other,
						remotePath: '/home/me/other.md',
						sshRemoteId: 'r1',
					});
					localFiles.set(LOCAL, Buffer.from('saved during the download'));
					return remoteFile;
				},
				stage: stageAt(LOCAL),
			})
		).resolves.toBe('kept');
		await writeBack.idle();
		expect(localFiles.get(LOCAL)?.toString()).toBe('saved during the download');
		// The eviction's last send ran after the refetch, and found the save.
		expect(remoteFile.toString()).toBe('saved during the download');
	});

	it('after a refetch, the next poll reads the copy once, so a save beside the rename still goes', async () => {
		const writeBack = service({ fileEvents: false });
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		remoteFile = Buffer.from('remote2');
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		// Same size and time as the fetched copy: only reading it shows the change.
		localFiles.set(LOCAL, Buffer.from('edited!'));
		await vi.advanceTimersByTimeAsync(1000 + 60);
		await writeBack.idle();
		expect(remoteFile.toString()).toBe('edited!');
	});

	it('a save after a write that failed but landed counts that write, never as a conflict', async () => {
		const writeBack = await watched();
		// The connection drops, but the remote finishes the write.
		writeRemote.mockImplementationOnce(async (_p, bytes) => {
			remoteFile = bytes;
			throw new Error('Connection reset by peer');
		});
		await saveCopy(writeBack, 'first');
		expect(events.map((e) => e.kind)).toEqual(['failed']);
		await saveCopy(writeBack, 'second');
		expect(remoteFile.toString()).toBe('second');
		expect(events.map((e) => e.kind)).toEqual(['failed', 'saved']);
	});

	it('a save made while the fetched bytes are staged stays, and the staged bytes are discarded', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('newer on the remote');
		await expect(
			reopen(writeBack, {
				duringStage: () => localFiles.set(LOCAL, Buffer.from('saved while staging')),
			})
		).resolves.toBe('kept');
		expect(localFiles.get(LOCAL)?.toString()).toBe('saved while staging');
		expect(discarded).toBe(1);
	});

	it('keeps an edit to a copy that stopped saving back, even after its watch was evicted', async () => {
		const writeBack = service({ maxWatched: 1 });
		const other = path.join('tmp', 'maestro-remote-downloads', 'abc', 'other.md');
		localFiles.set(other, Buffer.from('x'));
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'first');
		localFiles.set(LOCAL, Buffer.from('second, after the conflict'));
		await writeBack.watch({ localPath: other, remotePath: '/home/me/other.md', sshRemoteId: 'r1' });
		await writeBack.idle();

		await expect(reopen(writeBack)).resolves.toBe('fetched');
		expect(localFiles.get(keptVersionPath(LOCAL, WHEN, 2))?.toString()).toBe(
			'second, after the conflict'
		);
		// Opened again: watched again.
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await saveCopy(writeBack, 'on top of theirs');
		expect(remoteFile.toString()).toBe('on top of theirs');
	});

	it('a copy too large to send back never evicts a live watch', async () => {
		const writeBack = service({ maxWatched: 1, maxBytes: 8 });
		const big = path.join('tmp', 'maestro-remote-downloads', 'abc', 'big.bin');
		localFiles.set(big, Buffer.from('far too long to send'));
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		const handler = onChange;
		await expect(
			writeBack.watch({ localPath: big, remotePath: '/home/me/big.bin', sshRemoteId: 'r1' })
		).rejects.toBeInstanceOf(RemoteCopyTooLargeError);
		expect(close).not.toHaveBeenCalled();
		onChange = handler;
		await saveCopy(writeBack, 'edited');
		expect(remoteFile.toString()).toBe('edited');
	});

	it('a save back to the bytes it was fetched from, after a write that landed unconfirmed, still goes', async () => {
		const writeBack = await watched();
		writeRemote.mockImplementationOnce(async (_p, bytes) => {
			remoteFile = bytes;
			throw new Error('Connection reset by peer');
		});
		await saveCopy(writeBack, 'B');
		// The user saves the original bytes again: the remote holds B, not these.
		await saveCopy(writeBack, 'fetched');
		expect(remoteFile.toString()).toBe('fetched');
		await expect(reopen(writeBack)).resolves.toBe('fetched');
		expect(localFiles.get(LOCAL)?.toString()).toBe('fetched');
	});

	it('keeps a copy whose write is still unconfirmed when the remote cannot be asked', async () => {
		const writeBack = await watched();
		writeRemote.mockImplementationOnce(async (_p, bytes) => {
			remoteFile = bytes;
			throw new Error('Connection reset by peer');
		});
		await saveCopy(writeBack, 'B');
		// The user puts the fetched bytes back; then the remote cannot be reached.
		localFiles.set(LOCAL, Buffer.from('fetched'));
		hashRemoteFails = true;
		const download = vi.fn(async () => remoteFile);
		await expect(writeBack.refetch(COPY, { download, stage: stageAt(LOCAL) })).resolves.toBe(
			'kept'
		);
		expect(download).not.toHaveBeenCalled();
		expect(localFiles.get(LOCAL)?.toString()).toBe('fetched');
	});

	it('a re-Open that watches a retired copy again still sends a save made before the watcher started', async () => {
		const writeBack = service({ maxWatched: 1, fileEvents: false });
		const other = path.join('tmp', 'maestro-remote-downloads', 'abc', 'other.md');
		localFiles.set(other, Buffer.from('x'));
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await writeBack.watch({ localPath: other, remotePath: '/home/me/other.md', sshRemoteId: 'r1' });
		await writeBack.idle();
		// Saved while no watcher ran, with the same size and time as the fetched copy.
		localFiles.set(LOCAL, Buffer.from('edited!'));
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await vi.advanceTimersByTimeAsync(1000 + 60);
		await writeBack.idle();
		expect(remoteFile.toString()).toBe('edited!');
	});

	it('names the kept version beside the copy', () => {
		expect(keptVersionPath(LOCAL, WHEN)).toBe(
			path.join(path.dirname(LOCAL), 'notes (your version 20261126-101500).md')
		);
		expect(keptVersionPath(LOCAL, WHEN, 2)).toBe(
			path.join(path.dirname(LOCAL), 'notes (your version 20261126-101500 2).md')
		);
	});
});
