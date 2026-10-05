import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The rename is the only step a test cannot make fail on a real disk, so it is
// the one function the mock routes; everything else stays the real fs.
const hooks = vi.hoisted(() => ({
	rename: null as null | ((from: string, to: string) => Promise<void>),
}));

vi.mock('fs/promises', async () => {
	const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
	const rename = (from: string, to: string) =>
		hooks.rename ? hooks.rename(from, to) : actual.rename(from, to);
	return { ...actual, rename, default: { ...actual, rename } };
});

import { atomicWriteFile, atomicWriteJson } from '../atomic-write';

function errnoError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe('atomicWriteFile', () => {
	let dir: string;
	let target: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-atomic-write-'));
		target = path.join(dir, 'store.json');
		hooks.rename = null;
	});

	afterEach(() => {
		hooks.rename = null;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('replaces the file wholesale and leaves no temp file behind', async () => {
		await atomicWriteFile(target, 'a much longer first version');
		await atomicWriteFile(target, 'short');
		expect(fs.readFileSync(target, 'utf-8')).toBe('short');
		expect(fs.readdirSync(dir)).toEqual(['store.json']);
	});

	it('leaves the original intact when the process dies between the temp write and the rename', async () => {
		await atomicWriteFile(target, 'original');
		hooks.rename = () => Promise.reject(errnoError('EIO'));

		await expect(atomicWriteFile(target, 'replacement')).rejects.toThrow('EIO');

		expect(fs.readFileSync(target, 'utf-8')).toBe('original');
	});

	it('retries a transient EPERM or EBUSY rename, then succeeds', async () => {
		let calls = 0;
		hooks.rename = async (from, to) => {
			calls++;
			if (calls === 1) throw errnoError('EPERM');
			if (calls === 2) throw errnoError('EBUSY');
			fs.renameSync(from, to);
		};

		await atomicWriteFile(target, 'landed');

		expect(calls).toBe(3);
		expect(fs.readFileSync(target, 'utf-8')).toBe('landed');
	});

	it('gives up after three retries and keeps the original', async () => {
		await atomicWriteFile(target, 'original');
		let calls = 0;
		hooks.rename = () => {
			calls++;
			return Promise.reject(errnoError('EBUSY'));
		};

		await expect(atomicWriteFile(target, 'replacement')).rejects.toThrow('EBUSY');

		expect(calls).toBe(4);
		expect(fs.readFileSync(target, 'utf-8')).toBe('original');
	}, 10_000);
});

describe('atomicWriteJson', () => {
	it('refuses a payload that does not serialize, before touching the target', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-atomic-write-'));
		try {
			const target = path.join(dir, 'store.json');
			fs.writeFileSync(target, '{"keep":true}');
			await expect(atomicWriteJson(target, undefined)).rejects.toThrow(/Refusing to write/);
			expect(fs.readFileSync(target, 'utf-8')).toBe('{"keep":true}');
			expect(fs.readdirSync(dir)).toEqual(['store.json']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
