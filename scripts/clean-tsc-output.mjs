// Remove the directories `tsc -p tsconfig.main.json` emits into, before it runs.
//
// tsc only ever adds and overwrites files; it never deletes output whose source
// is gone. When a module `foo.ts` becomes a directory `foo/index.ts`, the old
// `dist/.../foo.js` stays behind, and Node resolves `require('./foo')` to that
// file before the directory, so the app silently runs the old code (#1724).
// tsconfig.main.json has no `incremental`, so tsc rewrites every file it owns on
// each run anyway, and starting from empty costs nothing.
//
// The list mirrors the `include` globs of tsconfig.main.json (rootDir `src`,
// outDir `dist`); a test keeps the two in step. Everything else under `dist/`
// (cli, renderer, web-desktop, build-provenance.json) belongs to other build
// steps and is left alone. Two other steps also write into `dist/main/`
// (gen-build-info.mjs and the preload bundle), which is why `build:main` runs
// both of them after tsc.
//
// Usage: node scripts/clean-tsc-output.mjs

import { realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Top-level folders under `dist/` that tsc owns outright. */
export const TSC_OUTPUT_DIRS = ['main', 'shared', 'types'];

/**
 * Delete `<distDir>/{main,shared,types}`. `fs.rmSync` rather than a shell `rm`
 * so it behaves the same on Windows. Refuses anything that is not an absolute
 * path to a folder named `dist`, so a bad argument can never reach source.
 */
export function cleanTscOutput(distDir) {
	if (typeof distDir !== 'string' || !isAbsolute(distDir)) {
		throw new Error(`clean-tsc-output: expected an absolute dist path, got ${String(distDir)}`);
	}
	const target = resolve(distDir);
	if (basename(target) !== 'dist') {
		throw new Error(`clean-tsc-output: refusing to clean ${target}; it is not a dist folder`);
	}
	for (const dir of TSC_OUTPUT_DIRS) {
		rmSync(join(target, dir), { recursive: true, force: true, maxRetries: 3 });
	}
}

// Run only when invoked directly, so a test can import `cleanTscOutput` without
// wiping the real dist. Both sides go through realpath: Node resolves the entry
// module through symlinks but leaves argv[1] as typed, and a checkout reached
// through a symlink would otherwise skip the clean without a word.
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
	cleanTscOutput(join(dirname(scriptPath), '..', 'dist'));
}
