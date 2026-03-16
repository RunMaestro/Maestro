/**
 * i18n Translation Bundle Size Check
 *
 * CI gate that enforces size budgets on translation files and verifies
 * lazy loading is correctly configured.
 *
 * Checks:
 *   1. Individual file size — no single translation JSON exceeds the per-file limit.
 *   2. Total size — all translation files combined stay under the total limit.
 *   3. Lazy loading — only English is statically bundled; other languages are
 *      code-split into separate locale-* chunks.
 *
 * Usage:
 *   npx tsx scripts/i18n-size-check.ts           # Human-readable report
 *   npx tsx scripts/i18n-size-check.ts --json     # Machine-readable output
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Configuration ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'src/shared/i18n/locales');
const RENDERER_ASSETS_DIR = path.join(ROOT, 'dist/renderer/assets');

const LANGUAGES = ['en', 'es', 'fr', 'de', 'zh', 'hi', 'ar', 'bn', 'pt'] as const;
const NAMESPACES = [
	'common',
	'settings',
	'modals',
	'menus',
	'notifications',
	'accessibility',
	'shortcuts',
] as const;

/**
 * Size budgets.
 *
 * Per-file: 200 KB — the largest namespace (modals) can reach ~160 KB for
 * non-Latin scripts (Bengali, Hindi). 200 KB provides growth headroom while
 * catching runaway additions.
 *
 * Total: 3 MB — 63 files currently total ~2.0 MB. 3 MB allows organic
 * growth and additional languages without requiring immediate budget bumps.
 */
const PER_FILE_LIMIT_BYTES = 200 * 1024; // 200 KB
const TOTAL_LIMIT_BYTES = 3 * 1024 * 1024; // 3 MB

// ── Types ──────────────────────────────────────────────────────────────────

interface FileSize {
	language: string;
	namespace: string;
	path: string;
	bytes: number;
	overBudget: boolean;
}

interface LazyLoadResult {
	passed: boolean;
	englishBundled: boolean;
	localeChunks: string[];
	missingLanguages: string[];
}

interface SizeCheckReport {
	files: FileSize[];
	totalBytes: number;
	totalLimitBytes: number;
	perFileLimitBytes: number;
	overBudgetFiles: FileSize[];
	totalOverBudget: boolean;
	lazyLoading: LazyLoadResult | null;
	passed: boolean;
}

// ── Core checks ────────────────────────────────────────────────────────────

function checkFileSizes(): { files: FileSize[]; totalBytes: number } {
	const files: FileSize[] = [];
	let totalBytes = 0;

	for (const lang of LANGUAGES) {
		for (const ns of NAMESPACES) {
			const filePath = path.join(LOCALES_DIR, lang, `${ns}.json`);
			if (!fs.existsSync(filePath)) {
				// Missing file — size zero, but note it
				files.push({
					language: lang,
					namespace: ns,
					path: filePath,
					bytes: 0,
					overBudget: false,
				});
				continue;
			}

			const stat = fs.statSync(filePath);
			const overBudget = stat.size > PER_FILE_LIMIT_BYTES;
			files.push({
				language: lang,
				namespace: ns,
				path: filePath,
				bytes: stat.size,
				overBudget,
			});
			totalBytes += stat.size;
		}
	}

	return { files, totalBytes };
}

function checkLazyLoading(): LazyLoadResult | null {
	// Skip lazy loading check if build hasn't been run
	if (!fs.existsSync(RENDERER_ASSETS_DIR)) {
		return null;
	}

	const assetFiles = fs.readdirSync(RENDERER_ASSETS_DIR);
	const localeChunkPattern = /^locale-(\w+)-[\w-]+\.js$/;
	const localeChunks: string[] = [];
	const foundLanguages = new Set<string>();

	for (const file of assetFiles) {
		const match = file.match(localeChunkPattern);
		if (match) {
			localeChunks.push(file);
			foundLanguages.add(match[1]);
		}
	}

	// English should NOT have its own locale chunk (it's bundled statically)
	const englishBundled = !foundLanguages.has('en');

	// Every non-English language should have a locale chunk
	const nonEnglishLangs = LANGUAGES.filter((l) => l !== 'en');
	const missingLanguages = nonEnglishLangs.filter((l) => !foundLanguages.has(l));

	const passed = englishBundled && missingLanguages.length === 0;

	return { passed, englishBundled, localeChunks, missingLanguages };
}

