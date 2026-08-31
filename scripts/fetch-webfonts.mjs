#!/usr/bin/env node
/**
 * Download Maestro's bundled webfonts and generate their @font-face CSS.
 *
 * Why bundle rather than link Google's CDN (which is what index.html did for
 * JetBrains Mono): a linked font is a network round trip on every launch, it
 * fails on an offline or air-gapped machine, it needs a CSP hole for
 * fonts.gstatic.com, and it tells Google every time someone opens the app.
 * Bundled fonts have none of those properties and are guaranteed present, which
 * is what lets the picker promise a face exists rather than guess.
 *
 * Only OFL / Apache-2.0 families are listed. The proprietary system faces
 * (Menlo, SF Mono, Consolas, Segoe UI, Arial, Helvetica, Verdana, Tahoma,
 * Georgia, Avenir Next) are licensed to the operating system and cannot be
 * redistributed, so they stay system-only in the picker. Where a metric
 * compatible open substitute exists it is bundled and cross-referenced instead:
 * Arimo for Arial/Helvetica, Cousine for Courier New, Tinos for Times New
 * Roman, Gelasio for Georgia.
 *
 * Google DOES answer css2 for some of those proprietary names, serving them
 * from an undocumented `/l/font` endpoint intended for its own products. Do not
 * be tempted: that is not part of the open library and carries no third-party
 * embedding license.
 *
 * Usage: node scripts/fetch-webfonts.mjs [--check]
 *   --check  verify every family still resolves and report sizes, write nothing
 */

import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'src/renderer/public/fonts');
const CSS_OUT = path.join(REPO_ROOT, 'src/renderer/generated-fonts.css');

// A modern Chrome UA is what makes Google serve woff2 (and the variable font)
// rather than the ttf it hands to unknown clients.
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * `axis` is the css2 weight descriptor. Variable families take a range so one
 * file covers every weight the UI asks for; static ones list the weights we
 * actually use, since fetching a family's full static set would multiply the
 * bundle for weights nothing renders.
 */
const FAMILIES = [
	// --- Monospace ---
	{ name: 'JetBrains Mono', axis: 'wght@400..700', kind: 'mono' },
	{ name: 'Fira Code', axis: 'wght@400..700', kind: 'mono' },
	{ name: 'Roboto Mono', axis: 'wght@400..700', kind: 'mono' },
	{ name: 'Source Code Pro', axis: 'wght@400..700', kind: 'mono' },
	{ name: 'IBM Plex Mono', axis: 'wght@400;500;600;700', kind: 'mono' },
	{ name: 'Inconsolata', axis: 'wght@400..700', kind: 'mono' },
	{ name: 'Cousine', axis: 'wght@400;700', kind: 'mono' },
	// --- Proportional ---
	{ name: 'Inter', axis: 'wght@400..700', kind: 'sans' },
	{ name: 'Roboto', axis: 'wght@400..700', kind: 'sans' },
	{ name: 'Open Sans', axis: 'wght@400..700', kind: 'sans' },
	{ name: 'Lato', axis: 'wght@400;700', kind: 'sans' },
	{ name: 'Source Sans 3', axis: 'wght@400..700', kind: 'sans' },
	{ name: 'Nunito Sans', axis: 'wght@400..700', kind: 'sans' },
	{ name: 'Figtree', axis: 'wght@400..700', kind: 'sans' },
	{ name: 'Arimo', axis: 'wght@400..700', kind: 'sans' },
	// --- Serif ---
	{ name: 'Gelasio', axis: 'wght@400..700', kind: 'serif' },
	{ name: 'Tinos', axis: 'wght@400;700', kind: 'serif' },
];

/** Subsets worth shipping. `latin-ext` covers accented European text. */
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

function slugify(name) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

async function fetchCss(family) {
	const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family.name)}:${family.axis}&display=swap`;
	const res = await fetch(url, { headers: { 'User-Agent': UA } });
	if (!res.ok) throw new Error(`${family.name}: css2 returned ${res.status}`);
	return res.text();
}

/**
 * Split a Google stylesheet into its @font-face blocks, keeping the subset
 * comment that precedes each one so we can drop the subsets we do not ship.
 */
function parseFaces(css) {
	const faces = [];
	const re = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gi;
	let match;
	while ((match = re.exec(css)) !== null) {
		const [, subset, block] = match;
		const src = (block.match(/src:\s*url\(([^)]+)\)/) || [])[1];
		const weight = (block.match(/font-weight:\s*([^;]+);/) || [])[1]?.trim() ?? '400';
		const style = (block.match(/font-style:\s*([^;]+);/) || [])[1]?.trim() ?? 'normal';
		const unicodeRange = (block.match(/unicode-range:\s*([^;]+);/) || [])[1]?.trim();
		if (src) faces.push({ subset, src, weight, style, unicodeRange });
	}
	return faces;
}

async function main() {
	const checkOnly = process.argv.includes('--check');

	if (!checkOnly) {
		await rm(OUT_DIR, { recursive: true, force: true });
		await mkdir(OUT_DIR, { recursive: true });
	}

	const cssChunks = [
		'/* GENERATED by scripts/fetch-webfonts.mjs - do not edit by hand. */',
		'/* Re-run `npm run fonts:fetch` to refresh. */',
		'',
	];
	const manifest = [];
	let totalBytes = 0;

	for (const family of FAMILIES) {
		const css = await fetchCss(family);
		const faces = parseFaces(css).filter((f) => KEEP_SUBSETS.has(f.subset));
		if (faces.length === 0) throw new Error(`${family.name}: no usable subsets found`);

		const slug = slugify(family.name);
		let familyBytes = 0;

		for (const [i, face] of faces.entries()) {
			const res = await fetch(face.src, { headers: { 'User-Agent': UA } });
			if (!res.ok) throw new Error(`${family.name}: font file returned ${res.status}`);
			const buf = Buffer.from(await res.arrayBuffer());
			familyBytes += buf.length;

			const file = `${slug}-${face.subset}-${face.weight.replace(/\s+/g, '_')}-${i}.woff2`;
			if (!checkOnly) await writeFile(path.join(OUT_DIR, file), buf);

			cssChunks.push(
				'@font-face {',
				`\tfont-family: '${family.name}';`,
				`\tfont-style: ${face.style};`,
				`\tfont-weight: ${face.weight};`,
				// `swap` renders fallback text immediately and restyles when the
				// font lands. These are local files, so the swap window is
				// effectively zero - but a blocking `block` would flash invisible
				// text if the disk is slow.
				'\tfont-display: swap;',
				`\tsrc: url('/fonts/${file}') format('woff2');`,
				...(face.unicodeRange ? [`\tunicode-range: ${face.unicodeRange};`] : []),
				'}',
				''
			);
		}

		totalBytes += familyBytes;
		manifest.push({ name: family.name, kind: family.kind, bytes: familyBytes });
		console.log(
			`  ${family.name.padEnd(20)} ${String(faces.length).padStart(2)} files  ${(familyBytes / 1024).toFixed(0).padStart(5)} KB`
		);
	}

	if (!checkOnly) {
		await writeFile(CSS_OUT, cssChunks.join('\n'));
		const written = (await readdir(OUT_DIR)).length;
		console.log(`\nWrote ${written} files to ${path.relative(REPO_ROOT, OUT_DIR)}`);
		console.log(`Wrote ${path.relative(REPO_ROOT, CSS_OUT)}`);
	}
	console.log(
		`\nTotal: ${(totalBytes / 1024 / 1024).toFixed(2)} MB across ${FAMILIES.length} families`
	);
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
