#!/usr/bin/env node
/**
 * Build script for the permission-relay stdio MCP bridge using esbuild.
 *
 * Bundles src/main/permission-relay/bridge.ts into a single self-contained
 * Node.js script at dist/cli/permission-relay-bridge.js. Mirrors
 * scripts/build-maestro-p.mjs.
 *
 * Why a bundle (not the tsc output at dist/main/permission-relay/bridge.js):
 * Claude Code spawns this bridge as an MCP server via `process.execPath` with
 * ELECTRON_RUN_AS_NODE=1. In a PACKAGED app that plain-Node process cannot read
 * inside app.asar, so the bridge must ship OUTSIDE the asar (via
 * extraResources, same as maestro-p.js). A standalone file at the resources
 * root also can't resolve a sibling `require('./types')`, so it must be bundled
 * into one file with no relative imports. The bridge uses only Node builtins,
 * so there are no externals to leave out.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const outfile = path.join(rootDir, 'dist/cli/permission-relay-bridge.js');

async function build() {
	console.log('Building permission-relay bridge with esbuild...');

	try {
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/permission-relay/bridge.ts')],
			bundle: true,
			platform: 'node',
			target: 'node20',
			outfile,
			format: 'cjs',
			sourcemap: true,
			minify: false, // Keep readable for debugging
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
