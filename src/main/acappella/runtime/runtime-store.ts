/**
 * Where a downloaded native runtime lives, and whether it is really there.
 *
 *   userData/runtimes/acappella/<runtime-id>/
 *     manifest.json          - what was installed, from where, and when
 *     dist/ bins/ bin/ ...   - the kept subtree of the payload
 *
 * Deliberately a SIBLING of the model store rather than a directory inside it.
 * The two have different lifetimes and different reasons to be deleted: "reclaim
 * the disk my models are using" must not silently uninstall the engines, and a
 * runtime replaced on version bump must not disturb a 1 GB model that is still
 * current. Keeping them apart makes each delete mean one thing.
 *
 * The invariant, inherited from the model store because it is the property that
 * matters: **a runtime counts as installed only when its manifest exists AND the
 * binary the artifact promised is on disk.** A manifest alone is a claim; the
 * binary is the thing a dlopen needs. Checking both is what stops a half-extracted
 * payload from being reported as ready and then dying inside the loader, where
 * the error names a shared library rather than anything a user can act on.
 */

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
	getNativeRuntime,
	nativePlatformKey,
	type NativeRuntimeId,
} from '../../../shared/acappella/native-runtimes';
import {
	nativeRuntimeArtifact,
	type NativeRuntimeArtifact,
} from '../../../shared/acappella/runtime-artifacts';

/** Directory under userData. Also what the "remove runtimes" flow deletes. */
export const ACAPPELLA_RUNTIMES_DIRNAME = path.join('runtimes', 'acappella');

/** Written last, on success only, so its presence means the install finished. */
export const RUNTIME_MANIFEST_FILENAME = 'manifest.json';

/** Extraction target while a payload is being laid out. Promoted by rename. */
export const RUNTIME_STAGING_SUFFIX = '.staging';

/**
 * What a completed runtime install recorded about itself.
 *
 * Self-contained on purpose, exactly as `ModelManifest` is: it has to stay
 * readable after the catalog moves to a new version, so it repeats the version
 * and the source rather than pointing at a catalog row that may since have
 * changed underneath it. That is what lets `isStale()` be a comparison rather
 * than a guess.
 */
export interface RuntimeManifest {
	runtimeId: NativeRuntimeId;
	/** The npm version this payload came from. Compared against the pin. */
	version: string;
	platform: string;
	sourceUrl: string;
	/** SHA-256 of the downloaded tarball, before extraction. */
	sha256: string;
	/** Module path to import, relative to the install directory. */
	entry: string;
	/** Native binary that must exist, relative to the install directory. */
	binary: string;
	/** Epoch ms the install completed. */
	installedAt: number;
	/** Bytes the extracted subtree occupies. Not the download size. */
	bytes: number;
}

/**
 * Resolve the Maestro data dir the same way every other store does.
 *
 * `MAESTRO_USER_DATA` has to keep working, and it only does if nothing invents a
 * second way to ask this question. See the identical note in `model-store.ts`.
 */
function dataDir(): string {
	if (process.env.MAESTRO_USER_DATA) return path.resolve(process.env.MAESTRO_USER_DATA);
	return app.getPath('userData');
}

/** Root every downloaded runtime lives under. */
export function runtimesRoot(): string {
	return path.join(dataDir(), ACAPPELLA_RUNTIMES_DIRNAME);
}

/**
 * Install directory for one runtime.
 *
 * Whitelisted against the registry rather than sanitised, for the same reason
 * `modelDir()` is: ids arrive from IPC, and this path is handed to a recursive
 * delete. Only ids that name a real runtime are accepted, so a traversal attempt
 * fails as an unknown id long before it becomes a path.
 */
export function runtimeDir(id: NativeRuntimeId): string {
	if (!getNativeRuntime(id)) throw new Error(`UnknownVoiceRuntime: ${id}`);
	return path.join(runtimesRoot(), id);
}

/** Where a payload is extracted before it is promoted. Never imported from. */
export function runtimeStagingDir(id: NativeRuntimeId): string {
	return runtimeDir(id) + RUNTIME_STAGING_SUFFIX;
}

/**
 * Absolute path of a file inside a runtime's install directory.
 *
 * Escape-checked. Artifact paths are authored in this repo, but the one mistake
 * that turns an install into a disaster is a relative path that climbs out of its
 * root, so it is proven rather than trusted.
 */
export function runtimeFilePath(id: NativeRuntimeId, relativePath: string): string {
	const dir = runtimeDir(id);
	const resolved = path.resolve(dir, relativePath);
	if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
		throw new Error(`UnsafeRuntimePath: ${relativePath}`);
	}
	return resolved;
}

function manifestPath(id: NativeRuntimeId): string {
	return path.join(runtimeDir(id), RUNTIME_MANIFEST_FILENAME);
}

