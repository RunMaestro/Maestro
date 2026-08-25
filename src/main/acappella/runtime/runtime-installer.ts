/**
 * Download, verify, and lay out a native runtime payload.
 *
 * The transaction, in the order it must happen:
 *
 *   1. Stream the tarball to `<id>.staging/payload.tgz`, hashing as it arrives.
 *   2. Compare the hash to the catalog. A mismatch deletes everything and stops.
 *   3. Extract into `<id>.staging/`, keeping only this platform's subtree.
 *   4. Prove the binary the artifact promised is really there.
 *   5. Replace `<id>/` with the staging directory, then write the manifest.
 *
 * **Nothing is visible at the install path until step 5.** That ordering is the
 * whole design: `isRuntimeInstalled()` answers by reading the manifest, so the
 * manifest is the commit record of this transaction and is written last, after
 * the bytes are proven and in place. A killed app leaves a staging directory,
 * which the next install deletes, rather than a half-extracted engine that passes
 * an existence check and detonates later inside a dlopen.
 *
 * **Why the hash is checked before extraction, not after.** These payloads carry
 * executable code that the app will dlopen. Unpacking unverified bytes onto disk
 * and checking afterwards means the window where a tampered archive exists on the
 * user's machine is a window where it can be executed by something else. Verify
 * first, unpack second, and there is no window.
 *
 * The extraction FILTER is the other half of the size argument in
 * `runtime-artifacts.ts`: the ONNX Runtime tarball carries five platforms, and
 * only the running one is written to disk. That logic is
 * {@link shouldKeepArchiveEntry}, kept pure and separately tested, because a
 * filter that is wrong in the permissive direction silently costs a user 220 MB
 * and a filter that is wrong in the strict direction produces an install that is
 * missing its binary.
 */

import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';

import type { NativeRuntimeId } from '../../../shared/acappella/native-runtimes';
import type { NativeRuntimeArtifact } from '../../../shared/acappella/runtime-artifacts';
import { logger } from '../../utils/logger';
import {
	artifactForThisPlatform,
	runtimeDir,
	runtimeStagingDir,
	writeRuntimeManifest,
	type RuntimeManifest,
} from './runtime-store';

const LOG_CONTEXT = 'ACappella';

/** The tarball's name inside the staging directory. Deleted after extraction. */
const PAYLOAD_FILENAME = 'payload.tgz';

/** Progress push interval. Matches the model downloader's ~4 Hz, for one cadence. */
export const RUNTIME_PROGRESS_INTERVAL_MS = 250;

export type RuntimeInstallPhase = 'downloading' | 'verifying' | 'extracting' | 'done';

export interface RuntimeInstallProgress {
	runtimeId: NativeRuntimeId;
	phase: RuntimeInstallPhase;
	/** Bytes downloaded so far. Zero outside the download phase. */
	bytes: number;
	/** Total bytes expected, from the catalog. */
	totalBytes: number;
}

export type RuntimeProgressListener = (progress: RuntimeInstallProgress) => void;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RuntimeInstallOptions {
	/** Injected in tests. Production uses global fetch. */
	fetchImpl?: FetchLike;
	onProgress?: RuntimeProgressListener;
	signal?: AbortSignal;
}

/** A download whose bytes are not what the catalog promised. Never retried. */
export class RuntimeHashMismatchError extends Error {
	readonly expected: string;
	readonly actual: string;

	constructor(runtimeId: NativeRuntimeId, expected: string, actual: string) {
		super(
			`Downloaded ${runtimeId} runtime does not match the expected checksum. ` +
				`Expected ${expected}, got ${actual}.`
		);
		this.name = 'RuntimeHashMismatchError';
		this.expected = expected;
		this.actual = actual;
	}
}

/** An archive that extracted without producing the binary it promised. */
export class RuntimeBinaryMissingError extends Error {
	constructor(runtimeId: NativeRuntimeId, binary: string) {
		super(`The ${runtimeId} runtime payload did not contain ${binary}.`);
		this.name = 'RuntimeBinaryMissingError';
	}
}

/**
 * Should this archive entry be written to disk?
 *
 * Pure, and separated from the extraction so it can be tested against real
 * archive paths with no tarball and no filesystem. Three jobs:
 *
 *   - Drop the leading `package/` that every npm tarball carries
 *     (`stripComponents`), so `keep` is written in terms the artifact's other
 *     paths already use rather than repeating the prefix everywhere.
 *   - Keep an entry only when it is inside one of the `keep` prefixes. Matching
 *     is on path SEGMENTS, so `bin/napi-v6/darwin/arm64` cannot also admit a
 *     sibling directory whose name merely starts with `arm64`.
 *   - Refuse anything that climbs out of the root. node-tar guards this too;
 *     the check is repeated here because this function is the one place that has
 *     both the path and the intent, and a traversal that reaches a dlopen target
 *     is the worst failure this module could have.
 *
 * @param archivePath Entry path exactly as it appears in the archive.
 * @returns The path to write, relative to the install root, or null to skip.
 */
export function shouldKeepArchiveEntry(
	archivePath: string,
	stripComponents: number,
	keep: readonly string[]
): string | null {
	// Archive paths are POSIX regardless of the platform unpacking them.
	const segments = archivePath.split('/').filter((segment) => segment.length > 0);
	if (segments.length <= stripComponents) return null;

	const stripped = segments.slice(stripComponents);
	if (stripped.some((segment) => segment === '..' || segment === '.')) return null;

	const relative = stripped.join('/');
	for (const prefix of keep) {
		const prefixSegments = prefix.split('/').filter((segment) => segment.length > 0);
		if (prefixSegments.length > stripped.length) continue;
		const matches = prefixSegments.every((segment, index) => stripped[index] === segment);
		if (matches) return relative;
	}
	return null;
}

