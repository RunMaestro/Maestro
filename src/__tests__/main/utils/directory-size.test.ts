/**
 * @file directory-size.test.ts
 *
 * `directoryBytes` is the one recursive size walk Local Models reports disk
 * with. Runs against a real temp directory: what is being tested is how the
 * walk treats the filesystem, so mocking `fs` would test the mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { directoryBytes } from '../../../main/utils/directory-size';

describe('directoryBytes', () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-dirsize-'));
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('sums every file, nested directories included', async () => {
		await fs.writeFile(path.join(root, 'a.bin'), Buffer.alloc(100));
		await fs.mkdir(path.join(root, 'nested', 'deeper'), { recursive: true });
		await fs.writeFile(path.join(root, 'nested', 'b.bin'), Buffer.alloc(250));
		await fs.writeFile(path.join(root, 'nested', 'deeper', 'c.bin'), Buffer.alloc(7));

		expect(await directoryBytes(root)).toBe(357);
	});

	it('reads a missing directory as zero', async () => {
		expect(await directoryBytes(path.join(root, 'never-installed'))).toBe(0);
	});

	it('reads a path that is a file, not a directory, as zero', async () => {
		const file = path.join(root, 'plain.txt');
		await fs.writeFile(file, 'hello');
		expect(await directoryBytes(file)).toBe(0);
	});

	it.skipIf(process.platform === 'win32')('does not follow symbolic links', async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-dirsize-outside-'));
		try {
			await fs.writeFile(path.join(outside, 'big.bin'), Buffer.alloc(10_000));
			await fs.writeFile(path.join(root, 'own.bin'), Buffer.alloc(10));
			await fs.symlink(path.join(outside, 'big.bin'), path.join(root, 'link.bin'));
			await fs.symlink(outside, path.join(root, 'linked-dir'));

			expect(await directoryBytes(root)).toBe(10);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});
