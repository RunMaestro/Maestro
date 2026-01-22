#!/usr/bin/env node
/**
 * Build script for the Electron preload script using esbuild.
 *
 * Bundles the preload script into a single JavaScript file.
 * This is necessary because Electron's sandboxed preload environment
 * doesn't support multi-file CommonJS requires the same way Node.js does.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const outfile = path.join(rootDir, 'dist/main/preload.js');

async function build() {
  console.log('Building preload script with esbuild...');

  try {
    await esbuild.build({
      entryPoints: [path.join(rootDir, 'src/main/preload/index.ts')],
      bundle: true,
      platform: 'node',
      target: 'node18', // Match Electron's Node version
      outfile,
      format: 'cjs',
      sourcemap: false,
      minify: false, // Keep readable for debugging
      external: ['electron'], // Don't bundle electron - it's provided by Electron runtime
    });

    const stats = fs.statSync(outfile);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(`✓ Built ${outfile} (${sizeKB} KB)`);
  } catch (error) {
    console.error('Preload build failed:', error);
    process.exit(1);
  }
}

build();
