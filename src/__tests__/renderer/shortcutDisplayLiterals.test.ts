/**
 * Regression test: prevents hard-coded keyboard shortcut literals from being
 * committed to the component tree.
 *
 * In Vim mode, a hard-coded "Cmd+Shift+H" on screen becomes a lie - the chord
 * fires something else. This test scans for the glyph forms (`⌘`, `⌥`, `⇧`, `⌃`)
 * and the spelled-out forms (`Cmd+`, `Ctrl+`, `Alt+`, `Shift+`, `Meta+`,
 * `Control+`) in JSX text, string props, and title attributes, and fails when it
 * finds them outside an explicit allowlist.
 *
 * The allowlist documents exceptions: shortcuts that belong to third-party tools,
 * local UI conventions that are not rebindable Maestro actions, and documented
 * keybindings from external systems. Each entry carries a comment justifying why
 * it is safe to exclude.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const RENDERER_COMPONENTS_ROOT = join(__dirname, '../../renderer/components');

// Allowlist entries: { file: string, pattern: string, reason: string }
// `file` is a path fragment (can be partial match), `pattern` is the literal
// string that appears in the file. Line numbers and full paths are reported
// when matches are found.
const ALLOWLIST: Array<{ file: string; pattern: string; reason: string }> = [
	// Local UI conventions: search navigation, not global rebindable shortcuts
	{
		file: 'AutoRunSearchBar.tsx',
		pattern: 'Shift+Enter',
		reason: 'Local search navigation - not a rebindable Maestro binding',
	},
	{
		file: 'OutputSearchBar.tsx',
		pattern: 'Shift+Enter',
		reason: 'Local search navigation - not a rebindable Maestro binding',
	},
	{
		file: 'TerminalSearchBar.tsx',
		pattern: 'Shift+Enter',
		reason: 'Local search navigation - not a rebindable Maestro binding',
	},
	{
		file: 'FilePreview.tsx',
		pattern: 'Shift+Enter',
		reason: 'Local file search navigation - not a rebindable Maestro binding',
	},
	{
		file: 'BrowserTabView.tsx',
		pattern: 'Shift+Enter',
		reason: 'Local browser search navigation - not a rebindable Maestro binding',
	},
	{
		file: 'DocumentGraphView.tsx',
		pattern: 'Shift+scroll',
		reason: 'Local graph scroll mode behavior - not a rebindable Maestro binding',
	},
	{
		file: 'GraphLegend.tsx',
		pattern: 'Shift+Scroll',
		reason: 'Local graph legend scroll behavior - not a rebindable Maestro binding',
	},

	// Documentation comments and docstrings that describe chords
	{
		file: 'ShortcutHint.tsx',
		pattern: '⌘',
		reason: 'Documentation in comments showing chord format examples',
	},
	{
		file: 'ShortcutHint.tsx',
		pattern: '⇧',
		reason: 'Documentation in comments showing chord format examples',
	},
	{
		file: 'ShortcutHint.tsx',
		pattern: 'Ctrl+',
		reason: 'Documentation in comments showing chord format examples',
	},
	{
		file: 'ModelEffortPills.tsx',
		pattern: '⌥',
		reason: 'Documentation in JSDoc describing the chord format ("⌥ ⌘ .")',
	},
	{
		file: 'ModelEffortPills.tsx',
		pattern: '⌘',
		reason: 'Documentation in JSDoc describing the chord format ("⌥ ⌘ .")',
	},

	// Input fields and rename dialogs with local key handling
	{
		file: 'RenameTabModal.tsx',
		pattern: 'Shift+',
		reason: 'Local rename input field behavior - not a global shortcut',
	},
	{
		file: 'InputBehaviorSection.tsx',
		pattern: 'Shift+',
		reason: 'Settings documentation for local Enter/Shift+Enter behavior',
	},

	// Comments and documentation describing third-party or external behavior
	{
		file: 'GroupChatInput.tsx',
		pattern: 'Cmd+Enter',
		reason: 'Documentation of external behavior in comments',
	},
	{
		file: 'MemoryViewer.tsx',
		pattern: 'Cmd/Ctrl+F',
		reason: 'Documentation in comments of surface-local chord',
	},
	{
		file: 'MemoryViewer.tsx',
		pattern: 'Cmd/Ctrl+E',
		reason: 'Documentation in comments of surface-local chord',
	},
	{
		file: 'MemoryViewer.tsx',
		pattern: 'Cmd/Ctrl+G',
		reason: 'Documentation in comments of surface-local chord',
	},
	{
		file: 'MemoryViewer.tsx',
		pattern: 'Cmd/Ctrl+U',
		reason: 'Documentation in comments of surface-local chord',
	},
	{
		file: 'KeyboardMasteryCelebration.tsx',
		pattern: 'Ctrl+/',
		reason: 'Documentation in comments of keyboard shortcut',
	},
];

function walk(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const s = statSync(full);
		if (s.isDirectory()) walk(full, files);
		else if (full.endsWith('.tsx')) files.push(full);
	}
	return files;
}

type Violation = {
	file: string;
	line: number;
	literal: string;
};

function scanForLiterals(): Violation[] {
	const violations: Violation[] = [];

	// Pattern to find actual hard-coded chord literals in strings and JSX
	// Match when the literal appears between quotes or in JSX text
	// We look for full lines without comments, then extract string content
	const literalPattern =
		/⌘|⌥|⇧|⌃|Cmd\+|Ctrl\+|Control\+|Alt\+|Shift\+|Meta\+|\bCmdShift\b|\bCtrlShift\b|\bCtrlAlt\b/g;

	for (const file of walk(RENDERER_COMPONENTS_ROOT)) {
		const src = readFileSync(file, 'utf8');
		const lines = src.split('\n');

		for (let lineNum = 0; lineNum < lines.length; lineNum++) {
			let line = lines[lineNum];

			// Remove single-line comments to avoid matching in comments
			const commentIndex = line.indexOf('//');
			if (commentIndex !== -1) {
				line = line.substring(0, commentIndex);
			}

			// Quick check: does this line have any potential literal?
			if (!line.match(literalPattern)) {
				continue;
			}

			// Extract all quoted string contents from this line
			const quotedStringsRe = /(['"`])(?:(?=(\\?))\2.)*?\1/g;
			for (const stringMatch of line.matchAll(quotedStringsRe)) {
				const quotedContent = stringMatch[0];
				// Remove the quotes
				const unquoted = quotedContent.slice(1, -1);

				// Check if this string contains a literal
				const literalMatches = [...unquoted.matchAll(literalPattern)];
				if (literalMatches.length === 0) continue;

				// Check if this is in the allowlist
				// An allowlist entry matches if the file path contains the file fragment
				// AND the original line (before comment removal) contains the pattern
				const originalLine = lines[lineNum]; // Check original line for patterns
				const isAllowed = ALLOWLIST.some((entry) => {
					const fileMatches = file.includes(entry.file);
					const patternMatches = originalLine.includes(entry.pattern);
					return fileMatches && patternMatches;
				});

				if (!isAllowed) {
					// Report each literal found in this string
					for (const match of literalMatches) {
						violations.push({
							file: file.replace(RENDERER_COMPONENTS_ROOT, 'src/renderer/components'),
							line: lineNum + 1,
							literal: match[0],
						});
					}
				}
			}

			// Also check JSX text content between > and < (but not in strings)
			// Match > text < patterns where text contains literals
			const jsxContentRe = />([^<>]*)</g;
			for (const jsxMatch of line.matchAll(jsxContentRe)) {
				const jsxContent = jsxMatch[1];
				if (jsxContent.match(literalPattern)) {
					// Check allowlist
					const isAllowed = ALLOWLIST.some((entry) => {
						const fileMatches = file.includes(entry.file);
						const patternMatches = jsxContent.includes(entry.pattern);
						return fileMatches && patternMatches;
					});

					if (!isAllowed) {
						const matches = [...jsxContent.matchAll(literalPattern)];
						for (const match of matches) {
							violations.push({
								file: file.replace(RENDERER_COMPONENTS_ROOT, 'src/renderer/components'),
								line: lineNum + 1,
								literal: match[0],
							});
						}
					}
				}
			}
		}
	}

	return violations;
}

describe('shortcut display literals regression guard', () => {
	const violations = scanForLiterals();

	it('should find test targets (sanity check)', () => {
		// Asserted on the WALK, not on the findings. `ALLOWLIST` is a non-empty
		// constant, so the old `violations.length + ALLOWLIST.length > 0` could
		// never fail: if `RENDERER_COMPONENTS_ROOT` moved or `walk` started
		// returning nothing, both tests in this file would have gone green over
		// zero scanned files, which is the one failure the guard exists to catch.
		//
		// The floor is far below the ~1300 files the tree actually holds, so it
		// survives ordinary deletions and only trips on a broken root or walk.
		expect(walk(RENDERER_COMPONENTS_ROOT).length).toBeGreaterThan(100);
	});

	it('should not have any hard-coded chord literals outside the allowlist', () => {
		const message =
			violations.length > 0
				? `Found ${violations.length} hard-coded shortcut literal(s) outside the allowlist:\n${violations
						.map(
							(v) =>
								`  ${v.file}:${v.line} - "${v.literal}"\n    Use useShortcutKeys() or resolveShortcutKeys() to display the active mode's binding.`
						)
						.join(
							'\n'
						)}\n\nAdd to ALLOWLIST in this test if the literal is not a Maestro binding (e.g. third-party tool documentation).`
				: '';
		expect(violations).toEqual([], message);
	});
});
