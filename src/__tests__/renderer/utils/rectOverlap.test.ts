import { describe, it, expect } from 'vitest';
import { rectsOverlap, elementOverlapsAny } from '../../../renderer/utils/rectOverlap';

const r = (left: number, top: number, right: number, bottom: number) => ({
	left,
	top,
	right,
	bottom,
});

describe('rectsOverlap', () => {
	it('detects a shared region', () => {
		expect(rectsOverlap(r(0, 0, 10, 10), r(5, 5, 15, 15))).toBe(true);
	});

	it('treats touching edges as apart', () => {
		expect(rectsOverlap(r(0, 0, 10, 10), r(10, 0, 20, 10))).toBe(false);
	});

	it('requires vertical overlap too', () => {
		expect(rectsOverlap(r(0, 0, 10, 10), r(0, 20, 10, 30))).toBe(false);
	});

	it('never counts an empty rect as overlapping', () => {
		expect(rectsOverlap(r(5, 5, 5, 5), r(0, 0, 10, 10))).toBe(false);
		expect(rectsOverlap(r(0, 0, 10, 10), r(2, 2, 8, 2))).toBe(false);
	});
});

describe('elementOverlapsAny', () => {
	const el = (left: number, right: number) => {
		const node = document.createElement('div');
		node.getBoundingClientRect = () =>
			({
				left,
				right,
				top: 0,
				bottom: 10,
				x: left,
				y: 0,
				width: right - left,
				height: 10,
			}) as DOMRect;
		return node;
	};

	it('is true when any other element overlaps', () => {
		expect(elementOverlapsAny(el(0, 50), [el(100, 120), el(40, 60)])).toBe(true);
	});

	it('is false when none overlap and ignores the element itself', () => {
		const self = el(0, 50);
		expect(elementOverlapsAny(self, [self, el(60, 80)])).toBe(false);
	});
});
