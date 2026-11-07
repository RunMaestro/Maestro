import type { SshRemoteConfig } from '../shared/types';
import * as path from 'node:path';
import type { TranslationFs, TranslationFsStat } from '../shared/maestro-lib/translation/fs-port';
import {
	createExclusiveRemote,
	deleteRemote,
	lstatRemote,
	mkdirRemote,
	readBinaryFileRemoteAsBase64,
	readDirNamesRemote,
	readlinkRemote,
	realpathRemote,
	symlinkRemote,
	writeFileAtomicRemote,
	type RemoteFsDeps,
	type RemoteFsResult,
} from './utils/remote-fs';

/** Adapt the existing SSH transport without weakening errno or ownership semantics. */
export function createSshTranslationFs(
	remote: SshRemoteConfig,
	deps?: RemoteFsDeps
): TranslationFs {
	const unwrap = <T>(result: RemoteFsResult<T>): T => {
		if (result.success) return result.data as T;
		const message = result.error || 'Remote filesystem operation failed';
		const error: NodeJS.ErrnoException = new Error(message);
		error.code =
			result.code ??
			(/Permission denied/i.test(message)
				? 'EACCES'
				: /No such file|^(?:File|Path) not found:/i.test(message)
					? 'ENOENT'
					: 'EIO');
		throw error;
	};
	const lstat = async (file: string): Promise<TranslationFsStat> => {
		const result = unwrap(await lstatRemote(file, remote, deps));
		return {
			size: result.size,
			mtimeMs: result.mtime,
			mode: result.mode,
			isDirectory: () => result.type === 'directory',
			isSymbolicLink: () => result.type === 'symlink',
		};
	};
	const realpath = async (file: string) => {
		const resolved = unwrap(await realpathRemote(file, remote, deps));
		// GNU realpath may succeed for a missing final component; Node realpath does not.
		await lstat(resolved);
		return resolved;
	};
	const stat = async (file: string): Promise<TranslationFsStat> => {
		const info = await lstat(file);
		return info.isSymbolicLink() ? lstat(unwrap(await realpathRemote(file, remote, deps))) : info;
	};
	return {
		paths: path.posix,
		readFile: async (file) => {
			const encoded = unwrap(await readBinaryFileRemoteAsBase64(file, remote, deps));
			const bytes = Buffer.from(encoded, 'base64');
			if (bytes.toString('base64') !== encoded)
				throw new Error('Invalid remote base64 file payload');
			return bytes;
		},
		readdir: async (directory, options) =>
			unwrap(await readDirNamesRemote(directory, remote, options, deps)),
		stat,
		lstat,
		realpath,
		mkdir: async (directory, options) => {
			unwrap(await mkdirRemote(directory, remote, true, deps, options));
		},
		createExclusive: async (file, bytes, options) => {
			unwrap(
				await createExclusiveRemote(file, bytes, remote, deps, {
					mode: options?.mode,
					sync: options?.durable,
				})
			);
			// A lost acknowledgement cannot prove ownership. Only a successful exclusive
			// create permits the journal callback; never retry or remove uncertain writes.
			await options?.onCreated?.();
		},
		atomicWrite: async (file, bytes, options) => {
			unwrap(
				await writeFileAtomicRemote(
					file,
					bytes,
					remote,
					{ mode: options?.mode, sync: options?.durable },
					deps
				)
			);
		},
		unlink: async (file) => {
			unwrap(await deleteRemote(file, remote, false, deps));
		},
		symlink: async (target, file) => {
			unwrap(await symlinkRemote(target, file, remote, deps));
		},
		readlink: async (file) => unwrap(await readlinkRemote(file, remote, deps)),
		exists: async (file) => {
			try {
				await stat(file);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
				throw error;
			}
		},
	};
}
