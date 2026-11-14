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

import type { NativeRuntimeId } from '../../../shared/local-models/native-runtimes';
import {
	dependencyInstallPath,
	nativeRuntimeArtifactBytes,
	type NativeRuntimeArtifact,
	type NativeRuntimeDependency,
} from '../../../shared/local-models/runtime-artifacts';
import { logger } from '../../utils/logger';
import {
	artifactForThisPlatform,
	runtimeDir,
	runtimeStagingDir,
	writeRuntimeManifest,
	type RuntimeManifest,
} from './runtime-store';

const LOG_CONTEXT = 'LocalModels';

/** The tarball's name inside the staging directory. Deleted after extraction. */
const PAYLOAD_FILENAME = 'payload.tgz';

/** Progress push interval. Matches the model downloader's ~4 Hz, for one cadence. */
export const RUNTIME_PROGRESS_INTERVAL_MS = 250;

export type RuntimeInstallPhase = 'downloading' | 'verifying' | 'extracting' | 'done';

export interface RuntimeInstallProgress {
	runtimeId: NativeRuntimeId;
	phase: RuntimeInstallPhase;
	/** Bytes downloaded so far, across the payload and its dependencies. */
	bytes: number;
	/** Total bytes expected, from the catalog: the payload plus every dependency. */
	totalBytes: number;
}

export type RuntimeProgressListener = (progress: RuntimeInstallProgress) => void;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Progress for the whole transaction: the payload and every dependency count
 * against one total.
 *
 * Per-tarball progress would be a bar that refills 117 times for llama, whose
 * payload is the smallest download of the set; the user is waiting for the sum.
 */
interface InstallProgressTracker {
	readonly totalBytes: number;
	/** Count downloaded bytes, emitting `downloading` at most every interval. */
	add(bytes: number): void;
	/** Emit a phase change immediately, with the running byte count. */
	phase(phase: RuntimeInstallPhase): void;
}

function createProgressTracker(
	artifact: NativeRuntimeArtifact,
	onProgress: RuntimeProgressListener | undefined
): InstallProgressTracker {
	const totalBytes = nativeRuntimeArtifactBytes(artifact);
	let received = 0;
	let lastEmit = 0;
	const emit = (phase: RuntimeInstallPhase) =>
		onProgress?.({ runtimeId: artifact.runtimeId, phase, bytes: received, totalBytes });
	return {
		totalBytes,
		add(bytes) {
			received += bytes;
			const now = Date.now();
			if (now - lastEmit < RUNTIME_PROGRESS_INTERVAL_MS) return;
			lastEmit = now;
			emit('downloading');
		},
		phase(phase) {
			if (phase === 'done') received = totalBytes;
			emit(phase);
		},
	};
}

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

	constructor(runtimeId: string, expected: string, actual: string) {
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

	const progress = createProgressTracker(artifact, options.onProgress);
	try {
		const payload = path.join(staging, PAYLOAD_FILENAME);
		await downloadPayload(artifact, payload, options, progress);
		await extractPayload(artifact, payload, staging);
		await fs.rm(payload, { force: true });
		// Inside the transaction, so a dependency that will not download leaves no
		// promoted install behind. A runtime without its dependencies extracts
		// cleanly, verifies cleanly, reports itself installed, and then throws
		// MODULE_NOT_FOUND on the first import - after the whole download.
		await installDependencies(artifact, staging, options, progress);

		// Once, after every tarball: each hash was already checked as it landed,
		// and a phase flipped per dependency reads as a flickering label for llama.
		progress.phase('verifying');
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

		progress.phase('done');
		logger.info(`Installed the ${id} native runtime from ${artifact.url}`, LOG_CONTEXT);
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
	options: RuntimeInstallOptions,
	progress: InstallProgressTracker
): Promise<void> {
	await downloadVerified(
		{ url: artifact.url, sha256: artifact.sha256 },
		artifact.runtimeId,
		destination,
		options,
		progress
	);
}

/**
 * Stream one tarball to disk, hashing as it goes, and refuse it if the bytes are
 * not what the catalog promised.
 *
 * Shared by the runtime payload and its dependency payloads: both are code that
 * will later be imported into the main process, so both get the same treatment.
 * The model server's engine installer reuses it too, because its binaries are code
 * the app executes.
 * Hashing DURING the stream rather than re-reading afterwards means a mismatched
 * payload is never on disk in a readable state for longer than the write itself.
 */
export async function downloadVerified(
	source: { url: string; sha256: string },
	runtimeId: string,
	destination: string,
	options: Pick<RuntimeInstallOptions, 'fetchImpl' | 'signal'>,
	progress: Pick<InstallProgressTracker, 'add'>
): Promise<void> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	const response = await fetchImpl(source.url, { signal: options.signal });
	if (!response.ok || !response.body) {
		throw new Error(`Downloading ${source.url} failed with HTTP ${response.status}.`);
	}

	const hash = createHash('sha256');
	const stream = Readable.fromWeb(response.body as never);
	stream.on('data', (chunk: Buffer) => {
		hash.update(chunk);
		progress.add(chunk.length);
	});

	await pipeline(stream, createWriteStream(destination));

	const actual = hash.digest('hex');
	if (actual !== source.sha256) {
		await fs.rm(destination, { force: true });
		throw new RuntimeHashMismatchError(runtimeId, source.sha256, actual);
	}
}

