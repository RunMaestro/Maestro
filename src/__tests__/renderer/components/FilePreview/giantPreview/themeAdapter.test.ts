import { describe, it, expect } from 'vitest';
import { buildEditorTheme } from '../../../../../renderer/components/FilePreview/giantPreview/themeAdapter';
import { createMockTheme } from '../../../../helpers/mockTheme';

/**
 * CM6 compiles the theme spec into a StyleModule whose rules are plain CSS
 * strings; reading them back is the only way to assert what actually reaches
 * `.cm-scroller`, since the extension itself is opaque.
 */
function scrollerRule(ext: unknown): string {
	const rules: string[] = [];
	// Extensions nest (arrays of arrays of facet providers), so walk the tree
	// rather than assuming a depth CM6 never promised to keep.
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		const value = (node as { value?: { rules?: string[] } } | null)?.value;
		if (Array.isArray(value?.rules)) rules.push(...value.rules);
	};
	walk(ext);
	return rules.find((rule) => rule.includes('.cm-scroller')) ?? '';
}

describe('buildEditorTheme', () => {
	it('returns a non-empty extension array (chrome + syntax highlight)', () => {
		const ext = buildEditorTheme(createMockTheme());
		expect(Array.isArray(ext)).toBe(true);
		// Two extensions: the EditorView.theme + syntaxHighlighting(HighlightStyle)
		expect((ext as unknown[]).length).toBe(2);
	});

	it('produces a fresh extension for each call (no shared mutable state)', () => {
		const a = buildEditorTheme(createMockTheme({ colors: { accent: '#abcabc' } }));
		const b = buildEditorTheme(createMockTheme({ colors: { accent: '#123456' } }));
		expect(a).not.toBe(b);
	});

	it('accepts a light-mode theme without throwing', () => {
		expect(() => buildEditorTheme(createMockTheme({ mode: 'light' }))).not.toThrow();
	});

	it('accepts a dark-mode theme without throwing', () => {
		expect(() => buildEditorTheme(createMockTheme({ mode: 'dark' }))).not.toThrow();
	});

	it('handles a vibe-mode theme as dark (defensive - anything not "light" is dark)', () => {
		expect(() => buildEditorTheme(createMockTheme({ mode: 'vibe' }))).not.toThrow();
	});
	it('applies a caller-supplied font to the editor scroller', () => {
		// CM6 owns `.cm-scroller`'s font, so unlike the prose tiers the surface
		// font cannot arrive by inheritance from the pane - it has to be threaded
		// in, or the File Preview / File Editor font silently skips this tier.
		const rule = scrollerRule(buildEditorTheme(createMockTheme(), 1, 'Verdana, monospace'));
		expect(rule).toContain('font-family: Verdana, monospace');
	});

	it('keeps the built-in monospace stack when no font is supplied', () => {
		const rule = scrollerRule(buildEditorTheme(createMockTheme()));
		expect(rule).toContain('ui-monospace');
		expect(rule).toContain('monospace');
	});

	it('keeps the font independent of the zoom', () => {
		const rule = scrollerRule(buildEditorTheme(createMockTheme(), 1.5, 'Iosevka'));
		expect(rule).toContain('font-family: Iosevka');
		expect(rule).toContain('font-size: 19.5px');
	});
});
