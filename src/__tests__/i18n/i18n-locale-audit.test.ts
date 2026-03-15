/**
 * i18n Locale Audit Tests
 *
 * Codebase guardrail: verifies that all toLocaleDateString, toLocaleTimeString,
 * and date-related toLocaleString calls pass an explicit locale (typically
 * getActiveLocale()) rather than relying on browser defaults or using empty
 * arrays / undefined.
 *
 * Also verifies that document.documentElement.lang is set by the i18n system
 * so that Intl APIs resolve the correct locale.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Recursively collect all .ts/.tsx files under a directory
function collectFiles(dir: string, extensions: string[]): string[] {
	const results: string[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__tests__') {
			results.push(...collectFiles(fullPath, extensions));
		} else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
			results.push(fullPath);
		}
	}
	return results;
}

const RENDERER_DIR = path.resolve(__dirname, '../../renderer');

// Patterns that indicate a missing or incorrect locale argument
const BAD_LOCALE_PATTERNS = [
	// toLocaleDateString with empty array or undefined
	{ pattern: /\.toLocaleDateString\(\[\]/g, desc: 'toLocaleDateString([])' },
	{ pattern: /\.toLocaleDateString\(undefined/g, desc: 'toLocaleDateString(undefined)' },
	{ pattern: /\.toLocaleDateString\(\)/g, desc: 'toLocaleDateString() with no arguments' },
	// toLocaleTimeString with empty array or undefined
	{ pattern: /\.toLocaleTimeString\(\[\]/g, desc: 'toLocaleTimeString([])' },
	{ pattern: /\.toLocaleTimeString\(undefined/g, desc: 'toLocaleTimeString(undefined)' },
	{ pattern: /\.toLocaleTimeString\(\)/g, desc: 'toLocaleTimeString() with no arguments' },
	// toLocaleString on dates with empty array or undefined (but not on numbers)
	{ pattern: /\.toLocaleString\(\[\]/g, desc: 'toLocaleString([])' },
	{ pattern: /\.toLocaleString\(undefined/g, desc: 'toLocaleString(undefined)' },
];

describe('i18n Locale Audit', () => {
	const rendererFiles = collectFiles(RENDERER_DIR, ['.ts', '.tsx']);

	describe('no hardcoded or missing locale arguments in date/time formatting', () => {
		for (const { pattern, desc } of BAD_LOCALE_PATTERNS) {
			it(`should have no ${desc} calls in renderer`, () => {
				const violations: string[] = [];
				for (const filePath of rendererFiles) {
					const content = fs.readFileSync(filePath, 'utf-8');
					const matches = content.match(pattern);
					if (matches) {
						const relativePath = path.relative(RENDERER_DIR, filePath);
						violations.push(`${relativePath}: ${matches.length} occurrence(s)`);
					}
				}
				expect(violations, `Found ${desc} in:\n${violations.join('\n')}`).toHaveLength(0);
			});
		}
	});

	describe('document.documentElement.lang is set by i18n system', () => {
		it('should set document.documentElement.lang in settingsStore', () => {
			const settingsStorePath = path.resolve(RENDERER_DIR, 'stores/settingsStore.ts');
			const content = fs.readFileSync(settingsStorePath, 'utf-8');
			expect(content).toContain('document.documentElement.lang');
		});
	});

	describe('getActiveLocale is used for explicit locale passing', () => {
		it('should import getActiveLocale in files that call toLocaleDateString with locale', () => {
			// Spot-check key files that were updated
			const keyFiles = [
				'components/History/ActivityGraph.tsx',
				'components/GroupChatHistoryPanel.tsx',
				'components/BatchRunnerModal.tsx',
				'components/TerminalOutput.tsx',
				'components/GitLogViewer.tsx',
			];

			for (const relPath of keyFiles) {
				const filePath = path.resolve(RENDERER_DIR, relPath);
				if (fs.existsSync(filePath)) {
					const content = fs.readFileSync(filePath, 'utf-8');
					const hasLocaleDateCalls =
						content.includes('.toLocaleDateString(') || content.includes('.toLocaleTimeString(');
					if (hasLocaleDateCalls) {
						expect(
							content,
							`${relPath} uses date formatting but doesn't import getActiveLocale`
						).toContain('getActiveLocale');
					}
				}
			}
		});
	});
});
