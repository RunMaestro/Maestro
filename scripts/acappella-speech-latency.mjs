#!/usr/bin/env node
/**
 * Runner for the A Cappella speech latency harness.
 *
 * Same shape as `acappella-routing-eval.mjs` and for the same reason: the harness
 * imports main-process modules, so it is bundled before it can run outside
 * Electron, with `electron` itself stubbed down to the handful of answers those
 * modules want for path resolution.
 *
 * See scripts/acappella-speech-latency.ts for what it measures and why.
 */

import { spawn } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outfile = path.join(rootDir, 'dist', 'acappella-eval', 'speech-latency.cjs');

/** Enough of `electron` for the bundled main-process modules to resolve paths. */
const electronStub = {
	name: 'electron-stub',
	setup(build) {
		build.onResolve({ filter: /^electron$/ }, () => ({
			path: 'electron',
			namespace: 'electron-stub',
		}));
		build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
			contents: `
				const userData = ${JSON.stringify(path.join(os.tmpdir(), 'acappella-speech-latency'))};
				exports.app = {
					isPackaged: false,
					getAppPath: () => ${JSON.stringify(rootDir)},
					getPath: () => userData,
					getVersion: () => '0.0.0-latency',
					on: () => {},
					whenReady: () => Promise.resolve(),
				};
				exports.ipcMain = { on: () => {}, handle: () => {} };
				exports.BrowserWindow = { getAllWindows: () => [] };
			`,
			loader: 'js',
		}));
	},
};

await esbuild.build({
	entryPoints: [path.join(__dirname, 'acappella-speech-latency.ts')],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	outfile,
	sourcemap: 'inline',
	external: [
		'fsevents',
		'node-pty',
		'node-llama-cpp',
		'@node-llama-cpp/*',
		'better-sqlite3',
		'@napi-rs/keyring',
	],
	plugins: [electronStub],
	logLevel: 'warning',
});

fs.mkdirSync(path.join(os.tmpdir(), 'acappella-speech-latency'), { recursive: true });

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
