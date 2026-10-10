#!/usr/bin/env node
/**
 * Build script for the `maestro-lib-run` headless program using esbuild.
 *
 * Bundles src/shared/maestro-lib/bin/run-turn.ts into a single Node.js script
 * at dist/cli/maestro-lib-run.js, preserves the shebang from the entry file,
 * and marks the output executable. Mirrors scripts/build-maestro-p.mjs.
 *
 * The bundle is the proof that maestro-lib stands alone: `electron` is not
 * marked external, so an import of it anywhere in the library fails this build
 * instead of surfacing at run time on a machine with no desktop app.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const outfile = path.join(rootDir, 'dist/cli/maestro-lib-run.js');

async function build() {
	console.log('Building maestro-lib-run with esbuild...');

	try {
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/shared/maestro-lib/bin/run-turn.ts')],
			bundle: true,
			platform: 'node',
			target: 'node20',
			outfile,
			format: 'cjs',
			sourcemap: true,
			minify: false, // Keep readable for debugging
			// Shebang lives in the entry file; esbuild preserves it.
			// node-pty is only ever imported for its types by the library, so
			// nothing is left of it in the bundle; it stays external so a future
			// value import resolves the installed package and its prebuild.
			external: ['node-pty'],
		});

		// Make the output executable
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
