#!/usr/bin/env node
/**
 * Build the `mae` Maestro TUI launcher + bridge extension with esbuild.
 *
 * Outputs:
 *   dist/cli/mae.js                        - launcher (Node CJS; root bin `mae`)
 *   dist/mae/maestro-bridge.extension.mjs  - omp extension (ESM; loaded by omp
 *                                            via `-e` under Bun)
 *   dist/mae/assets/*                      - system prompt + config overlay
 *
 * The launcher spawns the external `omp` binary; only omp runs under Bun. The
 * extension imports the omp package as types only (omp provides it at runtime),
 * so it is marked external.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const maeSrc = path.join(rootDir, 'src/mae');

async function build() {
	console.log('Building mae (launcher + extension) with esbuild...');

	await esbuild.build({
		entryPoints: [path.join(maeSrc, 'bin/mae.ts')],
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		outfile: path.join(rootDir, 'dist/cli/mae.js'),
		sourcemap: true,
	});
	fs.chmodSync(path.join(rootDir, 'dist/cli/mae.js'), 0o755);

	await esbuild.build({
		entryPoints: [path.join(maeSrc, 'extension/maestro-bridge.extension.ts')],
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'esm',
		outfile: path.join(rootDir, 'dist/mae/maestro-bridge.extension.mjs'),
		// omp injects this package at runtime; the extension imports only its types.
		external: ['@oh-my-pi/pi-coding-agent'],
		sourcemap: true,
	});

	const assetsOut = path.join(rootDir, 'dist/mae/assets');
	fs.mkdirSync(assetsOut, { recursive: true });
	for (const file of fs.readdirSync(path.join(maeSrc, 'assets'))) {
		fs.copyFileSync(path.join(maeSrc, 'assets', file), path.join(assetsOut, file));
	}

	console.log('\u2713 Built mae launcher, extension, and assets');
}

build().catch((error) => {
	console.error('mae build failed:', error);
	process.exit(1);
});