function runCheck(): SizeCheckReport {
	const { files, totalBytes } = checkFileSizes();
	const overBudgetFiles = files.filter((f) => f.overBudget);
	const totalOverBudget = totalBytes > TOTAL_LIMIT_BYTES;
	const lazyLoading = checkLazyLoading();

	const sizesPassed = overBudgetFiles.length === 0 && !totalOverBudget;
	const lazyPassed = lazyLoading === null || lazyLoading.passed;

	return {
		files,
		totalBytes,
		totalLimitBytes: TOTAL_LIMIT_BYTES,
		perFileLimitBytes: PER_FILE_LIMIT_BYTES,
		overBudgetFiles,
		totalOverBudget,
		lazyLoading,
		passed: sizesPassed && lazyPassed,
	};
}

// ── Output formatting ──────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb.toFixed(1)} KB`;
	const mb = kb / 1024;
	return `${mb.toFixed(2)} MB`;
}

function makeBar(value: number, max: number, width = 20): string {
	const ratio = Math.min(value / max, 1);
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	const color = ratio > 1 ? '\x1b[31m' : ratio > 0.8 ? '\x1b[33m' : '\x1b[32m';
	return `${color}[${'█'.repeat(filled)}${'░'.repeat(empty)}]\x1b[0m`;
}

