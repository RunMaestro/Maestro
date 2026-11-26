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
	type RemoteCopyWriteBackEvent,
} from '../../../main/utils/remote-copy-write-back';

const LOCAL = path.join('tmp', 'maestro-remote-downloads', 'abc', 'notes.md');
const REMOTE = '/home/me/project/notes.md';
const WHEN = new Date(2026, 10, 26, 10, 15, 0);

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let localFiles: Map<string, Buffer>;
let remoteFile: Buffer;
let onChange: (() => void) | null;
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
		createLocal: async (localPath: string, bytes: Buffer) => {
			if (localFiles.has(localPath)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
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

	it('keeps both versions of two conflicts in one second', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'first');
		await saveCopy(writeBack, 'second');
		expect(localFiles.get(keptVersionPath(LOCAL, WHEN))?.toString()).toBe('first');
		expect(localFiles.get(keptVersionPath(LOCAL, WHEN, 2))?.toString()).toBe('second');
		expect(events.at(-1)).toMatchObject({ keptAt: keptVersionPath(LOCAL, WHEN, 2) });
	});

	it('sends nothing when the copy is replaced by a fresh fetch', async () => {
		const writeBack = await watched();
		remoteFile = Buffer.from('newer on the remote');
		await writeBack.noteFetched(LOCAL, remoteFile);
		await saveCopy(writeBack, 'newer on the remote');
		expect(writeRemote).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		// The fresh bytes are the new baseline: the next save goes through.
		await saveCopy(writeBack, 'edited');
		expect(remoteFile.toString()).toBe('edited');
	});

	it('a refetch keeps a copy whose change the remote does not have, and sends it again', async () => {
		writeRemote.mockRejectedValueOnce(new Error('Connection refused'));
		const writeBack = await watched();
		await saveCopy(writeBack, 'edited');
		expect(events.map((e) => e.kind)).toEqual(['failed']);

		await expect(writeBack.beforeRefetch(LOCAL)).resolves.toBe('keep');
		await writeBack.idle();
		expect(localFiles.get(LOCAL)?.toString()).toBe('edited');
		expect(remoteFile.toString()).toBe('edited');
		expect(events.map((e) => e.kind)).toEqual(['failed', 'saved']);
	});

	it('a refetch inside the save debounce keeps the copy and sends it at once', async () => {
		const writeBack = await watched();
		localFiles.set(LOCAL, Buffer.from('just saved'));
		onChange?.();
		await expect(writeBack.beforeRefetch(LOCAL)).resolves.toBe('keep');
		await writeBack.idle();
		expect(remoteFile.toString()).toBe('just saved');
	});

	it('a refetch replaces a copy with no unsent change, or one already kept beside it', async () => {
		const writeBack = await watched();
		await expect(writeBack.beforeRefetch(LOCAL)).resolves.toBe('fetch');
		remoteFile = Buffer.from('someone else');
		await saveCopy(writeBack, 'edited');
		// The conflict kept "edited" beside the copy, so a fetch may replace the copy.
		await expect(writeBack.beforeRefetch(LOCAL)).resolves.toBe('fetch');
		await expect(service().beforeRefetch(LOCAL)).resolves.toBe('fetch');
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

	it('names the kept version beside the copy', () => {
		expect(keptVersionPath(LOCAL, WHEN)).toBe(
			path.join(path.dirname(LOCAL), 'notes (your version 20261126-101500).md')
		);
		expect(keptVersionPath(LOCAL, WHEN, 2)).toBe(
			path.join(path.dirname(LOCAL), 'notes (your version 20261126-101500 2).md')
		);
	});
});
