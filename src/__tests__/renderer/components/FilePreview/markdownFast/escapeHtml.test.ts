import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../../../../renderer/components/FilePreview/markdownFast/escapeHtml';

describe('escapeHtml', () => {
	it('returns the input unchanged when no special characters are present', () => {
		expect(escapeHtml('hello world')).toBe('hello world');
	});

	it('escapes ampersands first to avoid double-encoding', () => {
		expect(escapeHtml('a & b')).toBe('a &amp; b');
		// Critical: when an entity-looking string is encoded, the leading & must
		// be escaped first so we don't end up with &amp;amp;.
		expect(escapeHtml('&amp;')).toBe('&amp;amp;');
	});

	it('escapes angle brackets', () => {
		expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
	});

	it('escapes double quotes', () => {
		expect(escapeHtml('say "hi"')).toBe('say &quot;hi&quot;');
	});

	it('escapes single quotes using the numeric entity', () => {
		expect(escapeHtml("it's")).toBe('it&#39;s');
	});

	it('escapes all metacharacters in a single string', () => {
		expect(escapeHtml(`<a href="x" onclick='y'>&amp;</a>`)).toBe(
			'&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;'
		);
	});

	it('returns an empty string for empty input', () => {
		expect(escapeHtml('')).toBe('');
	});

	it('preserves unicode and emoji', () => {
		expect(escapeHtml('Привет 🚀')).toBe('Привет 🚀');
	});

	it('handles strings made entirely of special characters', () => {
		expect(escapeHtml('<<>>&&""')).toBe('&lt;&lt;&gt;&gt;&amp;&amp;&quot;&quot;');
	});

	it('does not break when the same character appears many times', () => {
		const input = '&'.repeat(1000);
		const escaped = escapeHtml(input);
		expect(escaped).toBe('&amp;'.repeat(1000));
	});
});
