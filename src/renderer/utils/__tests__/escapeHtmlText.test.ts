import { describe, expect, it } from 'vitest';
import { escapeHtmlText } from '../escapeHtmlText';

describe('escapeHtmlText', () => {
	it('escapes every HTML text-context character with export-compatible entities', () => {
		expect(escapeHtmlText(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#039;');
	});

	it('escapes already-escaped text rather than interpreting it as HTML', () => {
		expect(escapeHtmlText('&amp; &lt;safe&gt;')).toBe('&amp;amp; &amp;lt;safe&amp;gt;');
	});
});
