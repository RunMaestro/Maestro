#!/usr/bin/env node
/**
 * Build script for the `maestro-p` wrapper binary using esbuild.
 *
 * Bundles src/maestro-p/index.ts into a single Node.js script at
 * dist/cli/maestro-p.js, preserves the shebang from the entry file, and
 * marks the output executable. Mirrors scripts/build-cli.mjs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildArtifact } from './lib/build.mjs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const outfile = path.join(rootDir, 'dist/cli/maestro-p.js');

const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const cliVersion = pkgJson.version;
if (typeof cliVersion !== 'string' || cliVersion.length === 0) {
	throw new Error('Cannot build maestro-p: package.json is missing a valid "version" field');
}

buildArtifact({
	name: 'maestro-p',
	entryPoint: path.join(rootDir, 'src/maestro-p/index.ts'),
	outfile,
	platform: 'node',
	target: 'node20',
	format: 'cjs',
	// Shebang lives in src/maestro-p/index.ts; esbuild preserves it.
	// node-pty ships a native prebuild that resolves relative to its
	// own package directory at runtime; bundling it breaks the
	// relative ./prebuilds/<platform>/pty.node lookup. Leaving it
	// external means `require('node-pty')` runs against the real
	// installed package, which finds its prebuild correctly.
	external: ['node-pty'],
	define: {
		__MAESTRO_P_VERSION__: JSON.stringify(cliVersion),
	},
});
