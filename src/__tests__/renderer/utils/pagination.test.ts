/**
 * Tests for the pure client-side pagination helpers.
 *
 * These exist mainly to pin the clamping. The failure they guard against is a
 * list shrinking under an active page - switching the tab breakdown from "All"
 * (1236 items, page 30) to "Open" (18 items) must not leave the caller asking
 * for a page that no longer exists.
 */

import { describe, it, expect } from 'vitest';
import {
	clampPage,
	getPageRange,
	getPageSlice,
	getTotalPages,
} from '../../../renderer/utils/pagination';

describe('getTotalPages', () => {
	it('divides and rounds up', () => {
		expect(getTotalPages(64, 32)).toBe(2);
		expect(getTotalPages(65, 32)).toBe(3);
		expect(getTotalPages(1, 32)).toBe(1);
	});

	it('never reports zero pages, so "Page 1 of 0" is unrenderable', () => {
		expect(getTotalPages(0, 32)).toBe(1);
		expect(getTotalPages(-5, 32)).toBe(1);
	});

	it('treats a non-positive page size as unpaginated', () => {
		expect(getTotalPages(100, 0)).toBe(1);
		expect(getTotalPages(100, -1)).toBe(1);
	});
});

describe('clampPage', () => {
	it('passes through an in-range page', () => {
		expect(clampPage(2, 100, 32)).toBe(2);
	});

	it('clamps above the last page and below the first', () => {
		expect(clampPage(99, 100, 32)).toBe(4);
		expect(clampPage(0, 100, 32)).toBe(1);
		expect(clampPage(-3, 100, 32)).toBe(1);
	});

	it('collapses to page 1 when the list empties out', () => {
		expect(clampPage(7, 0, 32)).toBe(1);
	});

	it('rejects non-finite input rather than propagating NaN', () => {
		expect(clampPage(NaN, 100, 32)).toBe(1);
		expect(clampPage(Infinity, 100, 32)).toBe(1);
	});

	it('floors a fractional page', () => {
		expect(clampPage(2.9, 100, 32)).toBe(2);
	});
});

describe('getPageSlice', () => {
	const items = Array.from({ length: 100 }, (_, i) => i);

	it('returns the window for a given page', () => {
		expect(getPageSlice(items, 1, 32)[0]).toBe(0);
		expect(getPageSlice(items, 1, 32)).toHaveLength(32);
		expect(getPageSlice(items, 2, 32)[0]).toBe(32);
	});

	it('returns a short final page rather than padding it', () => {
		expect(getPageSlice(items, 4, 32)).toEqual([96, 97, 98, 99]);
	});

	it('clamps an out-of-range page to the last one instead of returning empty', () => {
		expect(getPageSlice(items, 999, 32)).toEqual([96, 97, 98, 99]);
	});

	it('returns everything when paging is disabled', () => {
		expect(getPageSlice(items, 1, 0)).toHaveLength(100);
	});

	it('handles an empty list', () => {
		expect(getPageSlice([], 3, 32)).toEqual([]);
	});
});

describe('getPageRange', () => {
	it('reports an inclusive 1-based range', () => {
		expect(getPageRange(100, 1, 32)).toEqual({ from: 1, to: 32 });
		expect(getPageRange(100, 2, 32)).toEqual({ from: 33, to: 64 });
	});

	it('stops the final range at the item count', () => {
		expect(getPageRange(100, 4, 32)).toEqual({ from: 97, to: 100 });
	});

	// "1-0 of 0" is the tell-tale sign of an unguarded range calculation.
	it('reports a zero range for an empty list', () => {
		expect(getPageRange(0, 1, 32)).toEqual({ from: 0, to: 0 });
	});
});