/** The payload this platform would install for a runtime, or null when none. */
export function artifactForThisPlatform(id: NativeRuntimeId): NativeRuntimeArtifact | null {
	const key = nativePlatformKey(process.platform, process.arch);
	if (!key) return null;
	return nativeRuntimeArtifact(id, key);
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

/** Read a runtime's manifest, or null when it is absent or unreadable. */
export async function readRuntimeManifest(id: NativeRuntimeId): Promise<RuntimeManifest | null> {
	try {
		const raw = await fs.readFile(manifestPath(id), 'utf8');
		const parsed = JSON.parse(raw) as RuntimeManifest;
		// A manifest that does not name its own runtime is a manifest from a
		// different install that was copied or renamed into place. Refusing it is
		// cheaper than trusting it and loading the wrong engine.
		return parsed.runtimeId === id ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Is this runtime installed and usable?
 *
 * Both halves are required. See the module header: a manifest is a claim about
 * the past, and the binary is what the loader will actually reach for.
 */
export async function isRuntimeInstalled(id: NativeRuntimeId): Promise<boolean> {
	const manifest = await readRuntimeManifest(id);
	if (!manifest) return false;
	return exists(path.join(runtimeDir(id), manifest.binary));
}

/**
 * The absolute module path to import for an installed runtime, or null.
 *
 * Null rather than a throw, because "not downloaded yet" is the ordinary state of
 * this feature and every caller has to handle it anyway. The loader turns the
 * null into a classified, actionable refusal.
 */
export async function installedRuntimeEntry(id: NativeRuntimeId): Promise<string | null> {
	const manifest = await readRuntimeManifest(id);
	if (!manifest) return null;

	const entry = path.join(runtimeDir(id), manifest.entry);
	const binary = path.join(runtimeDir(id), manifest.binary);
	if (!(await exists(entry)) || !(await exists(binary))) return null;
	return entry;
}

/**
 * True when what is installed no longer matches what this build expects.
 *
 * Compared against the artifact's HASH, not only its version. A version string
 * is what someone edits; the hash is what was actually downloaded, so comparing
 * it catches a re-published tarball and a hand-edited manifest alike. An
 * uninstalled runtime is not stale, it is absent, and the two want different
 * words in front of the user.
 */
export async function isRuntimeStale(id: NativeRuntimeId): Promise<boolean> {
	const manifest = await readRuntimeManifest(id);
	if (!manifest) return false;

	const artifact = artifactForThisPlatform(id);
	if (!artifact) return false;
	return manifest.sha256 !== artifact.sha256;
}

/** Recursive size of a directory in bytes. Missing directories count as zero. */
async function directorySize(target: string): Promise<number> {
	let total = 0;
	// A missing directory is zero, not an error: the footprint of something that
	// was never installed is a legitimate question with an obvious answer.
	const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);

	for (const entry of entries) {
		const child = path.join(target, entry.name);
		if (entry.isDirectory()) {
			total += await directorySize(child);
			continue;
		}
		try {
			const stat = await fs.stat(child);
			total += stat.size;
		} catch {
			// A file that vanished between readdir and stat contributes nothing.
			// A footprint report is not worth failing over a race with a delete.
		}
	}
	return total;
}

/** Disk a single installed runtime occupies. Zero when it is not installed. */
export async function runtimeFootprint(id: NativeRuntimeId): Promise<number> {
	return directorySize(runtimeDir(id));
}

/** Disk every downloaded runtime occupies, including any abandoned staging. */
export async function runtimesFootprint(): Promise<number> {
	return directorySize(runtimesRoot());
}

/**
 * Record a finished install.
 *
 * Written LAST by the installer and never before, which is the whole reason
 * `isRuntimeInstalled()` can be a cheap question: the manifest's existence is the
 * commit point of the install transaction.
 */
export async function writeRuntimeManifest(
	id: NativeRuntimeId,
	manifest: RuntimeManifest
): Promise<void> {
	await fs.mkdir(runtimeDir(id), { recursive: true });
	await fs.writeFile(manifestPath(id), JSON.stringify(manifest, null, 2), 'utf8');
}

/**
 * Delete one runtime, including any staging directory left by a failed install.
 *
 * Safe to call on a runtime that was never installed. Note that the loader keeps
 * the native library resident for the life of the process (Node has no unload),
 * so removing a runtime that has already been loaded frees the disk but not the
 * memory until restart. Callers that present this to a user should say so rather
 * than implying the engine is gone.
 */
export async function removeRuntime(id: NativeRuntimeId): Promise<void> {
	await fs.rm(runtimeDir(id), { recursive: true, force: true });
	await fs.rm(runtimeStagingDir(id), { recursive: true, force: true });
}

/** Delete every downloaded runtime. The "reclaim this disk" action. */
export async function removeAllRuntimes(): Promise<void> {
	await fs.rm(runtimesRoot(), { recursive: true, force: true });
}
