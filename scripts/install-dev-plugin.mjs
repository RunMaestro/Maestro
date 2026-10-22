#!/usr/bin/env node
/**
 * Copy an `examples/plugins/<id>/` folder into a real plugins directory.
 *
 * Plugin discovery rejects a symlinked plugin folder
 * (`plugin-manager.ts` checks `entry.isSymbolicLink()`), so this always makes
 * a real copy, never a symlink, and deletes whatever was previously at the
 * destination first so a stale copy never lingers next to a changed source.
 *
 *   node scripts/install-dev-plugin.mjs <id> --dest <dir>
 *   node scripts/install-dev-plugin.mjs <id> --dev-data
 *
 * `--dest <dir>` copies into `<dir>/<id>/`. This is the form every automated
 * step in the Phase 01 playbook uses, always pointed at a fresh temp
 * directory.
 *
 * `--dev-data` copies into the dev build's userData plugins dir
 * (`<platform userData root>/maestro-dev/plugins/<id>/`), for a human running
 * the dev app to pick up a local plugin change. It is never used by
 * automation.
 *
 * With neither flag the script prints usage and exits non-zero, so it can
 * never write into a real data directory by accident.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const USAGE = `Usage: node scripts/install-dev-plugin.mjs <id> --dest <dir>
       node scripts/install-dev-plugin.mjs <id> --dev-data`;

/**
 * The dev build's userData directory, derived the same way
 * `src/main/index.ts` derives `devDataPath`: Electron's per-platform default
 * for an unpackaged app (the `name` in package.json, "maestro"), redirected
 * to its `maestro-dev` sibling.
 *
 * This is also what `resolveUserDataDir` in
 * `src/shared/maestro-lib/paths/userDataDir.ts` computes for a development
 * run, but that module is TypeScript and this is a plain `.mjs` script with
 * no build step to compile it through, so the three platform roots are
 * reproduced here instead of imported. Keep the two in step if either one's
 * platform rule changes.
 */
export function devUserDataDir(env = process.env, platform = os.platform(), home = os.homedir()) {
	// `MAESTRO_USER_DATA` wins, exactly as it does in `plugin-store-main.ts`: that
	// override is how a dev run is pointed at a throwaway data dir, and the
	// installer has to land in the directory the app will actually read.
	if (env.MAESTRO_USER_DATA) return resolve(env.MAESTRO_USER_DATA);
	const root =
		platform === 'darwin'
			? join(home, 'Library', 'Application Support')
			: platform === 'win32'
				? env.APPDATA || join(home, 'AppData', 'Roaming')
				: env.XDG_CONFIG_HOME || join(home, '.config');
	return join(root, 'maestro-dev');
}

/** Guards the id against escaping the destination directory it is joined into,
 * or naming the directory itself. `".."` is caught by the substring check, but
 * `"."` is not: it needs its own rejection, because `join(root, '.')` is `root`,
 * so a `.` id made the script delete the whole destination plugins directory and
 * then copy every example plugin into it. */
function isSafePluginId(id) {
	return (
		typeof id === 'string' &&
		id.length > 0 &&
		id.trim() === id &&
		id !== '.' &&
		!id.includes('/') &&
		!id.includes('\\') &&
		!id.includes('..')
	);
}

/** Parse the command line. Returns `{ error }` for a request that cannot be run. */
export function parseArgs(argv) {
	const positional = [];
	let dest;
	let devData = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === '--dest') {
			const value = argv[index + 1];
			if (value === undefined) return { error: '--dest needs a directory' };
			dest = value;
			index++;
			continue;
		}
		if (arg === '--dev-data') {
			devData = true;
			continue;
		}
		positional.push(arg);
	}
	if (positional.length !== 1) {
		return { error: `Expected exactly one plugin id, got ${positional.length}` };
	}
	const id = positional[0];
	if (!isSafePluginId(id)) return { error: `"${id}" is not a safe plugin id` };
	if (dest !== undefined && devData) {
		return { error: '--dest and --dev-data cannot both be given' };
	}
	return { id, dest, devData };
}

/**
 * Copy `<srcRoot>/<id>/` into `<destRoot>/<id>/`, deleting whatever was
 * previously there first. Returns the destination path. A symlink anywhere in
 * the source tree is skipped rather than copied (mirrors the same guard
 * `plugin-manager.ts` and `bundled-plugins.ts` apply to a real install).
 *
 * `srcRoot` defaults to this repo's `examples/plugins`; a test points it at a
 * throwaway directory instead of the real plugin sources.
 */
export function installPlugin({ id, destRoot, srcRoot = join(rootDir, 'examples', 'plugins') }) {
	const src = join(srcRoot, id);
	let srcStat;
	try {
		srcStat = statSync(src);
	} catch {
		throw new Error(`no plugin source at ${src}`);
	}
	if (!srcStat.isDirectory()) {
		throw new Error(`${src} is not a directory`);
	}
	const dest = join(destRoot, id);
	// Never delete the source. `rmSync` below is unconditional, so a destRoot that
	// resolves to the source's own parent (`--dest examples/plugins`) would wipe
	// the plugin out of the checkout and then copy nothing back. Compared on the
	// real paths so a symlinked or `..`-laden destRoot cannot sneak past.
	if (realpathSync(src) === (existsSync(dest) ? realpathSync(dest) : resolve(dest))) {
		throw new Error(`destination ${dest} is the plugin source; refusing to delete it`);
	}
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(destRoot, { recursive: true });
	cpSync(src, dest, {
		recursive: true,
		filter: (from) => !lstatSync(from).isSymbolicLink(),
	});
	return dest;
}

export function main(argv) {
	const parsed = parseArgs(argv);
	if (parsed.error) {
		process.stderr.write(`${parsed.error}\n${USAGE}\n`);
		return 1;
	}
	if (parsed.dest === undefined && !parsed.devData) {
		process.stderr.write(`${USAGE}\n`);
		return 1;
	}
	const destRoot =
		parsed.dest !== undefined ? resolve(parsed.dest) : join(devUserDataDir(), 'plugins');
	let dest;
	try {
		dest = installPlugin({ id: parsed.id, destRoot });
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	process.stdout.write(`${dest}\n`);
	return 0;
}

// Run only when invoked directly, so a test can import these functions without
// writing to a real directory. Both sides go through realpath: Node resolves
// the entry module through symlinks but leaves argv[1] as typed, and a
// checkout reached through a symlink would otherwise skip the run without a
// word.
const scriptPath = realpathSync(fileURLToPath(import.meta.url));

function invokedDirectly() {
	if (!process.argv[1]) return false;
	try {
		return realpathSync(resolve(process.argv[1])) === scriptPath;
	} catch {
		// argv[1] is not a file on disk (a REPL, `node -e`), so this was an import.
		return false;
	}
}

if (invokedDirectly()) {
	process.exitCode = main(process.argv.slice(2));
}
