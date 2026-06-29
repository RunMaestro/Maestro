/**
 * Decoupling guard for the shared widget library
 * (src/renderer/components/widgets).
 *
 * Phase 04 inverted the dependency direction: the generic chart primitives moved
 * out of `UsageDashboard/` and into this library, with re-export shims left
 * behind. This test is the focused, enforceable assertion that the inversion
 * holds - it scans every source file under `widgets/` and fails if any of them:
 *   1. imports from a `UsageDashboard/` path (the library must not depend on the
 *      Usage Dashboard - the dependency only runs the other way), or
 *   2. references the `encoreFeatures` Encore flag bag (the library renders
 *      regardless of whether the Usage Dashboard Encore feature is enabled).
 *
 * Doc-comment prose mentions both on purpose, so we strip comments before
 * scanning and only inspect real code.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const WIDGETS_ROOT = resolve(__dirname, '../../../../renderer/components/widgets');

/** Recursively collect every .ts/.tsx file under `dir`. */
function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
			out.push(full);
		}
	}
	return out;
}

/** Strip block + line comments so doc prose can't trip the code scan. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const sourceFiles = collectSourceFiles(WIDGETS_ROOT);

describe('widget library decoupling', () => {
	it('finds the library source files', () => {
		// Sanity check so a bad path doesn't make the guards vacuously pass.
		expect(sourceFiles.length).toBeGreaterThan(5);
	});

	it('never imports from UsageDashboard/ (dependency only runs the other way)', () => {
		const offenders: string[] = [];
		for (const file of sourceFiles) {
			const code = stripComments(readFileSync(file, 'utf8'));
			const importsUsageDashboard =
				/from\s+['"][^'"]*UsageDashboard/.test(code) ||
				/import\(\s*['"][^'"]*UsageDashboard/.test(code);
			if (importsUsageDashboard) offenders.push(file.replace(WIDGETS_ROOT, 'widgets'));
		}
		expect(
			offenders,
			`These widget files import from UsageDashboard/:\n${offenders.join('\n')}`
		).toEqual([]);
	});

	it('never references the Encore feature-flag bag (renders with usageStats OFF)', () => {
		const offenders: string[] = [];
		for (const file of sourceFiles) {
			const code = stripComments(readFileSync(file, 'utf8'));
			if (/\bencoreFeatures\b/.test(code)) {
				offenders.push(file.replace(WIDGETS_ROOT, 'widgets'));
			}
		}
		expect(
			offenders,
			`These widget files reference the Encore flag bag:\n${offenders.join('\n')}`
		).toEqual([]);
	});
});
