#!/usr/bin/env node
/**
 * Build script for the Maestro TUI using esbuild.
 *
 * Bundles src/tui/index.tsx into a single Node.js script
 * at dist/cli/maestro-tui.mjs. Uses ESM format because Ink's
 * yoga-layout dependency uses top-level await.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const outfile = path.join(rootDir, 'dist/cli/maestro-tui.mjs');

async function build() {
	console.log('Building maestro-tui with esbuild...');

	try {
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/tui/index.tsx')],
			bundle: true,
			platform: 'node',
			target: 'node20',
			outfile,
			format: 'esm',
			sourcemap: true,
			minify: false, // Keep readable for debugging
		});

		const stats = fs.statSync(outfile);
		const sizeKB = (stats.size / 1024).toFixed(1);
		console.log(`✓ Built ${outfile} (${sizeKB} KB)`);
	} catch (error) {
		console.error('Build failed:', error);
		process.exit(1);
	}
}

build();
