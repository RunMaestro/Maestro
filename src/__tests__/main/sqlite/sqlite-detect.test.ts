import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasSqliteHeaderOnDisk, isSqliteDatabaseFile } from '../../../main/sqlite/sqlite-detect';

// Real files on disk, not an fs mock: the point of the sniff is that it reads
// exactly the header bytes, and a mock would only prove the mock.
let dir: string;

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

async function writeFixture(name: string, bytes: Buffer): Promise<string> {
	const file = path.join(dir, name);
	await fs.writeFile(file, bytes);
	return file;
}

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-sqlite-detect-'));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe('hasSqliteHeaderOnDisk', () => {
	it('reads a real SQLite header regardless of extension', async () => {
		const file = await writeFixture('History', Buffer.concat([MAGIC, Buffer.alloc(4080)]));
		expect(await hasSqliteHeaderOnDisk(file)).toBe(true);
	});

	it('rejects a file shorter than the header', async () => {
		const file = await writeFixture('short.db', MAGIC.subarray(0, 10));
		expect(await hasSqliteHeaderOnDisk(file)).toBe(false);
	});

	it('rejects an empty file', async () => {
		const file = await writeFixture('empty.db', Buffer.alloc(0));
		expect(await hasSqliteHeaderOnDisk(file)).toBe(false);
	});

	it('propagates ENOENT so fs:readFile keeps returning null for missing files', async () => {
		await expect(hasSqliteHeaderOnDisk(path.join(dir, 'missing.db'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
});

describe('isSqliteDatabaseFile', () => {
	it('accepts a .db whose header is SQLite', async () => {
		const file = await writeFixture('app.db', Buffer.concat([MAGIC, Buffer.alloc(84)]));
		expect(await isSqliteDatabaseFile(file)).toBe(true);
	});

	it('rejects a .db that is some other format, so it falls through to the binary card', async () => {
		const leveldb = await writeFixture('leveldb.db', Buffer.from('LevelDB manifest bytes here'));
		expect(await isSqliteDatabaseFile(leveldb)).toBe(false);
	});

	it('rejects an encrypted (SQLCipher-style) .sqlite', async () => {
		const random = Buffer.alloc(64);
		for (let i = 0; i < random.length; i++) random[i] = (i * 73 + 41) & 0xff;
		const file = await writeFixture('secret.sqlite', random);
		expect(await isSqliteDatabaseFile(file)).toBe(false);
	});

	it('never opens a non-candidate path, even a missing one', async () => {
		// A real SQLite file under a non-candidate name is still not sniffed, and
		// a missing non-candidate does not throw because nothing is opened.
		const file = await writeFixture('notes.txt', Buffer.concat([MAGIC, Buffer.alloc(84)]));
		expect(await isSqliteDatabaseFile(file)).toBe(false);
		expect(await isSqliteDatabaseFile(path.join(dir, 'missing.txt'))).toBe(false);
	});
});
