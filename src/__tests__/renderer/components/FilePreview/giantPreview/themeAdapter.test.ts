import { describe, it, expect } from 'vitest';
import { buildEditorTheme } from '../../../../../renderer/components/FilePreview/giantPreview/themeAdapter';
import { createMockTheme } from '../../../../helpers/mockTheme';

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
});
