/**
 * @fileoverview The write-back of a remote file's copy opened in another app: a
 * saved change goes to the remote file, a remote file that changed since the
 * fetch is never overwritten, and a fresh fetch of the copy sends nothing.
 */

import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
	createRemoteCopyWriteBack,
	keptVersionPath,
	type RemoteCopyWriteBackEvent,
} from '../../../main/utils/remote-copy-write-back';

const LOCAL = path.join('tmp', 'maestro-remote-downloads', 'abc', 'notes.md');
const REMOTE = '/home/me/project/notes.md';
const WHEN = new Date(2026, 10, 26, 10, 15, 0);

let localFiles: Map<string, Buffer>;
let remoteFile: Buffer;
let onChange: (() => void) | null;
let events: RemoteCopyWriteBackEvent[];
let writeRemote: Mock<(remotePath: string, bytes: Buffer, sshRemoteId: string) => Promise<void>>;
let close: Mock<() => void>;

function service(overrides: { maxWatched?: number } = {}) {
	return createRemoteCopyWriteBack({
		watchFile: (_localPath, handler) => {
			onChange = handler;
			return { close };
		},
		readLocal: async (localPath) => {
			const bytes = localFiles.get(localPath);
			if (!bytes) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			return bytes;
		},
		writeLocal: async (localPath, bytes) => {
			localFiles.set(localPath, bytes);
		},
		readRemote: async () => remoteFile,
		writeRemote,
		notify: (event) => events.push(event),
		debounceMs: 50,
		now: () => WHEN,
		...overrides,
	});
}

/** The app saves the copy; the watcher fires and the debounce runs out. */
async function saveCopy(writeBack: ReturnType<typeof service>, text: string): Promise<void> {
	localFiles.set(LOCAL, Buffer.from(text));
	onChange?.();
	await vi.advanceTimersByTimeAsync(60);
	await writeBack.idle();
}

beforeEach(() => {
	vi.useFakeTimers();
	localFiles = new Map([[LOCAL, Buffer.from('fetched')]]);
	remoteFile = Buffer.from('fetched');
	onChange = null;
	events = [];
	close = vi.fn<() => void>();
	writeRemote = vi.fn(async (_remotePath: string, bytes: Buffer, _sshRemoteId: string) => {
		remoteFile = bytes;
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('remote copy write-back', () => {
	it('writes a saved change back to the remote file and says so', async () => {
		const writeBack = service();
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await saveCopy(writeBack, 'edited');
		expect(writeRemote).toHaveBeenCalledWith(REMOTE, Buffer.from('edited'), 'r1');
		expect(events).toEqual([{ kind: 'saved', remotePath: REMOTE, sshRemoteId: 'r1' }]);
	});

	it('saves a second change on top of the first', async () => {
		const writeBack = service();
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await saveCopy(writeBack, 'edited');
		await saveCopy(writeBack, 'edited again');
		expect(writeRemote).toHaveBeenCalledTimes(2);
		expect(remoteFile.toString()).toBe('edited again');
	});

	it('never overwrites a remote file that changed since the fetch, and keeps the user version', async () => {
		const writeBack = service();
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'edited');
		expect(writeRemote).not.toHaveBeenCalled();
		const keptAt = keptVersionPath(LOCAL, WHEN);
		expect(localFiles.get(keptAt)?.toString()).toBe('edited');
		expect(events).toEqual([{ kind: 'conflict', remotePath: REMOTE, sshRemoteId: 'r1', keptAt }]);
	});

	it('sends nothing when the copy is replaced by a fresh fetch', async () => {
		const writeBack = service();
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		remoteFile = Buffer.from('newer on the remote');
		await saveCopy(writeBack, 'newer on the remote');
		expect(writeRemote).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		// The fresh bytes are the new baseline: the next save goes through.
		await saveCopy(writeBack, 'edited');
		expect(writeRemote).toHaveBeenCalledTimes(1);
	});

	it('a second open takes the fetched bytes as the baseline', async () => {
		const writeBack = service();
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		remoteFile = Buffer.from('changed remotely');
		localFiles.set(LOCAL, Buffer.from('changed remotely'));
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await saveCopy(writeBack, 'edited');
		expect(writeRemote).toHaveBeenCalledWith(REMOTE, Buffer.from('edited'), 'r1');
	});

	it('ignores a moment when an atomic save has the copy moved away', async () => {
		const writeBack = service();
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		localFiles.delete(LOCAL);
		onChange?.();
		await vi.advanceTimersByTimeAsync(60);
		await writeBack.idle();
		expect(events).toEqual([]);
		expect(writeRemote).not.toHaveBeenCalled();
	});

	it('reports a failed remote write, and the change stays in the copy', async () => {
		writeRemote.mockRejectedValueOnce(new Error('Connection refused'));
		const writeBack = service();
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
		await saveCopy(writeBack, 'edited');
		expect(events).toEqual([
			{ kind: 'failed', remotePath: REMOTE, sshRemoteId: 'r1', message: 'Connection refused' },
		]);
		expect(localFiles.get(LOCAL)?.toString()).toBe('edited');
	});

	it('runs once for a burst of change events', async () => {
		const writeBack = service();
		await writeBack.watch({ localPath: LOCAL, remotePath: REMOTE, sshRemoteId: 'r1' });
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

	it('names the kept version beside the copy', () => {
		expect(keptVersionPath(LOCAL, WHEN)).toBe(
			path.join(path.dirname(LOCAL), 'notes (your version 20261126-101500).md')
		);
	});
});
