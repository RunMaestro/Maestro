import { afterEach, describe, expect, it, vi } from 'vitest';
import { getElementRect, getSpotlightClipPath } from '../../../renderer/utils/spotlight';
import { logger } from '../../../renderer/utils/logger';

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('getElementRect', () => {
	it('returns null without querying for a null selector', () => {
		const query = vi.spyOn(document, 'querySelector');
		expect(getElementRect(null)).toBeNull();
		expect(query).not.toHaveBeenCalled();
	});

	it('warns and returns null when no selectors match', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		expect(getElementRect('#missing, #also-missing')).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			'[Tour] No elements found for selector(s): #missing, #also-missing'
		);
	});

	it('returns the original rect of the first match, even if it has zero size', () => {
		document.body.innerHTML = '<div class="target"></div><div class="target"></div>';
		const rect = new DOMRect(10, 20, 0, 0);
		const elements = document.querySelectorAll('.target');
		vi.spyOn(elements[0], 'getBoundingClientRect').mockReturnValue(rect);
		const second = vi.spyOn(elements[1], 'getBoundingClientRect');
		expect(getElementRect('.target')).toBe(rect);
		expect(second).not.toHaveBeenCalled();
	});

	it('unions trimmed selectors across negative coordinates and ignores missing targets', () => {
		document.body.innerHTML = '<div id="left"></div><div id="right"></div>';
		vi.spyOn(document.querySelector('#left')!, 'getBoundingClientRect').mockReturnValue(
			new DOMRect(-20, 40, 30, 80)
		);
		vi.spyOn(document.querySelector('#right')!, 'getBoundingClientRect').mockReturnValue(
			new DOMRect(50, -10, 100, 30)
		);
		const rect = getElementRect(' #left , #missing , #right ');
		expect(rect).toMatchObject({
			x: -20,
			y: -10,
			width: 170,
			height: 130,
			left: -20,
			top: -10,
			right: 150,
			bottom: 120,
		});
		expect(rect?.toJSON()).toEqual({ x: -20, y: -10, width: 170, height: 130 });
	});

	it('returns the original rect when only one of several selectors matches', () => {
		document.body.innerHTML = '<div id="target"></div>';
		const rect = new DOMRect(10, 20, 30, 40);
		vi.spyOn(document.querySelector('#target')!, 'getBoundingClientRect').mockReturnValue(rect);
		expect(getElementRect('#missing, #target')).toBe(rect);
	});
});

describe('getSpotlightClipPath', () => {
	it.each([null, undefined])('returns full overlay coverage for %s', (rect) => {
		expect(getSpotlightClipPath(rect)).toBe('none');
	});

	it('preserves the tour polygon with default padding and corners', () => {
		const path = getSpotlightClipPath(new DOMRect(20, 30, 100, 50));
		expect(path.replace(/\s+/g, ' ').trim()).toBe(
			'polygon( 0% 0%, 0% 100%, 12px 100%, 12px 30px, 20px 22px, 120px 22px, 128px 30px, 128px 80px, 120px 88px, 20px 88px, 12px 80px, 12px 100%, 100% 100%, 100% 0% )'
		);
	});

	it('preserves independently configured padding and corners without mutating the rect', () => {
		const rect = { x: 20, y: 30, width: 100, height: 50 };
		const path = getSpotlightClipPath(rect, { padding: 4, borderRadius: 2 });
		expect(path.replace(/\s+/g, ' ').trim()).toBe(
			'polygon( 0% 0%, 0% 100%, 16px 100%, 16px 28px, 18px 26px, 122px 26px, 124px 28px, 124px 82px, 122px 84px, 18px 84px, 16px 82px, 16px 100%, 100% 100%, 100% 0% )'
		);
		expect(rect).toEqual({ x: 20, y: 30, width: 100, height: 50 });
	});

	it('retains the tour fallback to eight for zero-valued options', () => {
		const rect = new DOMRect(20, 30, 100, 50);
		expect(getSpotlightClipPath(rect, { padding: 0, borderRadius: 0 })).toBe(
			getSpotlightClipPath(rect)
		);
	});
});
