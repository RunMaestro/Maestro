#!/usr/bin/env node
/**
 * Build script for the Electron preload bundles using esbuild.
 *
 * Bundles each preload entry into a single JavaScript file.
 * This is necessary because Electron's sandboxed preload environment
 * doesn't support multi-file CommonJS requires the same way Node.js does.
 */

import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const distMainDir = path.join(rootDir, 'dist/main');
const preloadOutfile = path.join(distMainDir, 'preload.js');
const consentPreloadOutfile = path.join(distMainDir, 'consent-preload.js');
const pluginPanelPreloadOutfile = path.join(distMainDir, 'plugin-panel-preload.js');
const consentHtmlSrc = path.join(rootDir, 'src/main/consent/consent.html');
const consentHtmlDest = path.join(distMainDir, 'consent.html');

// Shared esbuild options for every preload bundle. Sandboxed preloads cannot use
// multi-file CommonJS requires, so each entry is bundled into one CJS file with
// electron kept external (provided by the Electron runtime).
const sharedOptions = {
	bundle: true,
	platform: 'node',
	target: 'node18', // Match Electron's Node version
	format: 'cjs',
	sourcemap: false,
	minify: false, // Keep readable for debugging
	external: ['electron'], // Don't bundle electron - it's provided by Electron runtime
};

function logBuilt(file) {
	const stats = fs.statSync(file);
	const sizeKB = (stats.size / 1024).toFixed(1);
	console.log(`✓ Built ${file} (${sizeKB} KB)`);
}

async function build() {
	console.log('Building preload scripts with esbuild...');

	try {
		// Main renderer preload (window.maestro).
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/preload/index.ts')],
			outfile: preloadOutfile,
			...sharedOptions,
		});
		logBuilt(preloadOutfile);

		// Isolated plugin-consent preload (window.pluginConsent) for the dedicated,
		// host-owned consent window. Same options as the main preload.
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/preload/consent.ts')],
			outfile: consentPreloadOutfile,
			...sharedOptions,
		});
		logBuilt(consentPreloadOutfile);

		// Broker-only plugin-panel preload for panel <webview> guests: the one-way
		// postMessage -> sendToHost bridge. Forced by the main process in
		// will-attach-webview; never referenced by the renderer.
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/preload/plugin-panel.ts')],
			outfile: pluginPanelPreloadOutfile,
			...sharedOptions,
		});
		logBuilt(pluginPanelPreloadOutfile);

		// Copy the static consent page next to its preload.
		fs.mkdirSync(distMainDir, { recursive: true });
		fs.copyFileSync(consentHtmlSrc, consentHtmlDest);
		console.log(`✓ Copied ${consentHtmlDest}`);
	} catch (error) {
		console.error('Preload build failed:', error);
		process.exit(1);
	}
}

build();
