/**
 * Tests for previewLineSpan: a right-click in a File Preview read view maps to
 * the source lines "Comment on line" pins a comment to. Tagged views (rendered
 * markdown, the highlighted code view) answer the block under the pointer;
 * verbatim text views count newlines; a click on selected text answers the
 * selection's lines.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
	lineOfTextPosition,
	previewLinesAtPoint,
	sourceLineProps,
	taggedBlockSpan,
} from '../../../../renderer/components/FilePreview/previewLineSpan';

function mount(html: string): HTMLElement {
	const container = document.createElement('div');
	container.innerHTML = html;
	document.body.appendChild(container);
	return container;
}

function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
	const range = document.createRange();
	range.setStart(startNode, startOffset);
	range.setEnd(endNode, endOffset);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

afterEach(() => {
	window.getSelection()?.removeAllRanges();
	document.body.replaceChildren();
});

describe('taggedBlockSpan', () => {
	it('reads the innermost tagged block, with its end line when it spans several', () => {
		const container = mount(
			'<ul data-source-line="4" data-source-line-end="6"><li data-source-line="5"><em>x</em></li></ul>'
		);
		expect(taggedBlockSpan(container.querySelector('em')!.firstChild)).toEqual({
			startLine: 5,
			endLine: 5,
		});
		expect(taggedBlockSpan(container.querySelector('ul'))).toEqual({ startLine: 4, endLine: 6 });
	});

	it('answers null outside any tagged block', () => {
		const container = mount('<p>untagged</p>');
		expect(taggedBlockSpan(container.querySelector('p'))).toBeNull();
	});

	it('is what the code view tags each line with', () => {
		expect(sourceLineProps(7)).toEqual({ 'data-source-line': 7 });
	});
});

describe('lineOfTextPosition', () => {
	it('counts the newlines before a position, across wrapping spans', () => {
		const container = mount('<span>one\ntw</span><b>o\nthree</b>');
		const three = container.querySelector('b')!.firstChild!;
		expect(lineOfTextPosition(container, three, 3)).toBe(3);
		expect(lineOfTextPosition(container, container.firstChild!.firstChild!, 0)).toBe(1);
	});

	it('refuses a node outside the container', () => {
		const container = mount('<span>x</span>');
		expect(lineOfTextPosition(container, document.createTextNode('y'), 0)).toBeNull();
	});
});

describe('previewLinesAtPoint', () => {
	it('answers the block under the pointer in a tagged view', () => {
		const container = mount('<p data-source-line="2" data-source-line-end="3">para</p>');
		const target = container.querySelector('p')!.firstChild!;
		expect(previewLinesAtPoint('tagged', container, target, 0, 0)).toEqual({
			startLine: 2,
			endLine: 3,
		});
	});

	it('answers the selected blocks when the click lands on the selection', () => {
		const container = mount(
			'<p data-source-line="1">alpha</p><p data-source-line="3" data-source-line-end="4">beta</p>'
		);
		const [alpha, beta] = Array.from(container.querySelectorAll('p')).map((p) => p.firstChild!);
		select(alpha, 1, beta, 2);
		expect(previewLinesAtPoint('tagged', container, beta, 0, 0)).toEqual({
			startLine: 1,
			endLine: 4,
		});
	});

	it('answers the line under the caret in a text view', () => {
		const container = mount('<div>a\nb\nc</div>');
		const text = container.firstChild!.firstChild!;
		// jsdom has no hit testing; stand in the engine's answer for the point.
		const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range };
		doc.caretRangeFromPoint = () => {
			const range = document.createRange();
			range.setStart(text, 4);
			return range;
		};
		try {
			expect(previewLinesAtPoint('text', container, text, 5, 5)).toEqual({
				startLine: 3,
				endLine: 3,
			});
		} finally {
			delete doc.caretRangeFromPoint;
		}
	});

	it('answers null for a target outside the view', () => {
		const container = mount('<p data-source-line="1">x</p>');
		expect(previewLinesAtPoint('tagged', container, document.body, 0, 0)).toBeNull();
	});
});