/**
 * Install a runtime for the platform this process is running on.
 *
 * Resolves to the manifest that was written. Throws on every failure, because a
 * caller that asked for an install wants to know why it did not happen; the
 * READINESS question is `isRuntimeInstalled()`, and it is deliberately somewhere
 * else so that asking it can never start a download.
 */
export async function installNativeRuntime(
	id: NativeRuntimeId,
	options: RuntimeInstallOptions = {}
): Promise<RuntimeManifest> {
	const artifact = artifactForThisPlatform(id);
	if (!artifact) {
		throw new Error(
			`There is no downloadable ${id} runtime for ${process.platform}-${process.arch}.`
		);
	}

	const staging = runtimeStagingDir(id);
	// A staging directory here is the wreckage of an install that was killed.
	// Removing it beats resuming into it: the tarball's hash covers the whole
	// file, and half a tarball plus a fresh tail is not a file anyone verified.
	await fs.rm(staging, { recursive: true, force: true });
	await fs.mkdir(staging, { recursive: true });

	try {
		const payload = path.join(staging, PAYLOAD_FILENAME);
		await downloadPayload(artifact, payload, options);
		await extractPayload(artifact, payload, staging);
		await fs.rm(payload, { force: true });

		const binary = path.join(staging, artifact.binary);
		if (!(await pathExists(binary))) {
			throw new RuntimeBinaryMissingError(id, artifact.binary);
		}

		// Promote. The old directory goes first: rename onto an existing
		// directory fails on every platform, and leaving the previous version
		// half-merged with the new one is how a stale binary survives an upgrade.
		const target = runtimeDir(id);
		await fs.rm(target, { recursive: true, force: true });
		await fs.rename(staging, target);

		const manifest: RuntimeManifest = {
			runtimeId: id,
			version: versionFromUrl(artifact.url),
			platform: artifact.platform,
			sourceUrl: artifact.url,
			sha256: artifact.sha256,
			entry: artifact.entry,
			binary: artifact.binary,
			installedAt: Date.now(),
			bytes: await directoryBytes(target),
		};
		await writeRuntimeManifest(id, manifest);

		options.onProgress?.({
			runtimeId: id,
			phase: 'done',
			bytes: artifact.bytes,
			totalBytes: artifact.bytes,
		});
		logger.info(`Installed the ${id} voice runtime from ${artifact.url}`, LOG_CONTEXT);
		return manifest;
	} catch (error) {
		// Leave nothing behind. A failed install that leaves a staging directory
		// is disk the user cannot see and cannot reclaim from the UI.
		await fs.rm(staging, { recursive: true, force: true });
		throw error;
	}
}

/** Stream the tarball to disk, hashing as it goes, and verify before returning. */
async function downloadPayload(
	artifact: NativeRuntimeArtifact,
	destination: string,
	options: RuntimeInstallOptions
): Promise<void> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	const response = await fetchImpl(artifact.url, { signal: options.signal });
	if (!response.ok || !response.body) {
		throw new Error(`Downloading ${artifact.url} failed with HTTP ${response.status}.`);
	}

	const hash = createHash('sha256');
	let received = 0;
	let lastEmit = 0;

	const source = Readable.fromWeb(response.body as never);
	source.on('data', (chunk: Buffer) => {
		hash.update(chunk);
		received += chunk.length;
		const now = Date.now();
		if (now - lastEmit < RUNTIME_PROGRESS_INTERVAL_MS) return;
		lastEmit = now;
		options.onProgress?.({
			runtimeId: artifact.runtimeId,
			phase: 'downloading',
			bytes: received,
			totalBytes: artifact.bytes,
		});
	});

	await pipeline(source, createWriteStream(destination));

	options.onProgress?.({
		runtimeId: artifact.runtimeId,
		phase: 'verifying',
		bytes: received,
		totalBytes: artifact.bytes,
	});

	const actual = hash.digest('hex');
	if (actual !== artifact.sha256) {
		await fs.rm(destination, { force: true });
		throw new RuntimeHashMismatchError(artifact.runtimeId, artifact.sha256, actual);
	}
}

/** Unpack the verified tarball, writing only this platform's subtree. */
async function extractPayload(
	artifact: NativeRuntimeArtifact,
	payload: string,
	staging: string
): Promise<void> {
	await tar.x({
		file: payload,
		cwd: staging,
		strip: artifact.stripComponents,
		// node-tar calls this with the archive path, before `strip` is applied,
		// which is exactly what `shouldKeepArchiveEntry` expects: it does its own
		// stripping so the same call can also return the destination path and be
		// tested without a tarball.
		filter: (entryPath: string) =>
			shouldKeepArchiveEntry(entryPath, artifact.stripComponents, artifact.keep) !== null,
	});
}

/** `.../mac-arm64-metal-3.20.0.tgz` -> `3.20.0`. Empty when it does not parse. */
function versionFromUrl(url: string): string {
	const match = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(url);
	return match?.[1] ?? '';
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

async function directoryBytes(target: string): Promise<number> {
	let total = 0;
	const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const child = path.join(target, entry.name);
		if (entry.isDirectory()) {
			total += await directoryBytes(child);
			continue;
		}
		try {
			total += (await fs.stat(child)).size;
		} catch {
			// Raced with a delete. A size report is not worth failing over.
		}
	}
	return total;
}
