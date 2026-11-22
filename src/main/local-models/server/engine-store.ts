/**
 * Where the Maestro model server's engine lives, and whether it is really there.
 *
 *   userData/runtimes/llama-server/
 *     manifest.json     - what was installed, from where, and when
 *     llama-server(.exe) and the shared libraries it loads
 *
 * It sits beside the npm runtimes under `runtimes/` for the same reason they sit
 * beside the model store: an engine and a model have different lifetimes, and
 * "reclaim my models' disk" must not uninstall the engine. The same invariant
 * holds as in `runtime-store.ts`: **it counts as installed only when its manifest
 * exists AND the binary the manifest names is on disk.**
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import {
	LLAMA_SERVER_RELEASE,
	selectServerBuild,
	type ServerBuildChoice,
	type ServerBuildKind,
} from '../../../shared/local-models/server-engine';
import type { ServerAcceleratorReport } from '../../../shared/local-models/server-accelerator';
import { exists, runtimesRoot } from '../runtime/runtime-store';

/** Directory name under `runtimes/`. Not a `NativeRuntimeId`: see `server-engine.ts`. */
export const SERVER_ENGINE_DIRNAME = 'llama-server';

export const SERVER_ENGINE_MANIFEST_FILENAME = 'manifest.json';

/** Extraction target while an install is laid out. Promoted by rename. */
export const SERVER_ENGINE_STAGING_SUFFIX = '.staging';

/** What a completed engine install recorded about itself. Self-contained, as `RuntimeManifest` is. */
export interface ServerEngineManifest {
	/** The llama.cpp release tag, for example `b11559`. */
	release: string;
	platform: string;
	/** What the user chose. `default` stays `default` even though it resolved to a build. */
	choice: ServerBuildChoice;
	/** What the choice resolved to. */
	kind: ServerBuildKind;
	/** "Metal", "Vulkan", "CUDA 12.4": the build's label. */
	label: string;
	/** Names and hashes of every asset extracted, in order. */
	assets: ReadonlyArray<{ name: string; sha256: string }>;
	/** The executable, relative to the install directory. */
	binary: string;
	installedAt: number;
	/** Bytes the extracted tree occupies. Not the download size. */
	bytes: number;
	/**
	 * What `llama-server --list-devices` found right after the install: the GPU it
	 * will use, or that it will run on the CPU and why. Absent on a manifest written
	 * before the check existed; `recheckServerAccelerator()` fills it in.
	 */
	accelerator?: ServerAcceleratorReport;
}

export function serverEngineDir(): string {
	return path.join(runtimesRoot(), SERVER_ENGINE_DIRNAME);
}

export function serverEngineStagingDir(): string {
	return serverEngineDir() + SERVER_ENGINE_STAGING_SUFFIX;
}

function manifestPath(): string {
	return path.join(serverEngineDir(), SERVER_ENGINE_MANIFEST_FILENAME);
}

/** Read the manifest, or null when it is absent or unreadable. */
export async function readServerEngineManifest(): Promise<ServerEngineManifest | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(manifestPath(), 'utf8')) as ServerEngineManifest;
		return typeof parsed.binary === 'string' && typeof parsed.release === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Absolute path of the installed `llama-server`, or null.
 *
 * Refuses a path that climbs out of the install directory: the manifest is a file
 * on disk, and the result is handed to `spawn`.
 */
export async function installedServerBinary(): Promise<string | null> {
	const manifest = await readServerEngineManifest();
	if (!manifest) return null;
	const dir = serverEngineDir();
	const resolved = path.resolve(dir, manifest.binary);
	if (!resolved.startsWith(dir + path.sep)) return null;
	return (await exists(resolved)) ? resolved : null;
}

export async function isServerEngineInstalled(): Promise<boolean> {
	return (await installedServerBinary()) !== null;
}

/**
 * True when what is installed is not the build this app pins: an older release, or
 * a build that no longer exists for the platform. The Download button then fetches
 * the pin, as it does for the npm runtimes.
 */
export async function isServerEngineStale(
	platform: string = process.platform,
	arch: string = process.arch
): Promise<boolean> {
	const manifest = await readServerEngineManifest();
	if (!manifest) return false;
	if (manifest.release !== LLAMA_SERVER_RELEASE) return true;
	const expected = selectServerBuild(platform, arch, manifest.choice);
	if (!expected) return true;
	return (
		expected.assets.length !== manifest.assets.length ||
		expected.assets.some((entry, index) => manifest.assets[index]?.sha256 !== entry.sha256)
	);
}

export async function writeServerEngineManifest(manifest: ServerEngineManifest): Promise<void> {
	await fs.mkdir(serverEngineDir(), { recursive: true });
	await fs.writeFile(manifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
}

/** Delete the engine and any staging wreckage. Safe on an engine that was never installed. */
export async function removeServerEngine(): Promise<void> {
	await fs.rm(serverEngineDir(), { recursive: true, force: true });
	await fs.rm(serverEngineStagingDir(), { recursive: true, force: true });
}
