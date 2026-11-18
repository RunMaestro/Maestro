#!/usr/bin/env node
// Make better-sqlite3 load under the runtime a command is about to use.
//
// Usage: node scripts/ensure-native-runtime.mjs <node|electron>
//
// Why this exists: one node_modules holds ONE compiled better_sqlite3.node, but
// two runtimes load it. The app runs on Electron (its own NODE_MODULE_VERSION)
// and vitest runs on plain Node (a different one). Whichever ran a rebuild last
// wins, and the other fails with "compiled against a different Node.js version
// using NODE_MODULE_VERSION X. This version of Node.js requires ... Y".
//
// The check is a real load, never the `.forge-meta` stamp: electron-rebuild
// writes that stamp, and a later Node-target rebuild replaces the binary without
// touching it, so a Node build can still claim the Electron ABI. When the module
// already loads, the cost is one short child process and nothing is rebuilt.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE = 'better-sqlite3';
const TARGETS = ['node', 'electron'];

const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const require = createRequire(import.meta.url);

const target = process.argv[2];
if (!TARGETS.includes(target)) {
	console.error(`Usage: node scripts/ensure-native-runtime.mjs <${TARGETS.join('|')}>`);
	process.exit(2);
}

// A checkout without the module (a CLI-only install) has nothing to repair.
if (!fs.existsSync(path.join(rootDir, 'node_modules', MODULE))) process.exit(0);

// better-sqlite3 loads its addon lazily, on the first Database, so the probe
// must open one. `:memory:` touches no file.
const PROBE = `require(${JSON.stringify(MODULE)})(':memory:').close()`;

function electronBinary() {
	try {
		// From plain Node, the electron package exports the path to its binary.
		return require('electron');
	} catch {
		return null;
	}
}

/** @returns {{ ok: true } | { ok: false, reason: string }} */
function probe() {
	const command = target === 'node' ? process.execPath : electronBinary();
	if (!command) return { ok: false, reason: 'the electron binary is not installed' };
	const env = { ...process.env };
	if (target === 'electron') env.ELECTRON_RUN_AS_NODE = '1';
	else delete env.ELECTRON_RUN_AS_NODE;
	const result = spawnSync(command, ['-e', PROBE], { cwd: rootDir, env, encoding: 'utf8' });
	if (result.status === 0) return { ok: true };
	const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
	// The ABI message wraps across lines: "...using\nNODE_MODULE_VERSION 147. This
	// version of Node.js requires\nNODE_MODULE_VERSION 145. ..."
	const abi = output
		.replace(/\s+/g, ' ')
		.match(/NODE_MODULE_VERSION \d+.*?NODE_MODULE_VERSION \d+/);
	return {
		ok: false,
		reason: abi?.[0] || output.split('\n')[0] || `exit ${result.status}`,
	};
}

function rebuild() {
	const [command, args] =
		target === 'node'
			? [isWindows ? 'npm.cmd' : 'npm', ['rebuild', MODULE]]
			: [
					path.join(
						rootDir,
						'node_modules',
						'.bin',
						isWindows ? 'electron-rebuild.cmd' : 'electron-rebuild'
					),
					['-f', '-w', MODULE],
				];
	// .cmd shims need a shell on Windows (Node >=22.12 refuses them otherwise).
	const result = spawnSync(
		isWindows ? `"${command}" ${args.join(' ')}` : command,
		isWindows ? [] : args,
		{
			cwd: rootDir,
			stdio: 'inherit',
			shell: isWindows,
		}
	);
	return result.status === 0;
}

const first = probe();
if (first.ok) {
	console.log(`[native] ${MODULE} loads under ${target}`);
	process.exit(0);
}

if (target === 'electron' && !electronBinary()) {
	console.log(`[native] skipping the ${MODULE} check: ${first.reason}`);
	process.exit(0);
}

console.log(
	`[native] ${MODULE} does not load under ${target} (${first.reason}); rebuilding for ${target}`
);
if (!rebuild()) {
	console.error(`[native] rebuilding ${MODULE} for ${target} failed`);
	process.exit(1);
}

const second = probe();
if (!second.ok) {
	console.error(
		`[native] ${MODULE} still does not load under ${target} after the rebuild: ${second.reason}`
	);
	process.exit(1);
}
console.log(`[native] ${MODULE} rebuilt for ${target} and loads`);
