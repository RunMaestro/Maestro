import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
	default: {
		stat: vi.fn(),
		readdir: vi.fn(),
	},
}));

import fs from 'fs/promises';
import { resolveDirentType } from '../../../main/utils/dirent-utils';

// Helper to build a Dirent-like object with the flags we care about
function makeDirent(opts: {
	name: string;
	isDir?: boolean;
	isFile?: boolean;
	isSymlink?: boolean;
}) {
	return {
		name: opts.name,
		isDirectory: () => opts.isDir ?? false,
		isFile: () => opts.isFile ?? false,
		isSymbolicLink: () => opts.isSymlink ?? false,
	} as any;
}

describe('resolveDirentType', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns dir/file flags directly for non-symlink entries', async () => {
		const dir = makeDirent({ name: 'folder', isDir: true });
		const file = makeDirent({ name: 'readme.md', isFile: true });

		expect(await resolveDirentType(dir, '/x/folder')).toEqual({
			isDirectory: true,
			isFile: false,
			isBrokenSymlink: false,
		});
		expect(await resolveDirentType(file, '/x/readme.md')).toEqual({
			isDirectory: false,
			isFile: true,
			isBrokenSymlink: false,
		});
		// Non-symlinks never touch the filesystem
		expect(fs.stat).not.toHaveBeenCalled();
	});

	it('resolves a symlink that targets a directory', async () => {
		vi.mocked(fs.stat).mockResolvedValue({
			isDirectory: () => true,
			isFile: () => false,
		} as any);

		const entry = makeDirent({ name: 'linked-folder', isSymlink: true });
		const result = await resolveDirentType(entry, '/x/linked-folder');

		expect(fs.stat).toHaveBeenCalledWith('/x/linked-folder');
		expect(result).toEqual({
			isDirectory: true,
			isFile: false,
			isBrokenSymlink: false,
		});
	});

	it('resolves a symlink that targets a regular file', async () => {
		vi.mocked(fs.stat).mockResolvedValue({
			isDirectory: () => false,
			isFile: () => true,
		} as any);

		const entry = makeDirent({ name: 'linked-doc.md', isSymlink: true });
		const result = await resolveDirentType(entry, '/x/linked-doc.md');

		expect(result).toEqual({
			isDirectory: false,
			isFile: true,
			isBrokenSymlink: false,
		});
	});

	it('flags broken symlinks (fs.stat fails) without throwing', async () => {
		vi.mocked(fs.stat).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

		const entry = makeDirent({ name: 'broken', isSymlink: true });
		const result = await resolveDirentType(entry, '/x/broken');

		expect(result).toEqual({
			isDirectory: false,
			isFile: false,
			isBrokenSymlink: true,
		});
	});
});
