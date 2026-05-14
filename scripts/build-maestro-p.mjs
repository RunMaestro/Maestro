#!/usr/bin/env node
/**
 * Build script for the maestro-p wrapper binary using esbuild.
 *
 * Bundles src/maestro-p/index.ts into dist/cli/maestro-p.js, preserves the
 * shebang (already present in the source entry), and chmods the output
 * executable. Mirrors scripts/build-cli.mjs.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const outfile = path.join(rootDir, 'dist/cli/maestro-p.js');

async function build() {
	console.log('Building maestro-p with esbuild...');

	try {
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/maestro-p/index.ts')],
			bundle: true,
			platform: 'node',
			target: 'node20',
			outfile,
			format: 'cjs',
			sourcemap: true,
			minify: false,
			external: ['node-pty', 'chokidar'],
		});

		fs.chmodSync(outfile, 0o755);

		const stats = fs.statSync(outfile);
		const sizeKB = (stats.size / 1024).toFixed(1);
		console.log(`✓ Built ${outfile} (${sizeKB} KB)`);
	} catch (error) {
		console.error('Build failed:', error);
		process.exit(1);
	}
}

build();
