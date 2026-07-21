#!/usr/bin/env node
/**
 * Build script for the Maestro CLI using esbuild.
 *
 * Bundles the CLI into a single JavaScript file that can be run with Node.js.
 * Users of this CLI already have Node.js installed (required for Claude Code),
 * so we don't need standalone binaries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildArtifact } from './lib/build.mjs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const outfile = path.join(rootDir, 'dist/cli/maestro-cli.js');

const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const cliVersion = pkgJson.version;
if (typeof cliVersion !== 'string' || cliVersion.length === 0) {
	throw new Error('Cannot build CLI: package.json is missing a valid "version" field');
}

/**
 * esbuild plugin to handle .md?raw imports (Vite-style raw imports)
 * Converts the file contents to a string export
 */
const rawMdPlugin = {
	name: 'raw-md',
	setup(build) {
		// Handle imports ending with .md?raw
		build.onResolve({ filter: /\.md\?raw$/ }, (args) => {
			// Remove the ?raw suffix and resolve the path
			const cleanPath = args.path.replace(/\?raw$/, '');
			const resolvedPath = path.resolve(path.dirname(args.importer), cleanPath);
			return { path: resolvedPath, namespace: 'raw-md' };
		});

		// Load the file contents as a string
		build.onLoad({ filter: /.*/, namespace: 'raw-md' }, async (args) => {
			const content = await fs.promises.readFile(args.path, 'utf8');
			return {
				contents: `export default ${JSON.stringify(content)};`,
				loader: 'js',
			};
		});
	},
};

buildArtifact({
	name: 'CLI',
	entryPoint: path.join(rootDir, 'src/cli/index.ts'),
	outfile,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	// fsevents is an optional native module (.node) pulled in transitively
	// by chokidar on macOS. esbuild can't bundle .node files, and chokidar
	// guards its require() in a try/catch, so mark it external.
	external: ['fsevents'],
	plugins: [rawMdPlugin],
	define: {
		__MAESTRO_CLI_VERSION__: JSON.stringify(cliVersion),
	},
});
