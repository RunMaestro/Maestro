import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { isWindows } from '../../platformDetection';
import { atomicWriteFile } from '../storage/atomic-json-store';
import type { TranslationFs } from './fs-port';

function alreadyExists(file: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`EEXIST: file already exists, open '${file}'`), {
		code: 'EEXIST',
		syscall: 'open',
		path: file,
	});
}

/**
 * On POSIX, `O_CREAT | O_EXCL` never follows a symlink in the last component.
 * On Windows `wx` is `CREATE_NEW`, which DOES follow one: a dangling link (or
 * junction) at `file` makes it create, and then write, the link's target
 * wherever that is. So on Windows anything already at `file`, link or not, is
 * refused before the open.
 */
async function refuseExistingEntryOnWindows(file: string): Promise<void> {
	if (!isWindows()) return;
	try {
		await fs.lstat(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	throw alreadyExists(file);
}

/**
 * The Windows half of the same guard, for a link swapped in between the check
 * and the open: the entry named `file` must be the file the handle created.
 * On a mismatch nothing is journaled or written; the empty file the open made
 * at the link's target cannot be removed safely, since its path is not known.
 */
async function assertCreatedInPlaceOnWindows(file: string, handle: fs.FileHandle): Promise<void> {
	if (!isWindows()) return;
	const [opened, named] = await Promise.all([
		handle.stat({ bigint: true }),
		fs.lstat(file, { bigint: true }),
	]);
	if (named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) {
		throw alreadyExists(file);
	}
}

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
		await refuseExistingEntryOnWindows(file);
		const handle = await fs.open(file, 'wx', options?.mode ?? 0o600);
		try {
			await assertCreatedInPlaceOnWindows(file, handle);
			await options?.onCreated?.();
			await handle.writeFile(bytes);
			if (options?.durable) await handle.sync();
		} finally {
			await handle.close();
		}
	},
	atomicWrite: (file, bytes, options) => atomicWriteFile(file, bytes, options),
	unlink: (file) => fs.unlink(file),
	rmdir: (directory) => fs.rmdir(directory),
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