function printReport(report: SizeCheckReport): void {
	console.log('\n\x1b[1m══════════════════════════════════════════════\x1b[0m');
	console.log('\x1b[1m  i18n Translation Bundle Size Report\x1b[0m');
	console.log('\x1b[1m══════════════════════════════════════════════\x1b[0m\n');

	// ── Per-namespace size table ──
	console.log('\x1b[1m── Size by Namespace ──\x1b[0m\n');

	// Header
	const langHeader = LANGUAGES.map((l) => l.padStart(8)).join('');
	console.log(`  ${'namespace'.padEnd(16)}${langHeader}`);
	console.log(`  ${'─'.repeat(16)}${'─'.repeat(LANGUAGES.length * 8)}`);

	for (const ns of NAMESPACES) {
		const nsFiles = report.files.filter((f) => f.namespace === ns);
		const cells = LANGUAGES.map((lang) => {
			const file = nsFiles.find((f) => f.language === lang);
			if (!file || file.bytes === 0) return '    -   ';
			const kb = (file.bytes / 1024).toFixed(0);
			const color = file.overBudget ? '\x1b[31m' : '';
			const reset = file.overBudget ? '\x1b[0m' : '';
			const marker = file.overBudget ? '!' : ' ';
			return `${color}${(kb + 'K').padStart(7)}${marker}${reset}`;
		}).join('');
		console.log(`  ${ns.padEnd(16)}${cells}`);
	}

	// ── Totals per language ──
	console.log(`  ${'─'.repeat(16)}${'─'.repeat(LANGUAGES.length * 8)}`);
	const langTotals = LANGUAGES.map((lang) => {
		const total = report.files
			.filter((f) => f.language === lang)
			.reduce((sum, f) => sum + f.bytes, 0);
		const kb = (total / 1024).toFixed(0);
		return (kb + 'K').padStart(8);
	}).join('');
	console.log(`  ${'TOTAL'.padEnd(16)}${langTotals}`);

	// ── Overall totals ──
	console.log(`\n\x1b[1m── Budget Summary ──\x1b[0m\n`);

	const totalBar = makeBar(report.totalBytes, report.totalLimitBytes);
	const totalColor = report.totalOverBudget ? '\x1b[31m' : '\x1b[32m';
	console.log(
		`  Total:    ${totalBar} ${totalColor}${formatBytes(report.totalBytes)}\x1b[0m / ${formatBytes(report.totalLimitBytes)}`
	);
	console.log(`  Per-file: max ${formatBytes(report.perFileLimitBytes)}`);
	console.log(
		`  Files:    ${report.files.length} (${LANGUAGES.length} languages × ${NAMESPACES.length} namespaces)`
	);

	// ── Over-budget files ──
	if (report.overBudgetFiles.length > 0) {
		console.log(`\n\x1b[31m── Over-Budget Files ──\x1b[0m\n`);
		for (const f of report.overBudgetFiles) {
			const excess = f.bytes - PER_FILE_LIMIT_BYTES;
			console.log(
				`  \x1b[31m✗\x1b[0m ${f.language}/${f.namespace}.json: ${formatBytes(f.bytes)} (${formatBytes(excess)} over limit)`
			);
		}
	}

	// ── Lazy loading ──
	if (report.lazyLoading) {
		console.log(`\n\x1b[1m── Lazy Loading Verification ──\x1b[0m\n`);

		const ll = report.lazyLoading;

		if (ll.englishBundled) {
			console.log('  \x1b[32m✓\x1b[0m English bundled statically (no separate locale chunk)');
		} else {
			console.log(
				'  \x1b[31m✗\x1b[0m English has a separate locale chunk — should be bundled statically'
			);
		}

		if (ll.missingLanguages.length === 0) {
			console.log(`  \x1b[32m✓\x1b[0m ${ll.localeChunks.length} lazy-loaded locale chunks found`);
		} else {
			console.log(
				`  \x1b[31m✗\x1b[0m Missing locale chunks for: ${ll.missingLanguages.join(', ')}`
			);
		}

		// Show chunk sizes
		if (ll.localeChunks.length > 0) {
			console.log('');
			for (const chunk of ll.localeChunks.sort()) {
				const chunkPath = path.join(RENDERER_ASSETS_DIR, chunk);
				const size = fs.statSync(chunkPath).size;
				console.log(`    ${chunk.padEnd(40)} ${formatBytes(size)}`);
			}
		}
	} else {
		console.log(`\n\x1b[2m── Lazy Loading Verification ──\x1b[0m\n`);
		console.log('  \x1b[33m⚠\x1b[0m Skipped — no build output found. Run `npm run build` first.');
	}

	// ── Final result ──
	console.log(`\n\x1b[1m──────────────────────────────────────────────\x1b[0m`);
	if (report.passed) {
		console.log('\x1b[32m✓ All i18n bundle size checks passed!\x1b[0m\n');
	} else {
		const reasons: string[] = [];
		if (report.overBudgetFiles.length > 0) {
			reasons.push(
				`${report.overBudgetFiles.length} file(s) over ${formatBytes(PER_FILE_LIMIT_BYTES)} limit`
			);
		}
		if (report.totalOverBudget) {
			reasons.push(
				`total size ${formatBytes(report.totalBytes)} exceeds ${formatBytes(TOTAL_LIMIT_BYTES)} budget`
			);
		}
		if (report.lazyLoading && !report.lazyLoading.passed) {
			reasons.push('lazy loading misconfigured');
		}
		console.log(`\x1b[31m✗ Failed: ${reasons.join('; ')}\x1b[0m\n`);
	}
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
	const args = process.argv.slice(2);
	const jsonMode = args.includes('--json');

	const report = runCheck();

	if (jsonMode) {
		// Strip full paths for cleaner JSON — use relative paths
		const cleanFiles = report.files.map((f) => ({
			...f,
			path: `${f.language}/${f.namespace}.json`,
		}));
		const cleanOverBudget = report.overBudgetFiles.map((f) => ({
			...f,
			path: `${f.language}/${f.namespace}.json`,
		}));
		console.log(
			JSON.stringify({ ...report, files: cleanFiles, overBudgetFiles: cleanOverBudget }, null, 2)
		);
	} else {
		printReport(report);
	}

	if (!report.passed) {
		process.exit(1);
	}
}

// Run main() only when executed directly
const isDirectRun =
	process.argv[1]?.endsWith('i18n-size-check.ts') || process.argv[1]?.includes('i18n-size-check');
if (isDirectRun) {
	main();
}

export { checkFileSizes, checkLazyLoading, runCheck, PER_FILE_LIMIT_BYTES, TOTAL_LIMIT_BYTES };
