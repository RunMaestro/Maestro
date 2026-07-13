import {
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
	type FileHandle,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RuntimeFileSystem } from './runtime-installer';

/** Production filesystem boundary for the managed installer; tests inject an in-memory implementation instead. */
export const nodeRuntimeFileSystem: RuntimeFileSystem = {
	async mkdir(path: string): Promise<void> {
		await mkdir(path, { recursive: true });
	},
	async writeFile(path: string, content: Uint8Array): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	},
	async readFile(path: string): Promise<Uint8Array> {
		return readFile(path);
	},
	async exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch (error) {
			if (isMissingFileError(error)) return false;
			throw error;
		}
	},
	async rename(from: string, to: string): Promise<void> {
		await rename(from, to);
	},
	async remove(path: string): Promise<void> {
		await rm(path, { recursive: true, force: true });
	},
	async acquireLock(path: string): Promise<() => Promise<void>> {
		await mkdir(dirname(path), { recursive: true });
		let handle: FileHandle;
		try {
			handle = await open(path, 'wx');
		} catch (error) {
			if (isAlreadyExistsError(error)) throw new Error('managed runtime install is already locked');
			throw error;
		}
		return async (): Promise<void> => {
			await handle.close();
			await rm(path, { force: true });
		};
	},
};

function isMissingFileError(error: unknown): boolean {
	return isNodeError(error) && error.code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): boolean {
	return isNodeError(error) && error.code === 'EEXIST';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === 'object' && error !== null && 'code' in error;
}
