#!/usr/bin/env node
/**
 * Build script for the Maestro TUI using esbuild.
 *
 * Bundles src/tui/index.tsx into dist/cli/maestro-tui.mjs. The format is ESM
 * because Ink's `yoga-layout` uses top-level await, which a CJS bundle cannot
 * hold. `maestro-cli tui` launches the result, so plain CLI calls never load
 * React. Mirrors scripts/build-maestro-lib-run.mjs.
 *
 * `electron` is not marked external, so an import of it anywhere under
 * src/tui or the library fails this build instead of surfacing at run time.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const outfile = path.join(rootDir, 'dist/cli/maestro-tui.mjs');

// Ink imports the optional `react-devtools-core` only when DEV=true, but the
// import is still in the bundle graph and the package is not installed. Give
// it an empty module so the build resolves and the branch is inert.
const stubReactDevtools = {
	name: 'stub-react-devtools-core',
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
			path: 'react-devtools-core',
			namespace: 'stub',
		}));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: 'export default {};',
			loader: 'js',
		}));
	},
};

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
			jsx: 'automatic',
			sourcemap: true,
			minify: false, // Keep readable for debugging
			// Bundled CJS dependencies call require(); an ESM bundle has none, so
			// give them one.
			banner: {
				js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
			},
			define: { 'process.env.NODE_ENV': '"production"' },
			plugins: [stubReactDevtools],
			// node-pty is only imported for types by the library; keep it out of
			// the bundle so a future value import resolves the installed package.
			external: ['node-pty'],
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
