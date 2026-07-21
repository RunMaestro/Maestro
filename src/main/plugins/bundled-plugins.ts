/**
 * Seeds BUNDLED first-party plugins into the user's plugins dir at startup.
 *
 * Plugins shipped inside the app (extraResources -> <resources>/plugins/<id>)
 * are copied into `pluginsDir()/<id>` so a normal discovery/refresh picks them
 * up - but ONLY when their signature verifies `trusted` against the baked
 * publisher anchor (see `publisher-keys.ts`). That trust gate is what keeps an
 * empty anchor safe: nothing is auto-installed until a real publisher key +
 * signature exist, so the user never gets an orphaned, auto-installed-but-
 * non-runnable plugin they did not choose.
 *
 * Symlinks are never copied (preserves the plugin-dir escape guard). Idempotent:
 * install when absent, when the bundled version is semver-newer, or when the
 * installed copy is not itself trusted (replacing a manual unsigned install).
 * Per-plugin failures are non-fatal. The runtime `trusted` + enable/consent
 * gates still apply after seeding.
 */

import * as fs from 'fs';
import * as path from 'path';
import semver from 'semver';
import { validatePluginManifest, type PluginManifest } from '../../shared/plugins/plugin-manifest';
import { verifyPluginSignature } from './plugin-signature';
import { pluginsDir, isSafePluginFolderName } from './plugin-store-main';

const MANIFEST_FILENAME = 'plugin.json';

/**
 * Root of plugins bundled inside the app.
 * - Packaged: extraResources lands them at `<resources>/plugins`.
 * - Dev: the repo's `examples/plugins` tree (this file compiles to
 *   `dist/main/plugins/bundled-plugins.js`).
 * Returns null when no bundled root exists.
 */
export function bundledPluginsRoot(): string | null {
	const candidates: string[] = [];
	if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
		candidates.push(path.join(process.resourcesPath, 'plugins'));
	}
	candidates.push(path.resolve(__dirname, '..', '..', '..', 'examples', 'plugins'));
	for (const dir of candidates) {
		try {
			if (fs.statSync(dir).isDirectory()) return dir;
		} catch {
			// Not present at this candidate; try the next.
		}
	}
	return null;
}

/** Parse + validate a plugin dir's manifest, or null when unreadable/invalid. */
function readManifest(dir: string): PluginManifest | null {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILENAME), 'utf-8')) as unknown;
		return validatePluginManifest(raw).manifest;
	} catch {
		return null;
	}
}

export interface SeedBundledPluginsDeps {
	/** Trusted keys (baked publisher anchor + user keys) to verify against. */
	trustedKeys: () => string[];
	onLog?: (message: string) => void;
	onError?: (error: unknown) => void;
}

/**
 * Copy trusted bundled plugins into the user's plugins dir. See file header.
 */
export function seedBundledPlugins(deps: SeedBundledPluginsDeps): void {
	const root = bundledPluginsRoot();
	if (!root) return;
	const trusted = deps.trustedKeys();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (error) {
		deps.onError?.(error);
		return;
	}
	const targetRoot = pluginsDir();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const src = path.join(root, entry.name);
		const bundled = readManifest(src);
		const id = bundled?.id;
		if (!id || !isSafePluginFolderName(id)) continue;
		// Identity guard: the bundled folder name must equal the declared id, so a
		// signed bundle can never target a DIFFERENT plugin's directory in the
		// writable plugins tree.
		if (entry.name !== id) {
			deps.onLog?.(`bundled plugin dir "${entry.name}" declares id "${id}"; skipped`);
			continue;
		}
		try {
			// Trust gate: only seed a bundled plugin that verifies `trusted`.
			const sig = verifyPluginSignature(src, trusted);
			if (sig.status !== 'trusted') {
				deps.onLog?.(`bundled plugin "${id}" not seeded (signature: ${sig.status})`);
				continue;
			}
			const dest = path.join(targetRoot, id);
			const installed = fs.existsSync(dest) ? readManifest(dest) : null;
			// Re-verify the INSTALLED copy too: a manual unsigned/untrusted install
			// of the same id (even the same version) must be replaced by the trusted
			// bundled copy - not only an absent or older one.
			const installedTrusted =
				!!installed && verifyPluginSignature(dest, trusted).status === 'trusted';
			const shouldSeed =
				!installed ||
				!installedTrusted ||
				(!!bundled.version &&
					!!installed.version &&
					!!semver.valid(bundled.version) &&
					!!semver.valid(installed.version) &&
					semver.gt(bundled.version, installed.version));
			if (!shouldSeed) continue;
			// Stage a full copy into a temp sibling, then atomically swap it in with a
			// backup + rollback, so a failed copy (disk full, permissions) never
			// leaves the install destroyed. Temp names start with '.' so discovery
			// (isSafePluginFolderName) never picks them up. Never copy a symlink: a
			// link in the bundled tree must not become a live link in the writable
			// plugins dir (mirrors install()'s guard).
			fs.mkdirSync(targetRoot, { recursive: true });
			const staging = path.join(targetRoot, `.${id}.seed-tmp`);
			const backup = path.join(targetRoot, `.${id}.seed-bak`);
			fs.rmSync(staging, { recursive: true, force: true });
			fs.rmSync(backup, { recursive: true, force: true });
			fs.cpSync(src, staging, {
				recursive: true,
				filter: (from) => !fs.lstatSync(from).isSymbolicLink(),
			});
			const hadDest = fs.existsSync(dest);
			if (hadDest) fs.renameSync(dest, backup);
			try {
				fs.renameSync(staging, dest);
			} catch (swapError) {
				if (hadDest) fs.renameSync(backup, dest);
				throw swapError;
			}
			fs.rmSync(backup, { recursive: true, force: true });
			deps.onLog?.(`seeded bundled plugin "${id}" (${bundled.version ?? 'unknown'})`);
		} catch (error) {
			deps.onError?.(error);
		}
	}
}
