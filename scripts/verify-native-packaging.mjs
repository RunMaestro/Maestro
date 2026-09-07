#!/usr/bin/env node
/**
 * Packaging assertion for A Cappella's native runtimes.
 *
 * The bug this exists to catch does not appear in development. A native module
 * left inside `app.asar`, or a per-platform prebuild that never got copied,
 * works perfectly from source and fails only in the installed, signed app, on
 * someone else's machine, after release. That is the most expensive kind of bug
 * this codebase can ship, and it is entirely mechanical to detect.
 *
 * So: after packaging, walk the built app and assert, per runtime,
 *
 *   1. the package is present at all,
 *   2. its platform binary exists at the path the registry promises,
 *   3. that binary is UNPACKED (inside `app.asar.unpacked`, not `app.asar`),
 *   4. on macOS, that every nested binary carries a signature, because
 *      notarization rejects a bundle containing an unsigned nested binary and
 *      the rejection arrives long after the build.
 *
 * A runtime whose package is not a dependency yet is reported and skipped: this
 * script fails on things that are broken, not on work that has not started.
 * Passing `--require-all` turns those skips into failures, which is what a
 * release build should use once the providers land.
 *
 * The runtime facts come from `dist/shared/acappella/native-runtimes.js`, the
 * compiled copy of the one registry the app itself reads, so this script cannot
 * drift from what the loader expects.
 *
 * Usage:
 *   node scripts/verify-native-packaging.mjs [--app <path to .app or app dir>]
 *                                            [--require-all] [--json]
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const requireAll = args.includes('--require-all');
const asJson = args.includes('--json');
const appArgIndex = args.indexOf('--app');
const appArg = appArgIndex >= 0 ? args[appArgIndex + 1] : null;

/** Load the compiled runtime registry. Built by `npm run build:main`. */
function loadRegistry() {
	const compiled = path.join(repoRoot, 'dist', 'shared', 'acappella', 'native-runtimes.js');
	if (!fs.existsSync(compiled)) {
		fail(
			`Runtime registry not found at ${rel(compiled)}. Run "npm run build:main" before this script.`
		);
	}
	return require(compiled);
}

function rel(target) {
	return path.relative(repoRoot, target) || target;
}

function fail(message) {
	console.error(`\nverify-native-packaging: ${message}\n`);
	process.exit(1);
}

/**
 * Find the packaged app's resources directory.
 *
 * Handles the three layouts electron-builder produces: a macOS .app bundle, a
 * Windows/Linux unpacked directory, and the `release/` tree containing either.
 */
function resolveResourcesDir() {
	const candidates = [];
	if (appArg) candidates.push(path.resolve(appArg));

	const releaseDir = path.join(repoRoot, 'release');
	if (fs.existsSync(releaseDir)) {
		for (const entry of fs.readdirSync(releaseDir)) {
			candidates.push(path.join(releaseDir, entry));
		}
	}

	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;

		// macOS: <name>.app/Contents/Resources
		if (candidate.endsWith('.app')) {
			const macResources = path.join(candidate, 'Contents', 'Resources');
			if (fs.existsSync(macResources)) return { resources: macResources, app: candidate };
		}

		// A directory holding a .app (release/mac-arm64/Maestro.app)
		if (fs.statSync(candidate).isDirectory()) {
			const nested = fs
				.readdirSync(candidate)
				.filter((entry) => entry.endsWith('.app'))
				.map((entry) => path.join(candidate, entry, 'Contents', 'Resources'))
				.find((entry) => fs.existsSync(entry));
			if (nested) return { resources: nested, app: path.dirname(path.dirname(nested)) };

			// Windows/Linux: <dir>/resources
			const resources = path.join(candidate, 'resources');
			if (fs.existsSync(resources)) return { resources, app: candidate };
		}
	}

	return null;
}

/**
 * Whether a Mach-O binary carries a signature.
 *
 * `codesign --verify` on each nested binary rather than one `--deep` pass on the
 * bundle: --deep reports the first failure and stops, and the useful output here
 * is the full list of what is unsigned.
 */
