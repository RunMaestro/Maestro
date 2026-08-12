/**
 * Tests for the pure DOM helpers shared by Fast-tier markdown and text
 * precision scroll.
 *
 * Coverage: simple flat text, nested inline elements, multi-byte chars,
 * boundary offsets, and the multi-node Range case.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	buildRangeAtOffset,
	scrollRangeIntoView,
} from '../../../../../renderer/components/FilePreview/search/scrollToOffset';

function mkBlock(html: string): HTMLDivElement {
	const div = document.createElement('div');
	div.innerHTML = html;
	document.body.appendChild(div);
	return div;
}

const created: HTMLElement[] = [];
function mkTrackedBlock(html: string): HTMLDivElement {
	const el = mkBlock(html);
	created.push(el);
	return el;
}

afterEach(() => {
	while (created.length > 0) {
		created.pop()?.remove();
	}
});

describe('buildRangeAtOffset', () => {
	it('returns a single-node Range when the match fits in one text node', () => {
		const el = mkTrackedBlock('<p>Hello world</p>');
		const range = buildRangeAtOffset(el, 6, 5); // "world"
		expect(range).not.toBeNull();
		expect(range!.toString()).toBe('world');
	});

	it('returns a Range at the start of the block when offset is 0', () => {
		const el = mkTrackedBlock('<p>Hello world</p>');
		const range = buildRangeAtOffset(el, 0, 5);
		expect(range!.toString()).toBe('Hello');
	});

	it('handles offsets that fall on a text node boundary', () => {
		// "Hello" + " " + "world" across nested spans - text nodes are 5, 1, 5.
		const el = mkTrackedBlock('<p><span>Hello</span> <span>world</span></p>');
		const range = buildRangeAtOffset(el, 6, 5); // "world" (after Hello + space)
		expect(range!.toString()).toBe('world');
	});

	it('builds a multi-node Range when the match spans an inline element', () => {
		// Text: "the strong text here" - search "strong text" spans <strong> boundary.
		const el = mkTrackedBlock('<p>the <strong>strong</strong> text here</p>');
		// Block text content: "the strong text here". "strong text" starts at 4, length 11.
		const range = buildRangeAtOffset(el, 4, 11);
		expect(range).not.toBeNull();
		expect(range!.toString()).toBe('strong text');
	});

	it('returns null when offset is past the end of the block text', () => {
		const el = mkTrackedBlock('<p>short</p>');
		expect(buildRangeAtOffset(el, 100, 5)).toBeNull();
	});

	it('returns null for a negative offset', () => {
		const el = mkTrackedBlock('<p>x</p>');
		expect(buildRangeAtOffset(el, -1, 1)).toBeNull();
	});

	it('returns null for negative length', () => {
		const el = mkTrackedBlock('<p>x</p>');
		expect(buildRangeAtOffset(el, 0, -1)).toBeNull();
	});

	it('clamps the end to the last text node when length exceeds remaining content', () => {
		const el = mkTrackedBlock('<p>ten chars!</p>');
		// Block text is "ten chars!" - "chars!" begins at index 4. Ask for 999
		// chars from there → clamps to the rest of the block ("chars!").
		const range = buildRangeAtOffset(el, 4, 999);
		expect(range).not.toBeNull();
		expect(range!.toString()).toBe('chars!');
	});

	it('handles multi-byte characters by counting code units (matches indexOf semantics)', () => {
		// 'é' is 1 code unit (NFC form). 'café' is 4 code units. Search engine
		// uses indexOf on the source string which also counts code units, so
		// the offset is consistent.
		const el = mkTrackedBlock('<p>café latte</p>');
		const range = buildRangeAtOffset(el, 5, 5); // "latte"
		expect(range!.toString()).toBe('latte');
	});

	it('returns null when block has no text nodes', () => {
		const el = mkTrackedBlock('<img src="x.png">');
		expect(buildRangeAtOffset(el, 0, 1)).toBeNull();
	});
});

describe('scrollRangeIntoView', () => {
	it('returns false for null range', () => {
		expect(scrollRangeIntoView(null)).toBe(false);
	});

	it('calls scrollIntoView on the start node parent for a text-node range', () => {
		const el = mkTrackedBlock('<p>scrolling target</p>');
		const range = buildRangeAtOffset(el, 0, 9)!;
		const parentEl = (range.startContainer as Text).parentElement!;
		const spy = vi.spyOn(parentEl, 'scrollIntoView').mockImplementation(() => {});
		const result = scrollRangeIntoView(range);
		expect(result).toBe(true);
		expect(spy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
	});

	it('returns false when range start has no parent (defensive)', () => {
		// Detached node: parentElement is null. Should not throw, returns false.
		const detached = document.createTextNode('orphan');
		const range = document.createRange();
		range.setStart(detached, 0);
		range.setEnd(detached, 6);
		expect(scrollRangeIntoView(range)).toBe(false);
	});
});
