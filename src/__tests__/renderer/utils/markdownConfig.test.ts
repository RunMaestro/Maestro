import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock react-syntax-highlighter before importing the module under test
vi.mock('react-syntax-highlighter', () => ({
	Prism: vi.fn(),
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

import {
	generateProseStyles,
	generateAutoRunProseStyles,
	generateTerminalProseStyles,
	generateInlineWizardPreviewProseStyles,
	generateDiffViewStyles,
	createWizardBubbleMarkdownComponents,
	createReleaseNotesMarkdownComponents,
	createMarkdownComponents,
	REMARK_GFM_PLUGINS,
} from '../../../renderer/utils/markdownConfig';
import type { Theme } from '../../../shared/theme-types';

/**
 * Tests for markdown configuration utilities.
 *
 * Covers:
 * - generateProseStyles: CSS generation with all option permutations
 * - generateAutoRunProseStyles: convenience wrapper with specific defaults
 * - generateTerminalProseStyles: terminal-specific CSS generation
 * - generateDiffViewStyles: diff viewer CSS generation
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentDim: 'rgba(0, 102, 255, 0.2)',
		accentText: '#0066ff',
		accentForeground: '#ffffff',
		success: '#00cc00',
		warning: '#ffaa00',
		error: '#ff0000',
		bgMain: '#1a1a1a',
		bgSidebar: '#2a2a2a',
		bgActivity: '#333333',
		border: '#444444',
	},
};

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// generateProseStyles
// ---------------------------------------------------------------------------

describe('generateProseStyles', () => {
	describe('default options', () => {
		it('should return a non-empty CSS string', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toBeTruthy();
			expect(typeof css).toBe('string');
		});

		it('should use .prose selector without scope prefix', () => {
			const css = generateProseStyles({ theme: mockTheme });
			// Should have rules starting with .prose
			expect(css).toContain('.prose');
			// Should not contain an unexpected scope prefix
			expect(css).not.toMatch(/\.\S+ \.prose/);
		});

		it('should include heading rules (h1-h6)', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain('.prose h1');
			expect(css).toContain('.prose h2');
			expect(css).toContain('.prose h3');
			expect(css).toContain('.prose h4');
			expect(css).toContain('.prose h5');
			expect(css).toContain('.prose h6');
		});

		it('should include paragraph, list, code, and table rules', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain('.prose p');
			expect(css).toContain('.prose ul');
			expect(css).toContain('.prose ol');
			expect(css).toContain('.prose code');
			expect(css).toContain('.prose pre');
			expect(css).toContain('.prose table');
			expect(css).toContain('.prose th');
			expect(css).toContain('.prose td');
		});

		it('should include blockquote, link, and hr rules', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain('.prose blockquote');
			expect(css).toContain('.prose a');
			expect(css).toContain('.prose hr');
		});

		it('should include checkbox styles by default (includeCheckboxStyles defaults to true)', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain('input[type="checkbox"]');
			expect(css).toContain('input[type="checkbox"]:checked');
			expect(css).toContain('input[type="checkbox"]:hover');
		});

		it('should use textMain color for all headings by default (coloredHeadings defaults to false)', () => {
			const css = generateProseStyles({ theme: mockTheme });
			// h1 through h5 should use textMain
			expect(css).toContain(`.prose h1 { color: ${mockTheme.colors.textMain}`);
			expect(css).toContain(`.prose h2 { color: ${mockTheme.colors.textMain}`);
			expect(css).toContain(`.prose h3 { color: ${mockTheme.colors.textMain}`);
			expect(css).toContain(`.prose h4 { color: ${mockTheme.colors.textMain}`);
			expect(css).toContain(`.prose h5 { color: ${mockTheme.colors.textMain}`);
			expect(css).toContain(`.prose h6 { color: ${mockTheme.colors.textMain}`);
		});

		it('should use standard (non-compact) margins by default', () => {
			const css = generateProseStyles({ theme: mockTheme });
			// Standard heading margin is 0.67em 0
			expect(css).toContain('margin: 0.67em 0 !important');
			// Standard paragraph margin is 0.5em 0
			expect(css).toContain(
				`.prose p { color: ${mockTheme.colors.textMain}; margin: 0.5em 0 !important`
			);
		});

		it('should not include first-child/last-child overrides by default (compactSpacing defaults to false)', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).not.toContain('*:first-child { margin-top: 0 !important; }');
			expect(css).not.toContain('*:last-child { margin-bottom: 0 !important; }');
		});
	});

	describe('coloredHeadings option', () => {
		it('should use accent for h1, success for h2, warning for h3 when true', () => {
			const css = generateProseStyles({ theme: mockTheme, coloredHeadings: true });
			expect(css).toContain(`.prose h1 { color: ${mockTheme.colors.accent}`);
			expect(css).toContain(`.prose h2 { color: ${mockTheme.colors.success}`);
			expect(css).toContain(`.prose h3 { color: ${mockTheme.colors.warning}`);
		});

		it('should use textMain for h4 and h5 regardless of coloredHeadings', () => {
			const css = generateProseStyles({ theme: mockTheme, coloredHeadings: true });
			expect(css).toContain(`.prose h4 { color: ${mockTheme.colors.textMain}`);
			expect(css).toContain(`.prose h5 { color: ${mockTheme.colors.textMain}`);
		});

		it('should use textDim for h6 when coloredHeadings is true', () => {
			const css = generateProseStyles({ theme: mockTheme, coloredHeadings: true });
			expect(css).toContain(`.prose h6 { color: ${mockTheme.colors.textDim}`);
		});

		it('should use textMain for h6 when coloredHeadings is false', () => {
			const css = generateProseStyles({ theme: mockTheme, coloredHeadings: false });
			expect(css).toContain(`.prose h6 { color: ${mockTheme.colors.textMain}`);
		});

		it('should use textMain for all headings when false', () => {
			const css = generateProseStyles({ theme: mockTheme, coloredHeadings: false });
			for (let i = 1; i <= 6; i++) {
				expect(css).toContain(`.prose h${i} { color: ${mockTheme.colors.textMain}`);
			}
		});
	});

	describe('compactSpacing option', () => {
		it('should include first-child and last-child margin overrides when true', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain('> *:first-child { margin-top: 0 !important; }');
			expect(css).toContain('> *:last-child { margin-bottom: 0 !important; }');
		});

		it('should include global zero margin rule when true', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain('.prose * { margin-top: 0; margin-bottom: 0; }');
		});

		it('should use smaller heading margins when true', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			// Compact heading margin is 0.25em 0
			expect(css).toContain(
				`.prose h1 { color: ${mockTheme.colors.textMain}; font-size: 2em; font-weight: bold; margin: 0.25em 0 !important`
			);
		});

		it('should use zero paragraph margin when true', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain(`.prose p { color: ${mockTheme.colors.textMain}; margin: 0 !important`);
		});

		it('should include p+p spacing rule when true', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain('.prose p + p { margin-top: 0.5em !important; }');
		});

		it('should hide empty paragraphs when true', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain('.prose p:empty { display: none; }');
		});

		it('should use 2em padding-left for lists when true', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain('padding-left: 2em');
		});

		it('should use 1.5em padding-left for lists when false', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: false });
			expect(css).toContain('padding-left: 1.5em');
		});

		it('should include nested list margin override when true', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain('.prose li ul, .prose li ol { margin: 0 !important');
		});

		it('should include baseline alignment selectors for styled first-child content inside list-item paragraphs', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain(
				'.prose li > p:first-child > strong:first-child, .prose li > p:first-child > b:first-child, .prose li > p:first-child > em:first-child, .prose li > p:first-child > code:first-child, .prose li > p:first-child > a:first-child { vertical-align: baseline; line-height: inherit; }'
			);
		});

		it('should normalize only first list-item paragraph inline and keep subsequent paragraphs block-level', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: false });
			expect(css).toContain(
				'.prose li > p:first-child { margin: 0 !important; display: inline; vertical-align: baseline; line-height: inherit; }'
			);
			expect(css).toContain(
				'.prose li > p:not(:first-child) { display: block; margin: 0.5em 0 0 !important; }'
			);
		});

		it('should use 3px border-left on blockquote when compact', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain(`border-left: 3px solid ${mockTheme.colors.border}`);
		});

		it('should use 4px border-left on blockquote when not compact', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: false });
			expect(css).toContain(`border-left: 4px solid ${mockTheme.colors.border}`);
		});

		it('should use 1px border-top for hr when compact', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: true });
			expect(css).toContain(`border-top: 1px solid ${mockTheme.colors.border}`);
		});

		it('should use 2px border-top for hr when not compact', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: false });
			expect(css).toContain(`border-top: 2px solid ${mockTheme.colors.border}`);
		});

		it('should not include first-child/last-child overrides when false', () => {
			const css = generateProseStyles({ theme: mockTheme, compactSpacing: false });
			expect(css).not.toContain('*:first-child { margin-top: 0 !important; }');
			expect(css).not.toContain('*:last-child { margin-bottom: 0 !important; }');
		});
	});

	describe('includeCheckboxStyles option', () => {
		it('should include checkbox CSS when true', () => {
			const css = generateProseStyles({ theme: mockTheme, includeCheckboxStyles: true });
			expect(css).toContain('input[type="checkbox"]');
			expect(css).toContain('appearance: none');
			expect(css).toContain('input[type="checkbox"]:checked');
			expect(css).toContain('input[type="checkbox"]:hover');
		});

		it('should use accent color for checkbox border', () => {
			const css = generateProseStyles({ theme: mockTheme, includeCheckboxStyles: true });
			expect(css).toContain(`border: 2px solid ${mockTheme.colors.accent}`);
		});

		it('should use accent color for checked checkbox background', () => {
			const css = generateProseStyles({ theme: mockTheme, includeCheckboxStyles: true });
			expect(css).toContain(`background-color: ${mockTheme.colors.accent}`);
		});

		it('should use bgMain color for checkbox checkmark', () => {
			const css = generateProseStyles({ theme: mockTheme, includeCheckboxStyles: true });
			expect(css).toContain(`border: solid ${mockTheme.colors.bgMain}`);
		});

		it('should not include checkbox CSS when false', () => {
			const css = generateProseStyles({ theme: mockTheme, includeCheckboxStyles: false });
			// The base styles mention checkbox in the list-style-none rule,
			// but the dedicated checkbox block should be absent
			expect(css).not.toContain('appearance: none');
			expect(css).not.toContain('input[type="checkbox"]:checked');
			expect(css).not.toContain('input[type="checkbox"]:hover');
		});
	});

	describe('scopeSelector option', () => {
		it('should prefix all rules with scopeSelector when provided', () => {
			const css = generateProseStyles({ theme: mockTheme, scopeSelector: '.my-panel' });
			expect(css).toContain('.my-panel .prose');
			// Verify specific rules use the scoped selector
			expect(css).toContain('.my-panel .prose h1');
			expect(css).toContain('.my-panel .prose p');
			expect(css).toContain('.my-panel .prose code');
			expect(css).toContain('.my-panel .prose a');
		});

		it('should use bare .prose when scopeSelector is empty string', () => {
			const css = generateProseStyles({ theme: mockTheme, scopeSelector: '' });
			expect(css).toContain('.prose h1');
			// Should not have a leading space before .prose
			expect(css).not.toMatch(/^\s+\S+ \.prose/m);
		});

		it('should use bare .prose when scopeSelector is not provided', () => {
			const css = generateProseStyles({ theme: mockTheme });
			// Rules should start with .prose (possibly with whitespace)
			expect(css).toContain('.prose h1');
		});

		it('should scope checkbox styles with scopeSelector', () => {
			const css = generateProseStyles({
				theme: mockTheme,
				scopeSelector: '.custom-scope',
				includeCheckboxStyles: true,
			});
			expect(css).toContain('.custom-scope .prose input[type="checkbox"]');
		});
	});

	describe('theme color injection', () => {
		it('should inject textMain into paragraph color', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain(`color: ${mockTheme.colors.textMain}`);
		});

		it('should inject textDim into blockquote color', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain(`.prose blockquote`);
			expect(css).toContain(`color: ${mockTheme.colors.textDim}`);
		});

		it('should inject accent into link color', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain(`.prose a { color: ${mockTheme.colors.accent}`);
		});

		it('should inject bgActivity into code background', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain(`background-color: ${mockTheme.colors.bgActivity}`);
		});

		it('should inject border color into table borders', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain(`border: 1px solid ${mockTheme.colors.border}`);
		});

		it('should inject bgActivity into th background', () => {
			const css = generateProseStyles({ theme: mockTheme });
			expect(css).toContain(`.prose th { background-color: ${mockTheme.colors.bgActivity}`);
		});

		it('should reflect different theme colors when theme changes', () => {
			const altTheme: Theme = {
				...mockTheme,
				colors: {
					...mockTheme.colors,
					textMain: '#aabbcc',
					accent: '#dd1122',
					bgActivity: '#556677',
				},
			};
			const css = generateProseStyles({ theme: altTheme });
			expect(css).toContain('color: #aabbcc');
			expect(css).toContain('color: #dd1122');
			expect(css).toContain('background-color: #556677');
		});
	});

	describe('combined options', () => {
		it('should support coloredHeadings + compactSpacing together', () => {
			const css = generateProseStyles({
				theme: mockTheme,
				coloredHeadings: true,
				compactSpacing: true,
			});
			// Colored headings
			expect(css).toContain(`.prose h1 { color: ${mockTheme.colors.accent}`);
			expect(css).toContain(`.prose h2 { color: ${mockTheme.colors.success}`);
			// Compact spacing
			expect(css).toContain('> *:first-child { margin-top: 0 !important; }');
			expect(css).toContain('margin: 0.25em 0 !important');
		});

		it('should support scopeSelector + includeCheckboxStyles: false', () => {
			const css = generateProseStyles({
				theme: mockTheme,
				scopeSelector: '.test-scope',
				includeCheckboxStyles: false,
			});
			expect(css).toContain('.test-scope .prose h1');
			expect(css).not.toContain('appearance: none');
		});

		it('should support all options together', () => {
			const css = generateProseStyles({
				theme: mockTheme,
				coloredHeadings: true,
				compactSpacing: true,
				includeCheckboxStyles: true,
				scopeSelector: '.full-test',
			});
			expect(css).toContain('.full-test .prose h1');
			expect(css).toContain(`color: ${mockTheme.colors.accent}`);
			expect(css).toContain('> *:first-child { margin-top: 0 !important; }');
			expect(css).toContain('input[type="checkbox"]');
		});
	});
});

// ---------------------------------------------------------------------------
// generateAutoRunProseStyles
// ---------------------------------------------------------------------------

describe('generateAutoRunProseStyles', () => {
	it('should return a non-empty CSS string', () => {
		const css = generateAutoRunProseStyles(mockTheme);
		expect(css).toBeTruthy();
		expect(typeof css).toBe('string');
	});

	it('should scope styles to .autorun-panel .prose', () => {
		const css = generateAutoRunProseStyles(mockTheme);
		expect(css).toContain('.autorun-panel .prose');
	});

	it('should use colored headings (accent for h1, success for h2, warning for h3)', () => {
		const css = generateAutoRunProseStyles(mockTheme);
		expect(css).toContain(`.autorun-panel .prose h1 { color: ${mockTheme.colors.accent}`);
		expect(css).toContain(`.autorun-panel .prose h2 { color: ${mockTheme.colors.success}`);
		expect(css).toContain(`.autorun-panel .prose h3 { color: ${mockTheme.colors.warning}`);
	});

	it('should include checkbox styles', () => {
		const css = generateAutoRunProseStyles(mockTheme);
		expect(css).toContain('input[type="checkbox"]');
	});

	it('should use standard (non-compact) spacing', () => {
		const css = generateAutoRunProseStyles(mockTheme);
		// Standard heading margin
		expect(css).toContain('margin: 0.67em 0 !important');
		// Should not have compact first-child/last-child overrides
		// (the raw string check: compact adds " > *:first-child" but standard does not)
		expect(css).not.toContain(
			'.autorun-panel .prose > *:first-child { margin-top: 0 !important; }'
		);
	});

	it('should produce identical output to generateProseStyles with matching options', () => {
		const directCss = generateProseStyles({
			theme: mockTheme,
			coloredHeadings: true,
			compactSpacing: false,
			includeCheckboxStyles: true,
			scopeSelector: '.autorun-panel',
		});
		const convenienceCss = generateAutoRunProseStyles(mockTheme);
		expect(convenienceCss).toBe(directCss);
	});
});

// ---------------------------------------------------------------------------
// generateTerminalProseStyles
// ---------------------------------------------------------------------------

describe('generateTerminalProseStyles', () => {
	const scopeSelector = '.terminal-output';

	it('should return a non-empty CSS string', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toBeTruthy();
		expect(typeof css).toBe('string');
	});

	it('should scope styles to the provided scopeSelector + .prose', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain('.terminal-output .prose');
	});

	it('should work with different scope selectors', () => {
		const css = generateTerminalProseStyles(mockTheme, '.group-chat-messages');
		expect(css).toContain('.group-chat-messages .prose');
	});

	it('should use colored headings (accent for h1, success for h2, warning for h3)', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose h1 { color: ${mockTheme.colors.accent}`);
		expect(css).toContain(`${scopeSelector} .prose h2 { color: ${mockTheme.colors.success}`);
		expect(css).toContain(`${scopeSelector} .prose h3 { color: ${mockTheme.colors.warning}`);
	});

	it('should use textDim for h6', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose h6 { color: ${mockTheme.colors.textDim}`);
	});

	it('should use bgSidebar for code background (not bgActivity)', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`background-color: ${mockTheme.colors.bgSidebar}`);
	});

	it('should use bgSidebar for th background', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(
			`${scopeSelector} .prose th { background-color: ${mockTheme.colors.bgSidebar}`
		);
	});

	it('should include compact spacing (first-child/last-child overrides)', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain('> *:first-child { margin-top: 0 !important; }');
		expect(css).toContain('> *:last-child { margin-bottom: 0 !important; }');
	});

	it('should include global zero margin rule', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose * { margin-top: 0; margin-bottom: 0; }`);
	});

	it('should include p+p spacing and p:empty rules', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose p + p { margin-top: 0.5em !important; }`);
		expect(css).toContain(`${scopeSelector} .prose p:empty { display: none; }`);
	});

	it('should include li inline styling rules', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(
			`${scopeSelector} .prose li > p:first-child { margin: 0 !important; display: inline; vertical-align: baseline; line-height: inherit; }`
		);
		expect(css).toContain(
			`${scopeSelector} .prose li > p:not(:first-child) { display: block; margin: 0.5em 0 0 !important; }`
		);
	});

	it('should include marker styling for list items', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose li::marker { font-weight: normal; }`);
	});

	it('should include extra vertical-align rule for styled first-child content in list items', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose li > strong:first-child`);
		expect(css).toContain(`${scopeSelector} .prose li > p:first-child > strong:first-child`);
		expect(css).toContain('vertical-align: baseline');
	});

	it('should include link accent color', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose a { color: ${mockTheme.colors.accent}`);
	});

	it('should include border styling', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`border: 1px solid ${mockTheme.colors.border}`);
	});
});

// ---------------------------------------------------------------------------
// generateDiffViewStyles
// ---------------------------------------------------------------------------

describe('generateDiffViewStyles', () => {
	it('should return a non-empty CSS string', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toBeTruthy();
		expect(typeof css).toBe('string');
	});

	it('should include diff gutter styles', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toContain('.diff-gutter');
		expect(css).toContain(`background-color: ${mockTheme.colors.bgSidebar} !important`);
		expect(css).toContain(`color: ${mockTheme.colors.textDim} !important`);
	});

	it('should include diff code styles', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toContain('.diff-code');
		expect(css).toContain(`background-color: ${mockTheme.colors.bgMain} !important`);
	});

	it('should include insert (green) color styling', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toContain('.diff-gutter-insert');
		expect(css).toContain('.diff-code-insert');
		expect(css).toContain('rgba(34, 197, 94, 0.1)');
		expect(css).toContain('rgba(34, 197, 94, 0.15)');
	});

	it('should include delete (red) color styling', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toContain('.diff-gutter-delete');
		expect(css).toContain('.diff-code-delete');
		expect(css).toContain('rgba(239, 68, 68, 0.1)');
		expect(css).toContain('rgba(239, 68, 68, 0.15)');
	});

	it('should include edit highlight styles within insert/delete', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toContain('.diff-code-insert .diff-code-edit');
		expect(css).toContain('rgba(34, 197, 94, 0.3)');
		expect(css).toContain('.diff-code-delete .diff-code-edit');
		expect(css).toContain('rgba(239, 68, 68, 0.3)');
	});

	it('should include hunk header styles', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toContain('.diff-hunk-header');
		expect(css).toContain(`background-color: ${mockTheme.colors.bgActivity} !important`);
		expect(css).toContain(`color: ${mockTheme.colors.accent} !important`);
	});

	it('should include diff line styles', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toContain('.diff-line');
		expect(css).toContain(`color: ${mockTheme.colors.textMain} !important`);
	});

	it('should include border styling for gutter and hunk header', () => {
		const css = generateDiffViewStyles(mockTheme);
		expect(css).toContain(`border-right: 1px solid ${mockTheme.colors.border} !important`);
		expect(css).toContain(`border-bottom: 1px solid ${mockTheme.colors.border} !important`);
	});

	it('should reflect different theme colors', () => {
		const altTheme: Theme = {
			...mockTheme,
			colors: {
				...mockTheme.colors,
				bgSidebar: '#112233',
				bgMain: '#aabbcc',
				textDim: '#ddeeff',
				accent: '#ff00ff',
			},
		};
		const css = generateDiffViewStyles(altTheme);
		expect(css).toContain('background-color: #112233 !important');
		expect(css).toContain('background-color: #aabbcc !important');
		expect(css).toContain('color: #ddeeff !important');
		expect(css).toContain('color: #ff00ff !important');
	});
});

// ---------------------------------------------------------------------------
// generateInlineWizardPreviewProseStyles
// ---------------------------------------------------------------------------

describe('generateInlineWizardPreviewProseStyles', () => {
	it('should support both same-element and descendant scoped prose selectors', () => {
		const css = generateInlineWizardPreviewProseStyles(mockTheme, '.doc-gen-view', 'document');
		expect(css).toContain('.doc-gen-view.prose, .doc-gen-view .prose');
	});

	it('should scope Bionify selectors to descendant prose blocks only', () => {
		const css = generateInlineWizardPreviewProseStyles(mockTheme, '.doc-gen-view', 'document');
		expect(css).toContain('.doc-gen-view .prose .bionify-word');
		expect(css).not.toContain('.doc-gen-view.prose, .doc-gen-view .prose .bionify-word');
	});

	it('should normalize list item first paragraph inline and preserve subsequent paragraphs as blocks', () => {
		const css = generateInlineWizardPreviewProseStyles(mockTheme, '.doc-gen-view', 'document');
		expect(css).toContain(
			'.doc-gen-view.prose, .doc-gen-view .prose li > p:first-child { margin: 0 !important; display: inline; vertical-align: baseline; line-height: inherit; }'
		);
		expect(css).toContain(
			'.doc-gen-view.prose, .doc-gen-view .prose li > p:not(:first-child) { display: block; margin: 0.5em 0 0 !important; }'
		);
	});

	it('should include list marker alignment rules for styled first-child content', () => {
		const css = generateInlineWizardPreviewProseStyles(mockTheme, '.doc-gen-view', 'document');
		expect(css).toContain('.doc-gen-view.prose, .doc-gen-view .prose li > strong:first-child');
		expect(css).toContain(
			'.doc-gen-view.prose, .doc-gen-view .prose li > p:first-child > strong:first-child'
		);
	});

	it('should use compact streaming dimensions and the default prose selector', () => {
		const css = generateInlineWizardPreviewProseStyles(mockTheme, '', 'streaming');

		expect(css).toContain('.prose h1');
		expect(css).toContain('font-size: 1.75em');
		expect(css).toContain('font-size: 1.4em');
		expect(css).toContain('font-size: 1.15em');
		expect(css).toContain('margin: 0.4em 0');
		expect(css).toContain('padding: 0.15em 0.3em');
		expect(css).toContain('font-size: 0.85em');
		expect(css).toContain('padding: 0.75em');
		expect(css).toContain(`border-left: 3px solid ${mockTheme.colors.border}`);
		expect(css).toContain('width: 14px');
		expect(css).toContain('margin-right: 6px');
		expect(css).toContain('left: 3px');
		expect(css).toContain('top: 0px');
		expect(css).toContain('width: 4px');
		expect(css).toContain('height: 8px');
	});
});

// ---------------------------------------------------------------------------
// Shared Markdown Presets
// ---------------------------------------------------------------------------

describe('shared markdown presets', () => {
	it('should export a shared remark-gfm plugin array', () => {
		expect(Array.isArray(REMARK_GFM_PLUGINS)).toBe(true);
		expect(REMARK_GFM_PLUGINS.length).toBeGreaterThan(0);
	});

	it('should create wizard bubble markdown components', () => {
		const components = createWizardBubbleMarkdownComponents(mockTheme);
		expect(components.p).toBeDefined();
		expect(components.ul).toBeDefined();
		expect(components.ol).toBeDefined();
		expect(components.li).toBeDefined();
		expect(components.code).toBeDefined();
		expect(components.pre).toBeDefined();
		expect(components.a).toBeDefined();
		expect(components.h1).toBeDefined();
		expect(components.h2).toBeDefined();
		expect(components.h3).toBeDefined();
		expect(components.blockquote).toBeDefined();
	});

	it('should create release notes markdown components', () => {
		const components = createReleaseNotesMarkdownComponents(mockTheme);
		expect(components.h1).toBeDefined();
		expect(components.h2).toBeDefined();
		expect(components.h3).toBeDefined();
		expect(components.p).toBeDefined();
		expect(components.ul).toBeDefined();
		expect(components.ol).toBeDefined();
		expect(components.li).toBeDefined();
		expect(components.code).toBeDefined();
		expect(components.a).toBeDefined();
	});

	it('should render wizard bubble components with expected tags, classes, and link behavior', () => {
		const components = createWizardBubbleMarkdownComponents(mockTheme);
		const openExternal = vi.mocked(window.maestro.shell.openExternal);

		expect((components.p as any)({ children: 'paragraph' }).props.className).toBe('mb-2 last:mb-0');
		expect((components.ul as any)({ children: 'items' }).props.className).toBe(
			'list-disc ml-4 mb-2'
		);
		expect((components.ol as any)({ children: 'items' }).props.className).toBe(
			'list-decimal ml-4 mb-2'
		);
		expect((components.li as any)({ children: 'item' }).props.className).toBe('mb-1');
		expect((components.strong as any)({ children: 'strong' }).props.className).toBe(
			'font-semibold'
		);
		expect((components.em as any)({ children: 'em' }).props.className).toBe('italic');

		const inlineCode = (components.code as any)({ children: 'inline' });
		expect(inlineCode.props.className).toContain('font-mono');
		expect(inlineCode.props.style.backgroundColor).toBe(`${mockTheme.colors.bgMain}80`);

		const blockCode = (components.code as any)({
			children: 'block',
			className: 'language-ts',
		});
		expect(blockCode.props.className).toBe('language-ts');

		const pre = (components.pre as any)({ children: 'code' });
		expect(pre.type).toBe('pre');
		expect(pre.props.style.backgroundColor).toBe(mockTheme.colors.bgMain);

		const externalLink = (components.a as any)({
			href: 'https://example.com',
			children: 'external',
		});
		externalLink.props.onClick();
		expect(openExternal).toHaveBeenCalledWith('https://example.com');

		openExternal.mockClear();
		const relativeLink = (components.a as any)({ href: './local.md', children: 'local' });
		relativeLink.props.onClick();
		expect(openExternal).not.toHaveBeenCalled();

		expect((components.h1 as any)({ children: 'h1' }).props.className).toBe(
			'text-lg font-bold mb-2'
		);
		expect((components.h2 as any)({ children: 'h2' }).props.className).toBe(
			'text-base font-bold mb-2'
		);
		expect((components.h3 as any)({ children: 'h3' }).props.className).toBe(
			'text-sm font-bold mb-1'
		);
		expect((components.blockquote as any)({ children: 'quote' }).props.style.borderColor).toBe(
			mockTheme.colors.border
		);
	});

	it('should render release note components with expected tags, colors, and link behavior', () => {
		const components = createReleaseNotesMarkdownComponents(mockTheme);
		const openExternal = vi.mocked(window.maestro.shell.openExternal);

		expect((components.h1 as any)({ children: 'h1' }).props.style.color).toBe(
			mockTheme.colors.textMain
		);
		expect((components.h2 as any)({ children: 'h2' }).props.style.color).toBe(
			mockTheme.colors.textMain
		);
		expect((components.h3 as any)({ children: 'h3' }).props.style.color).toBe(
			mockTheme.colors.textMain
		);
		expect((components.p as any)({ children: 'copy' }).props.style.color).toBe(
			mockTheme.colors.textDim
		);
		expect((components.ul as any)({ children: 'items' }).props.className).toContain('list-disc');
		expect((components.ol as any)({ children: 'items' }).props.className).toContain('list-decimal');
		expect((components.li as any)({ children: 'item' }).props.style.color).toBe(
			mockTheme.colors.textDim
		);

		const code = (components.code as any)({ children: 'version' });
		expect(code.props.style.backgroundColor).toBe(mockTheme.colors.bgMain);
		expect(code.props.style.color).toBe(mockTheme.colors.accent);

		const preventDefault = vi.fn();
		const externalLink = (components.a as any)({
			href: 'mailto:test@example.com',
			children: 'email',
		});
		externalLink.props.onClick({ preventDefault });
		expect(preventDefault).toHaveBeenCalled();
		expect(openExternal).toHaveBeenCalledWith('mailto:test@example.com');

		openExternal.mockClear();
		const localLink = (components.a as any)({ href: '#changes', children: 'anchor' });
		localLink.props.onClick({ preventDefault: vi.fn() });
		expect(openExternal).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// createMarkdownComponents — link handling (Fixes MAESTRO-F4, MAESTRO-E5, etc.)
// ---------------------------------------------------------------------------

describe('createMarkdownComponents rendering behavior', () => {
	const readableChildren = (element: React.ReactElement) =>
		(element.props.children as React.ReactElement).props.children;

	it('should render text wrappers without search highlighting', () => {
		const components = createMarkdownComponents({ theme: mockTheme });

		for (const tag of ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th'] as const) {
			const element = (components[tag] as any)({ children: 'Plain text' });
			expect(element.type).toBe(tag);
			expect(readableChildren(element)).toBe('Plain text');
		}

		expect((components.blockquote as any)({ children: 'Quote' }).type).toBe('blockquote');
		expect((components.strong as any)({ children: 'Strong' }).type).toBe('strong');
		expect((components.em as any)({ children: 'Emphasis' }).type).toBe('em');
	});

	it('should highlight text matches across strings, nested elements, arrays, and current match refs', () => {
		const onMatchRendered = vi.fn();
		const components = createMarkdownComponents({
			theme: mockTheme,
			searchHighlight: {
				query: 'find+',
				currentMatchIndex: 1,
				onMatchRendered,
			},
		});

		const element = (components.p as any)({
			children: [
				'Find+ first',
				React.createElement('strong', { key: 'nested' }, 'find+ nested'),
				['find+ array'],
				42,
				null,
			],
		});

		const [firstFragment, nestedStrong, arrayChildren, numericChild, nullChild] =
			readableChildren(element);
		const firstMark = firstFragment.props.children[0];
		expect(firstMark.type).toBe('mark');
		expect(firstMark.props['data-match-index']).toBe(0);
		expect(firstMark.props['data-current']).toBeUndefined();
		expect(firstMark.props.style.backgroundColor).toBe('#ffd700');

		const nestedMark = nestedStrong.props.children.props.children[0];
		expect(nestedMark.props['data-match-index']).toBe(1);
		expect(nestedMark.props['data-current']).toBe('true');
		expect(nestedMark.props.style.backgroundColor).toBe(mockTheme.colors.accent);

		const currentRef = (nestedMark as any).ref ?? nestedMark.props.ref;
		const marker = document.createElement('mark');
		currentRef(marker);
		expect(onMatchRendered).toHaveBeenCalledWith(1, marker);

		expect(arrayChildren[0].props.children[0].props['data-match-index']).toBe(2);
		expect(numericChild).toBe(42);
		expect(nullChild).toBeNull();
	});

	it('should leave text unchanged when the search query is blank or has no matches', () => {
		const blankQuery = createMarkdownComponents({
			theme: mockTheme,
			searchHighlight: { query: '   ', currentMatchIndex: 0 },
		});
		expect(readableChildren((blankQuery.p as any)({ children: 'Plain text' }))).toBe('Plain text');

		const noMatch = createMarkdownComponents({
			theme: mockTheme,
			searchHighlight: { query: 'missing', currentMatchIndex: 0 },
		});
		expect(readableChildren((noMatch.p as any)({ children: 'Plain text' }))).toBe('Plain text');
	});

	it('should preserve child elements with no children and clone unkeyed matched elements', () => {
		const components = createMarkdownComponents({
			theme: mockTheme,
			searchHighlight: { query: 'match', currentMatchIndex: 0 },
		});

		const childlessElement = (components.p as any)({ children: React.createElement('hr') });
		expect(readableChildren(childlessElement).type).toBe('hr');

		const unkeyedElement = (components.p as any)({
			children: React.createElement('span', null, 'match inside'),
		});
		const unkeyedChild = readableChildren(unkeyedElement);
		expect(unkeyedChild.type).toBe('span');
		expect(unkeyedChild.key).toBe('elem-0');
		expect(unkeyedChild.props.children.props.children[0].type).toBe('mark');
	});

	it('should route code blocks to custom renderers, syntax highlighting, or fallback pre tags', () => {
		const MermaidRenderer = vi.fn();
		const customComponents = createMarkdownComponents({
			theme: mockTheme,
			customLanguageRenderers: { mermaid: MermaidRenderer },
		});
		const mermaidCode = React.createElement(
			'code',
			{ className: 'language-mermaid' },
			'graph TD\n'
		);
		const mermaidElement = (customComponents.pre as any)({ children: mermaidCode });
		expect(mermaidElement.type).toBe(MermaidRenderer);
		expect(mermaidElement.props.code).toBe('graph TD');
		expect(mermaidElement.props.theme).toBe(mockTheme);

		const highlightedComponents = createMarkdownComponents({
			theme: mockTheme,
			codeBlockStyle: {
				margin: '1px',
				padding: '2px',
				fontSize: '11px',
				borderRadius: '3px',
				backgroundColor: '#101010',
			},
		});
		const jsCode = React.createElement('code', { className: 'language-js' }, 'const x = 1;\n');
		const highlightedElement = (highlightedComponents.pre as any)({ children: jsCode });
		expect(highlightedElement.props.language).toBe('js');
		expect(highlightedElement.props.children).toBe('const x = 1;');
		expect(highlightedElement.props.customStyle).toMatchObject({
			margin: '1px',
			padding: '2px',
			fontSize: '11px',
			borderRadius: '3px',
			background: '#101010',
		});
		expect(highlightedElement.props.style['pre[class*="language-"]']).toMatchObject({
			color: mockTheme.colors.textMain,
			background: mockTheme.colors.bgActivity,
		});

		const defaultComponents = createMarkdownComponents({ theme: mockTheme });
		const codeNode = React.createElement('span', { node: { tagName: 'code' } }, 'plain text\n');
		const defaultElement = (defaultComponents.pre as any)({ children: codeNode });
		expect(defaultElement.props.language).toBe('text');
		expect(defaultElement.props.customStyle).toMatchObject({
			margin: '0.5em 0',
			padding: '1em',
			background: mockTheme.colors.bgActivity,
			fontSize: '0.9em',
			borderRadius: '6px',
		});

		const fallback = (defaultComponents.pre as any)({ children: React.createElement('span') });
		expect(fallback.type).toBe('pre');
	});

	it('should render inline code, custom images, and sanitized details elements', () => {
		const ImageRenderer = vi.fn();
		const components = createMarkdownComponents({
			theme: mockTheme,
			imageRenderer: ImageRenderer,
		});

		const code = (components.code as any)({
			className: 'language-ts',
			children: 'inline',
			'data-testid': 'inline-code',
		});
		expect(code.type).toBe('code');
		expect(code.props.className).toBe('language-ts');
		expect(code.props['data-testid']).toBe('inline-code');

		const image = (components.img as any)({
			src: 'image.png',
			alt: 'Preview',
			loading: 'lazy',
		});
		expect(image.type).toBe(ImageRenderer);
		expect(image.props).toMatchObject({
			src: 'image.png',
			alt: 'Preview',
			loading: 'lazy',
		});

		const details = (components.details as any)({
			onToggle: 'alert(1)',
			open: true,
			children: 'details body',
		});
		expect(details.type).toBe('details');
		expect(details.props.onToggle).toBeUndefined();
		expect(details.props.open).toBe(true);
	});
});

describe('createMarkdownComponents link handling', () => {
	it('should call onExternalLinkClick for http/https URLs', () => {
		const onExternalLinkClick = vi.fn();
		const components = createMarkdownComponents({
			theme: mockTheme,
			onExternalLinkClick,
		});
		const aComponent = components.a as any;
		expect(aComponent).toBeDefined();

		// Simulate rendering and clicking an https link
		const element = aComponent({ node: null, href: 'https://example.com', children: 'link' });
		const clickEvent = { preventDefault: vi.fn() } as any;
		element.props.onClick(clickEvent);
		expect(onExternalLinkClick).toHaveBeenCalledWith('https://example.com');
	});

	it('should call onExternalLinkClick for mailto URLs', () => {
		const onExternalLinkClick = vi.fn();
		const components = createMarkdownComponents({
			theme: mockTheme,
			onExternalLinkClick,
		});
		const aComponent = components.a as any;

		const element = aComponent({ node: null, href: 'mailto:test@example.com', children: 'email' });
		const clickEvent = { preventDefault: vi.fn() } as any;
		element.props.onClick(clickEvent);
		expect(onExternalLinkClick).toHaveBeenCalledWith('mailto:test@example.com');
	});

	it('should call onExternalLinkClick for file URLs', () => {
		const onExternalLinkClick = vi.fn();
		const onFileClick = vi.fn();
		const components = createMarkdownComponents({
			theme: mockTheme,
			onExternalLinkClick,
			onFileClick,
		});
		const aComponent = components.a as any;

		const element = aComponent({ node: null, href: 'file:///tmp/readme.md', children: 'file' });
		const clickEvent = { preventDefault: vi.fn(), metaKey: false, ctrlKey: false } as any;
		element.props.onClick(clickEvent);

		expect(onExternalLinkClick).toHaveBeenCalledWith('file:///tmp/readme.md');
		expect(onFileClick).not.toHaveBeenCalled();
	});

	it('should NOT call onExternalLinkClick for relative paths', () => {
		const onExternalLinkClick = vi.fn();
		const components = createMarkdownComponents({
			theme: mockTheme,
			onExternalLinkClick,
		});
		const aComponent = components.a as any;

		// Relative paths like LICENSE, ./README.md should not trigger openExternal
		for (const href of [
			'LICENSE',
			'./README.md',
			'../docs/spec.md',
			'constitution/specs/SPEC.md',
		]) {
			onExternalLinkClick.mockClear();
			const element = aComponent({ node: null, href, children: 'link' });
			const clickEvent = { preventDefault: vi.fn() } as any;
			element.props.onClick(clickEvent);
			expect(onExternalLinkClick).not.toHaveBeenCalled();
		}
	});

	it('should route relative paths to onFileClick when available', () => {
		const onExternalLinkClick = vi.fn();
		const onFileClick = vi.fn();
		const components = createMarkdownComponents({
			theme: mockTheme,
			onExternalLinkClick,
			onFileClick,
		});
		const aComponent = components.a as any;

		const element = aComponent({ node: null, href: 'LICENSE', children: 'license' });
		const clickEvent = { preventDefault: vi.fn(), metaKey: false, ctrlKey: false } as any;
		element.props.onClick(clickEvent);
		expect(onFileClick).toHaveBeenCalledWith('LICENSE', { openInNewTab: false });
		expect(onExternalLinkClick).not.toHaveBeenCalled();
	});

	it('should route maestro-file protocol and data attribute file links to onFileClick', () => {
		const onFileClick = vi.fn();
		const components = createMarkdownComponents({ theme: mockTheme, onFileClick });
		const aComponent = components.a as any;

		const protocolLink = aComponent({
			node: null,
			href: 'maestro-file://docs/spec.md',
			children: 'spec',
		});
		protocolLink.props.onClick({ preventDefault: vi.fn(), metaKey: true, ctrlKey: false });
		expect(onFileClick).toHaveBeenCalledWith('docs/spec.md', { openInNewTab: true });

		const dataAttributeLink = aComponent({
			node: null,
			href: undefined,
			'data-maestro-file': 'docs/from-data.md',
			children: 'data file',
		});
		dataAttributeLink.props.onClick({ preventDefault: vi.fn(), metaKey: false, ctrlKey: true });
		expect(onFileClick).toHaveBeenCalledWith('docs/from-data.md', { openInNewTab: true });
	});

	it('should route anchor links through onAnchorClick when provided', () => {
		const onAnchorClick = vi.fn();
		const components = createMarkdownComponents({ theme: mockTheme, onAnchorClick });
		const anchor = (components.a as any)({ node: null, href: '#setup', children: 'setup' });

		anchor.props.onClick({ preventDefault: vi.fn(), metaKey: false, ctrlKey: false });

		expect(onAnchorClick).toHaveBeenCalledWith('setup');
	});

	it('should scroll same-page anchors when no explicit anchor handler is provided', () => {
		const components = createMarkdownComponents({ theme: mockTheme, onFileClick: vi.fn() });
		const target = document.createElement('section');
		target.id = 'install';
		target.scrollIntoView = vi.fn();
		document.body.appendChild(target);

		try {
			const anchor = (components.a as any)({ node: null, href: '#install', children: 'install' });
			anchor.props.onClick({ preventDefault: vi.fn(), metaKey: false, ctrlKey: false });

			expect(target.scrollIntoView).toHaveBeenCalledWith({
				behavior: 'smooth',
				block: 'start',
			});
		} finally {
			target.remove();
		}
	});

	it('should use a container ref for anchor scrolling when provided', () => {
		const target = document.createElement('section');
		target.scrollIntoView = vi.fn();
		const querySelector = vi.fn(() => target);
		const containerRef = { current: { querySelector } as unknown as HTMLElement };
		vi.stubGlobal('CSS', { escape: (value: string) => value });

		try {
			const components = createMarkdownComponents({
				theme: mockTheme,
				onFileClick: vi.fn(),
				containerRef,
			});
			const anchor = (components.a as any)({
				node: null,
				href: '#from-container',
				children: 'container anchor',
			});

			anchor.props.onClick({ preventDefault: vi.fn(), metaKey: false, ctrlKey: false });

			expect(querySelector).toHaveBeenCalledWith('#from-container');
			expect(target.scrollIntoView).toHaveBeenCalledWith({
				behavior: 'smooth',
				block: 'start',
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('should tolerate same-page anchors that do not resolve to an element', () => {
		const components = createMarkdownComponents({ theme: mockTheme, onFileClick: vi.fn() });
		const anchor = (components.a as any)({ node: null, href: '#missing', children: 'missing' });

		expect(() =>
			anchor.props.onClick({ preventDefault: vi.fn(), metaKey: false, ctrlKey: false })
		).not.toThrow();
	});

	it('should do nothing for links with no matching handler path', () => {
		const onExternalLinkClick = vi.fn();
		const components = createMarkdownComponents({ theme: mockTheme, onExternalLinkClick });
		const link = (components.a as any)({ node: null, href: undefined, children: 'empty' });
		const preventDefault = vi.fn();

		link.props.onClick({ preventDefault, metaKey: false, ctrlKey: false });

		expect(preventDefault).toHaveBeenCalled();
		expect(onExternalLinkClick).not.toHaveBeenCalled();
	});
});

describe('createMarkdownComponents reading mode', () => {
	it('wraps paragraph prose in Bionify spans when enabled', () => {
		const components = createMarkdownComponents({
			theme: mockTheme,
			enableBionifyReadingMode: true,
		});
		const Paragraph = components.p as any;

		const { container } = render(Paragraph({ children: 'Readable prose only' }));

		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		expect(container.textContent).toBe('Readable prose only');
	});

	it('leaves inline code untouched while transforming surrounding emphasis content', () => {
		const components = createMarkdownComponents({
			theme: mockTheme,
			enableBionifyReadingMode: true,
		});
		const Strong = components.strong as any;

		render(
			Strong({
				children: React.createElement(
					React.Fragment,
					null,
					'Before ',
					React.createElement('code', null, 'const value = 1'),
					' after'
				),
			})
		);

		expect(screen.getByText('const value = 1')).toBeInTheDocument();
		expect(document.querySelector('code .bionify-word')).not.toBeInTheDocument();
		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
	});
});