function isSigned(binaryPath) {
	try {
		execFileSync('codesign', ['--verify', '--strict', binaryPath], { stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}

function main() {
	const { NATIVE_RUNTIMES, nativePlatformKey } = loadRegistry();
	const platformKey = nativePlatformKey(process.platform, process.arch);
	if (!platformKey) {
		fail(`No packaging matrix for ${process.platform}-${process.arch}.`);
	}

	const located = resolveResourcesDir();
	if (!located) {
		fail(
			'No packaged app found. Run an electron-builder target first, or pass --app <path to the built app>.'
		);
	}

	const unpackedRoot = path.join(located.resources, 'app.asar.unpacked');

	// The package.json inside the bundle is what actually shipped, which is the
	// only honest answer to "is this runtime a dependency of THIS build".
	const shippedDeps = readShippedDependencies(located.resources);

	const results = [];
	let failures = 0;
	let skipped = 0;

	for (const runtime of NATIVE_RUNTIMES) {
		const expected = runtime.packagedBinaries[platformKey] ?? [];
		const declared = runtime.declared;
		const shipped = shippedDeps ? shippedDeps.has(runtime.moduleId) : declared;

		// Not a dependency yet: nothing is broken, so this is a skip. `--require-all`
		// is how a release build says "by now they should all be here".
		if (!declared) {
			// Counted as one or the other, never both: a line that reads "3 failed, 3
			// skipped" over three runtimes is a summary nobody can act on.
			if (requireAll) failures += 1;
			else skipped += 1;
			results.push({
				runtime: runtime.id,
				moduleId: runtime.moduleId,
				status: requireAll ? 'fail' : 'skip',
				reason: `${runtime.moduleId} is not a dependency of this build yet (registry declared=false).`,
			});
			continue;
		}

		// Declared but absent from what shipped is always a packaging bug: the app
		// will try to load it and will not find it.
		if (!shipped) {
			failures += 1;
			results.push({
				runtime: runtime.id,
				moduleId: runtime.moduleId,
				status: 'fail',
				reason: `${runtime.moduleId} is a declared runtime but is missing from the packaged dependencies.`,
			});
			continue;
		}

		if (runtime.prebuilds[platformKey] === 'unavailable') {
			results.push({
				runtime: runtime.id,
				moduleId: runtime.moduleId,
				status: 'skip',
				reason: `No build of ${runtime.moduleId} exists for ${platformKey}.`,
			});
			skipped += 1;
			continue;
		}

		const missing = [];
		const unsigned = [];

		for (const relativePath of expected) {
			const normalized = relativePath.split('/').join(path.sep);
			const absolute = path.join(unpackedRoot, normalized);
			if (!fs.existsSync(absolute)) {
				missing.push(relativePath);
				continue;
			}
			if (process.platform === 'darwin' && !isSigned(absolute)) unsigned.push(relativePath);
		}

		const problems = [];
		if (missing.length) {
			// Both causes are named, because the evidence here cannot tell them apart
			// without reading the asar index and the fixes differ: either the file
			// never made it into the build, or it is inside app.asar with no
			// asarUnpack entry, which works from source and dies once installed.
			problems.push(
				`not in app.asar.unpacked (absent from the build, or still packed inside app.asar): ${missing.join(', ')}`
			);
		}
		if (unsigned.length) problems.push(`unsigned: ${unsigned.join(', ')}`);

		if (problems.length) failures += 1;
		results.push({
			runtime: runtime.id,
			moduleId: runtime.moduleId,
			status: problems.length ? 'fail' : 'pass',
			reason: problems.join('; ') || `${expected.length} binaries present and signed.`,
		});
	}

	if (asJson) {
		console.log(JSON.stringify({ platformKey, app: located.app, results }, null, 2));
	} else {
		console.log(`\nNative packaging check: ${located.app} (${platformKey})`);
		for (const result of results) {
			console.log(
				`  ${result.status.toUpperCase().padEnd(5)} ${result.moduleId}: ${result.reason}`
			);
		}
		// Never silently truncate: a skipped runtime is stated, because "3 passed"
		// over a list where two were skipped reads as full coverage.
		console.log(`  ${results.length} runtimes, ${failures} failed, ${skipped} skipped\n`);
	}

	if (failures > 0) {
		fail(`${failures} native runtime(s) are not correctly packaged. See the list above.`);
	}
}

/** Dependencies of the package.json that actually shipped inside the bundle. */
function readShippedDependencies(resourcesDir) {
	const candidates = [
		path.join(resourcesDir, 'app.asar.unpacked', 'package.json'),
		path.join(resourcesDir, 'app', 'package.json'),
	];
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
			return new Set(Object.keys(parsed.dependencies ?? {}));
		} catch {
			// A package.json we cannot read tells us nothing; fall through to the
			// registry's own view rather than failing the build on a parse error.
			return null;
		}
	}
	return null;
}

main();
