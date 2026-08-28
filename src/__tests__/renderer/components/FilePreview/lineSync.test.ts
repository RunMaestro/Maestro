import { describe, it, expect } from 'vitest';
import {
	nthLineStartOffset,
	domGetTopLineByAttr,
	domScrollToLineByAttr,
} from '../../../../renderer/components/FilePreview/lineSync';

describe('nthLineStartOffset', () => {
	const text = 'alpha\nbravo\ncharlie\ndelta';
	// offsets: a=0 ... \n=5, b=6 ... \n=11, c=12 ... \n=19, d=20

	it('returns 0 for line 1 (and anything <= 1)', () => {
		expect(nthLineStartOffset(text, 1)).toBe(0);
		expect(nthLineStartOffset(text, 0)).toBe(0);
		expect(nthLineStartOffset(text, -5)).toBe(0);
	});

	it('returns the offset just after the (N-1)th newline', () => {
		expect(nthLineStartOffset(text, 2)).toBe(6); // 'bravo'
		expect(nthLineStartOffset(text, 3)).toBe(12); // 'charlie'
		expect(nthLineStartOffset(text, 4)).toBe(20); // 'delta'
	});

	it('round-trips: the substring at the offset starts with that line', () => {
		expect(text.slice(nthLineStartOffset(text, 3))).toBe('charlie\ndelta');
	});

	it('clamps past-the-end requests to the start of the last line', () => {
		expect(nthLineStartOffset(text, 99)).toBe(20);
	});

	it('handles a single-line string', () => {
		expect(nthLineStartOffset('only one line', 1)).toBe(0);
		expect(nthLineStartOffset('only one line', 5)).toBe(0);
	});

	it('handles an empty string', () => {
		expect(nthLineStartOffset('', 1)).toBe(0);
		expect(nthLineStartOffset('', 3)).toBe(0);
	});

	it('handles a trailing newline (empty final line)', () => {
		const trailing = 'a\nb\n';
		expect(nthLineStartOffset(trailing, 2)).toBe(2); // 'b'
		expect(nthLineStartOffset(trailing, 3)).toBe(4); // empty line after last \n
	});

	it('handles consecutive blank lines', () => {
		const blanks = 'a\n\n\nb';
		expect(nthLineStartOffset(blanks, 2)).toBe(2); // first blank
		expect(nthLineStartOffset(blanks, 3)).toBe(3); // second blank
		expect(nthLineStartOffset(blanks, 4)).toBe(4); // 'b'
	});
});

// ---------------------------------------------------------------------------
// domGetTopLineByAttr / domScrollToLineByAttr
//
// jsdom has no layout engine, so every rect is stubbed. That is fine here: the
// only thing under test is which tagged block the walk picks for a given set of
// tops, which is pure arithmetic over those rects.
// ---------------------------------------------------------------------------

/** A container whose `[data-source-line]` blocks report the given tops. */
function stubContainer(blocks: Array<{ line: number; top: number }>): HTMLElement {
	const container = document.createElement('div');
	for (const b of blocks) {
		const el = document.createElement('p');
		el.setAttribute('data-source-line', String(b.line));
		el.getBoundingClientRect = () => ({ top: b.top, height: 10 }) as DOMRect;
		container.appendChild(el);
	}
	return container;
}

/** A scroller whose viewport top edge is at y=100. */
function stubScroller(): HTMLElement {
	const el = document.createElement('div');
	el.getBoundingClientRect = () => ({ top: 100, height: 500 }) as DOMRect;
	return el;
}

describe('domGetTopLineByAttr', () => {
	it('returns null when nothing is tagged', () => {
		expect(domGetTopLineByAttr(stubScroller(), stubContainer([]))).toBeNull();
	});

	// The bug: a container's own padding puts even the first block below the
	// fold at scrollTop 0, so the old `blocks[0]` fallback answered "the first
	// heading" for a document sitting at the very top - and the editor jumped
	// there on Edit.
	it('reports line 1 when no block has reached the fold yet', () => {
		const container = stubContainer([
			{ line: 8, top: 124 },
			{ line: 20, top: 400 },
		]);
		expect(domGetTopLineByAttr(stubScroller(), container)).toBe(1);
	});

	it('reports the last block at or above the fold', () => {
		const container = stubContainer([
			{ line: 1, top: -300 },
			{ line: 8, top: 60 },
			{ line: 20, top: 400 },
		]);
		expect(domGetTopLineByAttr(stubScroller(), container)).toBe(8);
	});

	it('reports block one once it is exactly at the fold', () => {
		const container = stubContainer([
			{ line: 1, top: 100 },
			{ line: 8, top: 380 },
		]);
		expect(domGetTopLineByAttr(stubScroller(), container)).toBe(1);
	});
});

describe('domScrollToLineByAttr', () => {
	it('returns false when nothing is tagged', () => {
		expect(domScrollToLineByAttr(stubScroller(), stubContainer([]), 5)).toBe(false);
	});

	// Aligning block one with the scroller edge would scroll the container's
	// leading padding away, landing a few pixels short of the actual top.
	it('scrolls to a hard 0 for a line at or above the first block', () => {
		const scroller = stubScroller();
		scroller.scrollTop = 900;
		const container = stubContainer([
			{ line: 4, top: 124 },
			{ line: 20, top: 400 },
		]);
		expect(domScrollToLineByAttr(scroller, container, 1)).toBe(true);
		expect(scroller.scrollTop).toBe(0);
	});

	it('aligns the block that contains the requested line', () => {
		const scroller = stubScroller();
		scroller.scrollTop = 50;
		const container = stubContainer([
			{ line: 1, top: 100 },
			{ line: 8, top: 380 },
			{ line: 20, top: 900 },
		]);
		// Line 12 falls inside the block that starts at line 8 (top 380), which
		// is 280px below the fold, so the scroller advances by exactly that.
		expect(domScrollToLineByAttr(scroller, container, 12)).toBe(true);
		expect(scroller.scrollTop).toBe(330);
	});
});
