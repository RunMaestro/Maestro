/**
 * Download, verify, and lay out the Maestro model server's engine.
 *
 * The same transaction as `installNativeRuntime`, and for the same reasons (see
 * `runtime-installer.ts`): every asset is hashed as it streams and refused before
 * anything is unpacked, extraction happens in a staging directory, and the manifest
 * is written last, so an interrupted install leaves wreckage the next install
 * deletes rather than an engine that passes an existence check and fails to start.
 *
 * What differs is the payload. It is a native executable, not a Node module, and
 * it arrives as `.tar.gz` (macOS, Linux) or `.zip` (Windows) from a GitHub release.
 * A CUDA build is two assets that extract into one directory. Zips go through
 * `extractZipTo`, which refuses a zip-slip name and a symlink on the path.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as tar from 'tar';

import {
	LLAMA_SERVER_RELEASE,
	selectServerBuild,
	serverBuildDownloadBytes,
	type ServerBuildChoice,
	type ServerEngineAsset,
} from '../../../shared/local-models/server-engine';
import { logger } from '../../utils/logger';
import { extractZipTo } from '../../utils/zip-archive';
import {
	directoryBytes,
	downloadVerified,
	RUNTIME_PROGRESS_INTERVAL_MS,
	type FetchLike,
} from '../runtime/runtime-installer';
import { exists } from '../runtime/runtime-store';
import { checkServerAccelerator, type AcceleratorCheckOptions } from './accelerator';
import {
	serverEngineDir,
	serverEngineStagingDir,
	writeServerEngineManifest,
	type ServerEngineManifest,
} from './engine-store';

const LOG_CONTEXT = 'LocalModels';

export type ServerEngineInstallPhase = 'downloading' | 'verifying' | 'extracting' | 'done';

export interface ServerEngineInstallProgress {
	phase: ServerEngineInstallPhase;
	/** Bytes downloaded so far, across every asset of the build. */
	bytes: number;
	/** Total bytes expected, from the pinned table. */
	totalBytes: number;
}

export interface ServerEngineInstallOptions {
	/** Injected in tests. Production uses global fetch. */
	fetchImpl?: FetchLike;
	onProgress?: (progress: ServerEngineInstallProgress) => void;
	signal?: AbortSignal;
	/** Default to the running process. Tests pass other values to install a foreign layout. */
	platform?: string;
	arch?: string;
	/** Injected in tests, where the "binary" is a text file. */
	runListDevices?: AcceleratorCheckOptions['runListDevices'];
	/**
	 * Called once the new build is downloaded, verified and extracted, right
	 * before it replaces the installed one. The model service stops a running
	 * server here, so the server keeps serving through the download and is never
	 * running from a directory that is being deleted (Windows refuses to delete
	 * a running `.exe`).
	 */
	beforePromote?: () => Promise<void>;
}

/** A choice that has no build on this platform. Names the platform and the choice. */
export class ServerBuildUnavailableError extends Error {
	constructor(platform: string, arch: string, choice: ServerBuildChoice) {
		super(`There is no "${choice}" model server build for ${platform}-${arch}.`);
		this.name = 'ServerBuildUnavailableError';
	}
}

/** An archive that extracted without producing the executable it promised. */
export class ServerBinaryMissingError extends Error {
	constructor(binary: string) {
		super(`The model server download did not contain ${binary}.`);
		this.name = 'ServerBinaryMissingError';
	}
}

export async function installServerEngine(
	choice: ServerBuildChoice,
	options: ServerEngineInstallOptions = {}
): Promise<ServerEngineManifest> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const selected = selectServerBuild(platform, arch, choice);
	if (!selected) throw new ServerBuildUnavailableError(platform, arch, choice);

	const staging = serverEngineStagingDir();
	// Wreckage of an install that was killed. Resuming into it would mix bytes
	// nobody verified with ones somebody did.
	await fs.rm(staging, { recursive: true, force: true });
	await fs.mkdir(staging, { recursive: true });

	const totalBytes = serverBuildDownloadBytes(selected);
	let received = 0;
	let lastEmit = 0;
	const emit = (phase: ServerEngineInstallPhase) =>
		options.onProgress?.({ phase, bytes: received, totalBytes });
	const progress = {
		add(bytes: number) {
			received += bytes;
			const now = Date.now();
			if (now - lastEmit < RUNTIME_PROGRESS_INTERVAL_MS) return;
			lastEmit = now;
			emit('downloading');
		},
	};

	try {
		for (const [index, entry] of selected.assets.entries()) {
			const archive = path.join(staging, `asset-${index}.${entry.format}`);
			await downloadVerified(entry, 'llama-server', archive, options, progress);
			emit('extracting');
			await extractAsset(entry, archive, staging, selected.stripComponents);
			await fs.rm(archive, { force: true });
		}

		emit('verifying');
		const binary = path.join(staging, selected.binary);
		if (!(await exists(binary))) throw new ServerBinaryMissingError(selected.binary);
		// tar keeps the mode bits, a zip has none. A server that cannot be executed
		// fails at spawn with EACCES, far from the download that caused it.
		if (!platform.startsWith('win32')) await fs.chmod(binary, 0o755);

		await options.beforePromote?.();
		const target = serverEngineDir();
		await fs.rm(target, { recursive: true, force: true });
		await fs.rename(staging, target);

		// Ask the engine what it will compute on, while the user is still looking at
		// the install. A Vulkan build with no driver behind it is reported here, not
		// discovered later as a server that is mysteriously slow.
		const accelerator = await checkServerAccelerator(
			path.join(target, selected.binary),
			selected.kind,
			{
				runListDevices: options.runListDevices,
				platform,
				arch,
			}
		);

		const manifest: ServerEngineManifest = {
			release: LLAMA_SERVER_RELEASE,
			platform: selected.platform,
			choice,
			kind: selected.kind,
			label: selected.label,
			assets: selected.assets.map((entry) => ({ name: entry.name, sha256: entry.sha256 })),
			binary: selected.binary,
			installedAt: Date.now(),
			bytes: await directoryBytes(target),
			accelerator,
		};
		await writeServerEngineManifest(manifest);

		received = totalBytes;
		emit('done');
		logger.info(
			`Installed the llama-server engine (${selected.label}, ${LLAMA_SERVER_RELEASE})`,
			LOG_CONTEXT
		);
		return manifest;
	} catch (error) {
		await fs.rm(staging, { recursive: true, force: true });
		throw error;
	}
}

async function extractAsset(
	entry: ServerEngineAsset,
	archive: string,
	destination: string,
	stripComponents: number
): Promise<void> {
	if (entry.format === 'zip') {
		extractZipTo(
			archive,
			destination,
			entry.maxExpandedBytes ? { maxOriginalSize: entry.maxExpandedBytes } : undefined
		);
		return;
	}
	await tar.x({ file: archive, cwd: destination, strip: stripComponents });
}
