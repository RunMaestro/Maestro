/**
 * i18n Bundle Size Check Tests
 *
 * Runs the same size budget assertions as scripts/i18n-size-check.ts
 * so that CI fails if translation files exceed size limits.
 * Also validates the lazy loading configuration in source code.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	checkFileSizes,
	checkLazyLoading,
	runCheck,
	PER_FILE_LIMIT_BYTES,
	TOTAL_LIMIT_BYTES,
} from '../../../scripts/i18n-size-check';

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

const LOCALES_DIR = path.resolve(__dirname, '../../../src/shared/i18n/locales');

describe('i18n Bundle Size Check', () => {
	describe('file size budgets', () => {
		it('finds all 63 translation files (9 languages × 7 namespaces)', () => {
			const { files } = checkFileSizes();
			expect(files).toHaveLength(LANGUAGES.length * NAMESPACES.length);
		});

		it('every translation file exists and is non-empty', () => {
			for (const lang of LANGUAGES) {
				for (const ns of NAMESPACES) {
					const filePath = path.join(LOCALES_DIR, lang, `${ns}.json`);
					expect(fs.existsSync(filePath), `${lang}/${ns}.json should exist`).toBe(true);
					const stat = fs.statSync(filePath);
					expect(stat.size, `${lang}/${ns}.json should be non-empty`).toBeGreaterThan(0);
				}
			}
		});

		it('no individual file exceeds the per-file limit', () => {
			const { files } = checkFileSizes();
			const overBudget = files.filter((f) => f.overBudget);
			if (overBudget.length > 0) {
				const details = overBudget
					.map(
						(f) =>
							`${f.language}/${f.namespace}.json: ${(f.bytes / 1024).toFixed(1)} KB (limit: ${(PER_FILE_LIMIT_BYTES / 1024).toFixed(0)} KB)`
					)
					.join('\n');
				expect.fail(`Over-budget files:\n${details}`);
			}
		});

		it('total size of all translation files is under budget', () => {
			const { totalBytes } = checkFileSizes();
			expect(
				totalBytes,
				`Total ${(totalBytes / 1024 / 1024).toFixed(2)} MB exceeds budget of ${(TOTAL_LIMIT_BYTES / 1024 / 1024).toFixed(0)} MB`
			).toBeLessThanOrEqual(TOTAL_LIMIT_BYTES);
		});

		it('English files are smaller than or equal to non-Latin script files', () => {
			// Sanity check: non-Latin scripts (Bengali, Hindi, Arabic) should be
			// larger than English due to multi-byte characters. If English is larger,
			// something may be wrong with the translations.
			const { files } = checkFileSizes();
			for (const ns of NAMESPACES) {
				const enFile = files.find((f) => f.language === 'en' && f.namespace === ns);
				const bnFile = files.find((f) => f.language === 'bn' && f.namespace === ns);
				if (enFile && bnFile && bnFile.bytes > 0) {
					expect(
						enFile.bytes,
						`en/${ns}.json should not be larger than bn/${ns}.json`
					).toBeLessThanOrEqual(bnFile.bytes);
				}
			}
		});
	});

	describe('lazy loading configuration', () => {
		it('only English is statically imported in i18n config', () => {
			// Verify the renderer config only bundles English statically
			const configPath = path.resolve(__dirname, '../../../src/shared/i18n/config.ts');
			const configContent = fs.readFileSync(configPath, 'utf-8');

			// English imports should be present
			expect(configContent).toContain("from './locales/en/common.json'");

			// Non-English static imports should NOT be present
			for (const lang of LANGUAGES) {
				if (lang === 'en') continue;
				expect(
					configContent,
					`config.ts should not statically import ${lang} translations`
				).not.toMatch(new RegExp(`from\\s+['"]\\.\/locales\\/${lang}\\/`));
			}
		});

		it('uses dynamic import for non-English languages', () => {
			const configPath = path.resolve(__dirname, '../../../src/shared/i18n/config.ts');
			const configContent = fs.readFileSync(configPath, 'utf-8');

			// Should use resourcesToBackend with dynamic import
			expect(configContent).toContain('resourcesToBackend');
			expect(configContent).toMatch(/import\(`\.\/locales\/\$\{/);
		});

		it('detects lazy-loaded locale chunks in build output (if built)', () => {
			const result = checkLazyLoading();
			if (result === null) {
				// No build output — skip (CI will have build output)
				return;
			}

			expect(result.englishBundled, 'English should be bundled statically').toBe(true);
			expect(
				result.missingLanguages,
				`Missing locale chunks for: ${result.missingLanguages.join(', ')}`
			).toHaveLength(0);
			expect(result.localeChunks.length).toBe(LANGUAGES.length - 1); // All except English
		});
	});

	describe('overall check', () => {
		it('runCheck() passes with current translation files', () => {
			const report = runCheck();
			if (!report.passed) {
				const reasons: string[] = [];
				if (report.overBudgetFiles.length > 0) {
					reasons.push(`${report.overBudgetFiles.length} file(s) over per-file limit`);
				}
				if (report.totalOverBudget) {
					reasons.push('total size over budget');
				}
				if (report.lazyLoading && !report.lazyLoading.passed) {
					reasons.push('lazy loading check failed');
				}
				expect.fail(`Size check failed: ${reasons.join('; ')}`);
			}
		});
	});
});
