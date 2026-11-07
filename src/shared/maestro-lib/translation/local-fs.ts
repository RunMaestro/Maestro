import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { atomicWriteFile } from '../storage/atomic-json-store';
import type { TranslationFs } from './fs-port';

/** Preserve the native local operations, including exclusive ownership before journal updates. */
export const localTranslationFs: TranslationFs = {
	readFile: (file) => fs.readFile(file),
	readdir: (directory, options) => fs.readdir(directory, options),
	stat: (file) => fs.stat(file),
	lstat: (file) => fs.lstat(file),
	realpath: (file) => fs.realpath(file),
	mkdir: async (directory, options) => {
		await fs.mkdir(directory, options);
	},
	createExclusive: async (file, bytes, options) => {
		const handle = await fs.open(file, 'wx', options?.mode ?? 0o600);
		try {
			await options?.onCreated?.();
			await handle.writeFile(bytes);
			if (options?.durable) await handle.sync();
		} finally {
			await handle.close();
		}
	},
	atomicWrite: (file, bytes, options) => atomicWriteFile(file, bytes, options),
	unlink: (file) => fs.unlink(file),
	symlink: (target, file) => fs.symlink(target, file),
	readlink: (file) => fs.readlink(file),
	exists: async (file) => {
		try {
			await fs.stat(file);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
			throw error;
		}
	},
};

/** The existing synchronous local launch binding cannot use an asynchronous transport. */
export const localTranslationFsSync = {
	lstat: (file: string) => syncFs.lstatSync(file),
	readFile: (file: string) => syncFs.readFileSync(file, 'utf8'),
};
