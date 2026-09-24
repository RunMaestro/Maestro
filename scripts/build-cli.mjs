#!/usr/bin/env node
/**
 * Build script for the Maestro CLI using esbuild.
 *
 * Bundles the CLI into a single JavaScript file that can be run with Node.js.
 * Users of this CLI already have Node.js installed (required for Claude Code),
 * so we don't need standalone binaries.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
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

async function build() {
	console.log('Building CLI with esbuild...');

	try {
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/cli/index.ts')],
			bundle: true,
			platform: 'node',
			target: 'node20',
			outfile,
			format: 'cjs',
			sourcemap: true,
			minify: false, // Keep readable for debugging
			// Note: shebang is already in src/cli/index.ts, no banner needed
			// fsevents is an optional native module (.node) pulled in transitively
			// by chokidar on macOS. esbuild can't bundle .node files, and chokidar
			// guards its require() in a try/catch, so mark it external.
			//
			// 'electron' and 'electron-store' are external for a different reason:
			// the `electron` npm package's own index.js resolves its binary path
			// relative to ITS OWN file location (a `path.txt` sibling under
			// node_modules/electron/), and esbuild inlining it breaks that
			// resolution - bundled, it throws "Electron failed to install
			// correctly" the moment anything requires it, even though
			// `require('electron')` under plain Node works fine unbundled (it
			// resolves to the binary path string, not the Electron API surface).
			// `standalone Cue engine` (`cue engine start`) is the first CLI
			// command whose import graph reaches an electron-store-backed module
			// (`claude-usage-startup.ts`, via `resolveClaudeSpawnMode.ts`), so
			// this was a latent bug no prior command tripped.
			//
			// 'better-sqlite3' is external for the same class of reason: it is a
			// native addon, and its `bindings` resolver locates the compiled
			// `.node` file by walking up from ITS OWN package directory
			// (node_modules/better-sqlite3/...). Bundled, that directory doesn't
			// exist at runtime - the JS is inlined into this single file - so
			// `bindings` searches paths relative to the bundle's location
			// instead and never finds the real binary ("Could not locate the
			// bindings file"). `cue-db.ts` (Cue's SQLite journal) is, like
			// electron above, newly reachable from a CLI command via `cue
			// engine`; no earlier command touched it. Packaging note: shipping
			// `cue engine` in the built app additionally requires bundling
			// `node_modules/better-sqlite3`'s compiled binary as an
			// extraResource alongside `maestro-cli.js`, mirroring how the
			// desktop app itself already ships it for its own Cue database -
			// not yet wired into the packaging config (see
			// Plans/maestro-lib-cli-migration.md's standalone-engine section).
			external: ['fsevents', 'electron', 'electron-store', 'better-sqlite3'],
			plugins: [rawMdPlugin],
			define: {
				__MAESTRO_CLI_VERSION__: JSON.stringify(cliVersion),
			},
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