/**
 * Resolve a catalog-relative directory under the staging root, refusing one that
 * climbs out of it.
 *
 * The table is ours, so this is a guard against a typo rather than an attacker;
 * the cost of the typo it catches is a package extracted somewhere outside the
 * runtime directory, which nothing would ever clean up.
 */
function resolveInsideRoot(root: string, relative: string): string {
	const segments = relative.split('/').filter((segment) => segment.length > 0);
	if (segments.some((segment) => segment === '..' || segment === '.')) {
		throw new Error(`Runtime install path escapes the install root: ${relative}`);
	}
	return path.join(root, ...segments);
}

/**
 * Fetch each declared dependency into its install path under the staging root:
 * `node_modules/<name>`, or the nested directory npm would have used.
 *
 * Placed there rather than rewritten into the entry point so ordinary node
 * resolution finds them, which means the loader stays a plain dynamic import and
 * the installed tree looks exactly like an `npm install` would have produced.
 * Nothing is filtered out of a dependency archive unless the catalog says so
 * (`keep`): these are mostly small pure-JS packages, and guessing which of their
 * files matter is how a lazily-required module goes missing months later.
 *
 * Sequential on purpose. The tarballs are small, so parallelism buys little,
 * and a strict order is what makes a failure name one package rather than
 * whichever of several concurrent downloads happened to lose.
 */
async function installDependencies(
	artifact: NativeRuntimeArtifact,
	staging: string,
	options: RuntimeInstallOptions,
	progress: InstallProgressTracker
): Promise<void> {
	// One download per URL. npm nests the same version under several dependents
	// (`ansi-regex@5.0.1` three times for llama); each copy is the same bytes.
	const fetched = new Map<string, string>();
	try {
		for (const dependency of artifact.dependencies) {
			const target = resolveInsideRoot(staging, dependencyInstallPath(dependency));
			await fs.mkdir(target, { recursive: true });

			let payload = fetched.get(dependency.url);
			if (!payload) {
				payload = path.join(staging, `dependency-${fetched.size}.tgz`);
				await downloadVerified(dependency, artifact.runtimeId, payload, options, progress);
				fetched.set(dependency.url, payload);
			}
			await extractDependency(dependency, payload, target);
		}
	} finally {
		await Promise.all([...fetched.values()].map((payload) => fs.rm(payload, { force: true })));
	}
}

/** Unpack one verified dependency tarball, honouring its `keep` list if any. */
async function extractDependency(
	dependency: NativeRuntimeDependency,
	payload: string,
	target: string
): Promise<void> {
	const keep = dependency.keep;
	await tar.x({
		file: payload,
		cwd: target,
		strip: 1,
		...(keep
			? { filter: (entryPath: string) => shouldKeepArchiveEntry(entryPath, 1, keep) !== null }
			: {}),
	});
}

/** Unpack the verified tarball, writing only this platform's subtree. */
async function extractPayload(
	artifact: NativeRuntimeArtifact,
	payload: string,
	staging: string
): Promise<void> {
	const target = resolveInsideRoot(staging, artifact.installPath);
	await fs.mkdir(target, { recursive: true });
	await tar.x({
		file: payload,
		cwd: target,
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

export async function directoryBytes(target: string): Promise<number> {
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
