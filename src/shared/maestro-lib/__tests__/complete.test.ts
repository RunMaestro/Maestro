import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { completeDirectoryPath } from '../paths/complete';

describe('completeDirectoryPath', () => {
	let root: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-complete-')));
		for (const dir of ['Projects', 'Programs', 'photos', '.config', 'Projects/maestro']) {
			fs.mkdirSync(path.join(root, dir), { recursive: true });
		}
		fs.writeFileSync(path.join(root, 'Prose.txt'), 'a file is never a working directory');
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('lists the directories that start with the last segment, sorted, each ending in a separator', () => {
		expect(completeDirectoryPath(`${root}/Pro`)).toEqual([
			`${root}/Programs/`,
			`${root}/Projects/`,
		]);
	});

	it('matches without regard to case', () => {
		expect(completeDirectoryPath(`${root}/pro`)).toEqual([
			`${root}/Programs/`,
			`${root}/Projects/`,
		]);
	});

	it('leaves out files', () => {
		expect(completeDirectoryPath(`${root}/Pro`).some((entry) => entry.includes('Prose'))).toBe(
			false
		);
	});

	it('follows a link to a directory, and skips a link to a file or to nothing', () => {
		try {
			fs.symlinkSync(path.join(root, 'Projects'), path.join(root, 'ProLink'));
			fs.symlinkSync(path.join(root, 'Prose.txt'), path.join(root, 'ProFileLink'));
			fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'ProDangling'));
		} catch {
			return; // Creating a symlink needs a privilege some Windows runners lack.
		}
		expect(completeDirectoryPath(`${root}/Pro`)).toEqual([
			`${root}/Programs/`,
			`${root}/Projects/`,
			`${root}/ProLink/`,
		]);
	});

	it('lists the children of a path that ends in a separator', () => {
		expect(completeDirectoryPath(`${root}/Projects/`)).toEqual([`${root}/Projects/maestro/`]);
	});

	it('hides dot directories until the dot is typed', () => {
		expect(completeDirectoryPath(`${root}/`)).not.toContain(`${root}/.config/`);
		expect(completeDirectoryPath(`${root}/.`)).toEqual([`${root}/.config/`]);
	});

	it('keeps a leading ~ as typed', () => {
		expect(completeDirectoryPath('~/Proj', { homeDir: root })).toEqual(['~/Projects/']);
		expect(completeDirectoryPath('~', { homeDir: root })).toContain('~/Projects/');
	});

	it('caps the list', () => {
		expect(completeDirectoryPath(`${root}/`, { limit: 2 })).toHaveLength(2);
	});

	it('returns nothing for input it cannot complete, and never throws', () => {
		expect(completeDirectoryPath('')).toEqual([]);
		expect(completeDirectoryPath('relative/path')).toEqual([]);
		expect(completeDirectoryPath('plain')).toEqual([]);
		expect(completeDirectoryPath(`${root}/missing/x`)).toEqual([]);
		expect(completeDirectoryPath(`${root}/Prose.txt/x`)).toEqual([]);
	});
});
