import { describe, it, expect } from 'vitest';
import {
	remarkAlert,
	alertTypeFromClassName,
} from '../../../../renderer/components/Markdown/remarkAlert';

// Build the mdast shape remark produces for `> [!TYPE]\n> body`: a blockquote
// whose first paragraph's first child is a text node holding the marker and the
// body separated by a newline (remark-breaks runs later).
function blockquote(text: string) {
	return {
		type: 'root',
		children: [
			{
				type: 'blockquote',
				children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
			},
		],
	} as any;
}

function runAlert(tree: any) {
	remarkAlert()(tree);
	return tree.children[0];
}

describe('remarkAlert', () => {
	it('tags a [!NOTE] blockquote with the alert classes and strips the marker', () => {
		const bq = runAlert(blockquote('[!NOTE]\nBody text here.'));
		expect(bq.data?.hProperties?.className).toEqual(['markdown-alert', 'markdown-alert-note']);
		// Marker removed; body preserved.
		expect(bq.children[0].children[0].value).toBe('Body text here.');
	});

	it('recognizes all five alert types case-insensitively', () => {
		const types = [
			['[!TIP]\nx', 'tip'],
			['[!IMPORTANT]\nx', 'important'],
			['[!WARNING]\nx', 'warning'],
			['[!CAUTION]\nx', 'caution'],
			['[!note]\nx', 'note'], // lowercase marker still matches
		] as const;
		for (const [text, expected] of types) {
			const bq = runAlert(blockquote(text));
			expect(bq.data?.hProperties?.className).toEqual([
				'markdown-alert',
				`markdown-alert-${expected}`,
			]);
		}
	});

	it('leaves an ordinary blockquote untouched', () => {
		const bq = runAlert(blockquote('just a normal quote\nsecond line'));
		expect(bq.data).toBeUndefined();
		expect(bq.children[0].children[0].value).toBe('just a normal quote\nsecond line');
	});

	it('does NOT convert a marker with a trailing inline title (matches GitHub)', () => {
		const bq = runAlert(blockquote('[!WARNING] danger title\nbody'));
		expect(bq.data).toBeUndefined();
		expect(bq.children[0].children[0].value).toBe('[!WARNING] danger title\nbody');
	});

	it('drops the empty paragraph for a marker-only blockquote (no blank first line)', () => {
		const bq = runAlert(blockquote('[!CAUTION]'));
		expect(bq.data?.hProperties?.className).toEqual(['markdown-alert', 'markdown-alert-caution']);
		expect(bq.children.length).toBe(0);
	});

	it('ignores an unknown bracket marker', () => {
		const bq = runAlert(blockquote('[!INFO]\nnot a real type'));
		expect(bq.data).toBeUndefined();
	});
});

describe('alertTypeFromClassName', () => {
	it('extracts the type from an array className', () => {
		expect(alertTypeFromClassName(['markdown-alert', 'markdown-alert-warning'])).toBe('warning');
	});

	it('extracts the type from a space-joined string className', () => {
		expect(alertTypeFromClassName('markdown-alert markdown-alert-tip')).toBe('tip');
	});

	it('returns null for a non-alert className or nullish input', () => {
		expect(alertTypeFromClassName('prose text-sm')).toBeNull();
		expect(alertTypeFromClassName(undefined)).toBeNull();
		expect(alertTypeFromClassName(null)).toBeNull();
	});
});
