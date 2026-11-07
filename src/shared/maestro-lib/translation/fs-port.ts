import type { PlatformPath } from 'node:path';

/** Filesystem operations on the host where the provider runs. Archives stay local. */
export interface TranslationFsStat {
	size: number;
	mtimeMs: number;
	mode: number;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface TranslationFsWriteOptions {
	mode?: number;
	durable?: boolean;
}

export interface TranslationFs {
	/** Remote paths remain POSIX even when Maestro runs on Windows. */
	paths?: PlatformPath;
	readFile(file: string): Promise<Buffer>;
	/** Relative names, including descendants when recursive, without traversing directory links. */
	readdir(directory: string, options?: { recursive?: boolean }): Promise<string[]>;
	stat(file: string): Promise<TranslationFsStat>;
	lstat(file: string): Promise<TranslationFsStat>;
	realpath(file: string): Promise<string>;
	mkdir(directory: string, options: { recursive: true; mode?: number }): Promise<void>;
	/**
	 * EEXIST never changes the target or calls onCreated. Notify only after exclusive ownership
	 * is proved; local writes journal it before writing bytes. Failures may leave partial files.
	 * A transport with an uncertain acknowledgement must not claim ownership or retry.
	 */
	createExclusive(
		file: string,
		bytes: string | Buffer,
		options?: TranslationFsWriteOptions & { onCreated?: () => Promise<void> }
	): Promise<void>;
	atomicWrite(
		file: string,
		bytes: string | Buffer,
		options?: TranslationFsWriteOptions
	): Promise<void>;
	unlink(file: string): Promise<void>;
	symlink(target: string, file: string): Promise<void>;
	readlink(file: string): Promise<string>;
	/** False only for ENOENT; permission and transport failures must propagate. */
	exists(file: string): Promise<boolean>;
}
