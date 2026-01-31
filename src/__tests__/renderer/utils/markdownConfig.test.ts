import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock react-syntax-highlighter before importing the module under test
vi.mock('react-syntax-highlighter', () => ({
	Prism: vi.fn(),
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
}));

import {
	generateProseStyles,
	generateAutoRunProseStyles,
	generateTerminalProseStyles,
	generateDiffViewStyles,
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
			expect(css).toContain(`.prose p { color: ${mockTheme.colors.textMain}; margin: 0.5em 0 !important`);
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
			expect(css).toContain(`.prose h1 { color: ${mockTheme.colors.textMain}; font-size: 2em; font-weight: bold; margin: 0.25em 0 !important`);
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
		expect(css).not.toContain('.autorun-panel .prose > *:first-child { margin-top: 0 !important; }');
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
		expect(css).toContain(`${scopeSelector} .prose th { background-color: ${mockTheme.colors.bgSidebar}`);
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
		expect(css).toContain(`${scopeSelector} .prose li > p { margin: 0 !important; display: inline; }`);
	});

	it('should include marker styling for list items', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose li::marker { font-weight: normal; }`);
	});

	it('should include extra vertical-align rule for first-child strong/b/em/code/a in li', () => {
		const css = generateTerminalProseStyles(mockTheme, scopeSelector);
		expect(css).toContain(`${scopeSelector} .prose li > strong:first-child`);
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
