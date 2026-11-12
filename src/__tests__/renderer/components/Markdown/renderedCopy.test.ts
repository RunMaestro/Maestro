/**
 * Tests for rendered-chat copy serialization.
 *
 * Regression: the custom copy handler serialized each <li> as only its child
 * text, so copying a Markdown list dropped the CSS list markers ("- ", "1. ",
 * task-list checkboxes), turning "1. first / 2. second" into "first / second".
 *
 * @file src/renderer/components/Markdown/renderedCopy.ts
 */

import { describe, it, expect } from 'vitest';
import {
	normalizeRenderedChatCopy,
	serializeRenderedChatFragment,
} from '../../../../renderer/components/Markdown/renderedCopy';

function fragmentFromHtml(html: string): DocumentFragment {
	const template = document.createElement('template');
	template.innerHTML = html;
	return template.content;
}

function copyText(html: string): string {
	return normalizeRenderedChatCopy(serializeRenderedChatFragment(fragmentFromHtml(html)));
}

describe('serializeRenderedChatFragment list markers', () => {
	it('preserves bullet markers for unordered lists', () => {
		expect(copyText('<ul><li>first</li><li>second</li></ul>')).toBe('- first\n- second');
	});

	it('preserves sequential numbers for ordered lists', () => {
		expect(copyText('<ol><li>first</li><li>second</li><li>third</li></ol>')).toBe(
			'1. first\n2. second\n3. third'
		);
	});

	it('honors the ordered list start attribute', () => {
		expect(copyText('<ol start="3"><li>third</li><li>fourth</li></ol>')).toBe(
			'3. third\n4. fourth'
		);
	});

	it('preserves task-list checkbox markers', () => {
		const html =
			'<ul>' +
			'<li class="task-list-item"><input type="checkbox" disabled> open task</li>' +
			'<li class="task-list-item"><input type="checkbox" checked disabled> done task</li>' +
			'</ul>';
		expect(copyText(html)).toBe('- [ ] open task\n- [x] done task');
	});

	it('leaves non-list prose unchanged', () => {
		expect(copyText('<p>hello world</p>')).toBe('hello world');
	});
});
