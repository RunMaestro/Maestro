#!/usr/bin/env node
/**
 * Runner for the A Cappella routing evaluation harness.
 *
 * The harness imports main-process modules (the router, the prompt manager, the
 * routing log), so it has to be bundled before it can run outside Electron. The
 * only thing standing in the way is `electron` itself, which two of those modules
 * import for `app.getPath()`; it is stubbed with the three answers they need.
 *
 * The output lands two directories below the repo root on purpose:
 * `prompt-manager.ts` resolves the bundled prompts as
 * `__dirname/../../src/prompts`, so that depth is what makes the harness read the
 * real `src/prompts/acappella-router.md` rather than the built-in fallback.
 *
 * See scripts/acappella-routing-eval.ts for what it measures and why.
 */

import { spawn } from 'child_process';
import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outfile = path.join(rootDir, 'dist', 'acappella-eval', 'routing-eval.cjs');

/** Enough of `electron` for the prompt manager and the routing log to resolve paths. */
const electronStub = {
	name: 'electron-stub',
	setup(build) {
		build.onResolve({ filter: /^electron$/ }, () => ({
			path: 'electron',
			namespace: 'electron-stub',
		}));
		build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
			contents: `
				const userData = ${JSON.stringify(path.join(os.tmpdir(), 'acappella-routing-eval'))};
				exports.app = {
					isPackaged: false,
					getAppPath: () => ${JSON.stringify(rootDir)},
					getPath: () => userData,
					getVersion: () => '0.0.0-eval',
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
	entryPoints: [path.join(__dirname, 'acappella-routing-eval.ts')],
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	outfile,
	sourcemap: 'inline',
	// Native modules the main process pulls in transitively. The harness never
	// reaches them; node-llama-cpp is loaded dynamically by the local Brain, which
	// reports its own absence.
	external: [
		'fsevents',
		'node-pty',
		'node-llama-cpp',
		'@node-llama-cpp/*',
		'better-sqlite3',
		// Ships a .node binding esbuild cannot inline. Required at runtime instead,
		// which is harmless: the harness injects its own credential reader.
		'@napi-rs/keyring',
	],
	plugins: [electronStub],
	logLevel: 'warning',
});

fs.mkdirSync(path.join(os.tmpdir(), 'acappella-routing-eval'), { recursive: true });

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
