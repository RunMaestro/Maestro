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
const dataviewGuestPreloadOutfile = path.join(distMainDir, 'dataview-guest-preload.js');
const consentHtmlSrc = path.join(rootDir, 'src/main/consent/consent.html');
const consentHtmlDest = path.join(distMainDir, 'consent.html');
const dataviewGuestEntry = path.join(rootDir, 'src/renderer/dataview-sandbox/guest.ts');
const dataviewGuestTemplate = path.join(rootDir, 'src/renderer/dataview-sandbox/guest.html');
const dataviewGuestOutfile = path.join(distMainDir, 'dataview-guest.html');
const DATAVIEW_GUEST_MARKER = '<!-- @dataview-guest-runtime -->';

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

/**
 * JavaScript made safe to sit inside a `<script>` element: no `</script` to end it early and no `<!--` to
 * change how the HTML parser reads it. esbuild already escapes `</script` in strings; this also covers
 * comments and regular expressions. Same idea as `inlineScript()` in src/main/codex-visualization.ts.
 */
function escapeInlineScript(source) {
	return source.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '\\x3C!--');
}

/**
 * The DataviewJS sandbox guest page (D4, DEV-7 in docs/agent-guides/DATAVIEW.md): the guest runtime as one
 * browser IIFE, inlined into guest.html, because the guest CSP allows inline script only. Main serves the
 * result inside the isolated <webview> and adds the CSP header and meta tag.
 */
async function buildDataviewGuest() {
	const result = await esbuild.build({
		entryPoints: [dataviewGuestEntry],
		bundle: true,
		platform: 'browser',
		format: 'iife',
		target: 'es2022',
		sourcemap: false,
		minify: false,
		write: false,
	});
	const template = fs.readFileSync(dataviewGuestTemplate, 'utf8');
	if (template.split(DATAVIEW_GUEST_MARKER).length !== 2) {
		throw new Error(`${dataviewGuestTemplate} must hold ${DATAVIEW_GUEST_MARKER} exactly once`);
	}
	const script = `<script>\n${escapeInlineScript(result.outputFiles[0].text)}</script>`;
	// A replacer function, so `$&` and friends in the bundle stay literal.
	fs.writeFileSync(
		dataviewGuestOutfile,
		template.replace(DATAVIEW_GUEST_MARKER, () => script)
	);
	logBuilt(dataviewGuestOutfile);
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
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/lite/preload.ts')],
			outfile: path.join(distMainDir, 'lite/preload.js'),
			...sharedOptions,
		});
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/lite/pairing/host-preload.ts')],
			outfile: path.join(distMainDir, 'lite/pairing/host-preload.js'),
			...sharedOptions,
		});

		// Isolated plugin-consent preload (window.pluginConsent) for the dedicated,
		// host-owned consent window. Same options as the main preload.
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/preload/consent.ts')],
			outfile: consentPreloadOutfile,
			...sharedOptions,
		});
		logBuilt(consentPreloadOutfile);

		// Broker-only plugin-panel preload for panel <webview> guests: the one-way
		// postMessage -> sendToHost bridge plus host theme application. Forced in
		// will-attach-webview; never referenced by the renderer.
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/preload/plugin-panel.ts')],
			outfile: pluginPanelPreloadOutfile,
			...sharedOptions,
		});
		logBuilt(pluginPanelPreloadOutfile);

		// Bridge-only preload for DataviewJS guests (D4): relays the sandbox
		// bridge and the theme, exposes nothing. Forced in will-attach-webview
		// (src/main/dataview/guest-host.ts names the file); never referenced by
		// the renderer.
		await esbuild.build({
			entryPoints: [path.join(rootDir, 'src/main/preload/dataview-guest.ts')],
			outfile: dataviewGuestPreloadOutfile,
			...sharedOptions,
		});
		logBuilt(dataviewGuestPreloadOutfile);

		await buildDataviewGuest();

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
