/**
 * Coverage for the shared heading-navigation helpers.
 *
 * The Rich/Fast scroll-path cases below used to live in FilePreviewToc.test.tsx.
 * They moved here when the ToC and the `#` heading palette were pointed at one
 * implementation, so a regression is caught once instead of per surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	findActiveHeadingSlug,
	headingLevelColor,
	scrollToHeadingSlug,
} from '../../../../../renderer/components/FilePreview/shared/headings';
import { mockTheme } from '../../../../helpers/mockTheme';

function buildDocument(): HTMLDivElement {
	const container = document.createElement('div');
	container.innerHTML = '<h1 id="section-a"></h1><h2 id="sub-of-a"></h2><h1 id="section-b"></h1>';
	return container;
}

describe('scrollToHeadingSlug', () => {
	// setup.ts stubs Element.prototype.scrollIntoView with a single shared mock,
	// so vi.spyOn hands back that same function in every test. Reset between
	// cases or call counts leak forward.
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('scrolls the matching element into view when no override is given', () => {
		const container = buildDocument();
		const target = container.querySelector('#section-b') as HTMLElement;
		const spy = vi.spyOn(target, 'scrollIntoView');
		scrollToHeadingSlug('section-b', container, 'smooth');
		expect(spy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
	});

	it('passes the requested behavior through', () => {
		const container = buildDocument();
		const target = container.querySelector('#sub-of-a') as HTMLElement;
		const spy = vi.spyOn(target, 'scrollIntoView');
		scrollToHeadingSlug('sub-of-a', container, 'auto');
		expect(spy).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
	});

	it('no-ops silently when the heading is not in the DOM', () => {
		const container = buildDocument();
		expect(() => scrollToHeadingSlug('does-not-exist', container, 'smooth')).not.toThrow();
	});

	it('no-ops silently when there is no container yet', () => {
		expect(() => scrollToHeadingSlug('section-a', null, 'smooth')).not.toThrow();
	});

	it('lets a Fast-tier override claim the jump and skips the DOM path', () => {
		const container = buildDocument();
		const target = container.querySelector('#section-b') as HTMLElement;
		const spy = vi.spyOn(target, 'scrollIntoView');
		const override = vi.fn().mockReturnValue(true);
		scrollToHeadingSlug('section-b', container, 'smooth', override);
		expect(override).toHaveBeenCalledWith('section-b');
		expect(spy).not.toHaveBeenCalled();
	});

	it('falls back to the DOM path when the override declines', () => {
		const container = buildDocument();
		const target = container.querySelector('#section-b') as HTMLElement;
		const spy = vi.spyOn(target, 'scrollIntoView');
		const override = vi.fn().mockReturnValue(false);
		scrollToHeadingSlug('section-b', container, 'smooth', override);
		expect(override).toHaveBeenCalledWith('section-b');
		expect(spy).toHaveBeenCalled();
	});

	it('escapes slugs that would otherwise break the selector', () => {
		const container = document.createElement('div');
		container.innerHTML = '<h1 id="1-intro"></h1>';
		const target = container.querySelector('h1') as HTMLElement;
		const spy = vi.spyOn(target, 'scrollIntoView');
		// A bare `#1-intro` selector throws; CSS.escape is what keeps this legal.
		expect(() => scrollToHeadingSlug('1-intro', container, 'smooth')).not.toThrow();
		expect(spy).toHaveBeenCalled();
	});
});

describe('headingLevelColor', () => {
	it('maps h1-h3 to their own accents', () => {
		expect(headingLevelColor(mockTheme, 1)).toBe(mockTheme.colors.accent);
		expect(headingLevelColor(mockTheme, 2)).toBe(mockTheme.colors.success);
		expect(headingLevelColor(mockTheme, 3)).toBe(mockTheme.colors.warning);
	});

	it('uses body text for h4/h5 and dimmed text for h6', () => {
		expect(headingLevelColor(mockTheme, 4)).toBe(mockTheme.colors.textMain);
		expect(headingLevelColor(mockTheme, 5)).toBe(mockTheme.colors.textMain);
		expect(headingLevelColor(mockTheme, 6)).toBe(mockTheme.colors.textDim);
	});

	it('falls back to body text for a level outside 1-6', () => {
		expect(headingLevelColor(mockTheme, 0)).toBe(mockTheme.colors.textMain);
		expect(headingLevelColor(mockTheme, 9)).toBe(mockTheme.colors.textMain);
	});
});

describe('findActiveHeadingSlug', () => {
	/**
	 * jsdom lays nothing out, so every rect is zero. Stub the tops so the
	 * binary-search walk has a real document shape to reason about: the scroller
	 * fold sits at y=0 and each heading is placed relative to it.
	 */
	function layout(container: HTMLElement, tops: Record<string, number>) {
		const scroller = document.createElement('div');
		scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
		for (const [slug, top] of Object.entries(tops)) {
			const el = container.querySelector(`#${slug}`) as HTMLElement;
			el.getBoundingClientRect = () => ({ top }) as DOMRect;
		}
		return scroller;
	}

	it('returns the last heading at or above the fold', () => {
		const container = buildDocument();
		const scroller = layout(container, { 'section-a': -400, 'sub-of-a': -120, 'section-b': 300 });
		expect(findActiveHeadingSlug(scroller, container)).toBe('sub-of-a');
	});

	it('counts a heading a hair off the top as the section you are in', () => {
		const container = buildDocument();
		const scroller = layout(container, { 'section-a': -400, 'sub-of-a': 4, 'section-b': 900 });
		expect(findActiveHeadingSlug(scroller, container)).toBe('sub-of-a');
	});

	it('returns null when the view sits above the first heading', () => {
		const container = buildDocument();
		const scroller = layout(container, { 'section-a': 50, 'sub-of-a': 200, 'section-b': 600 });
		expect(findActiveHeadingSlug(scroller, container)).toBeNull();
	});

	it('returns null for a document with no headings', () => {
		const container = document.createElement('div');
		container.innerHTML = '<p>no headings here</p>';
		const scroller = document.createElement('div');
		expect(findActiveHeadingSlug(scroller, container)).toBeNull();
	});

	it('returns null when either element is missing', () => {
		expect(findActiveHeadingSlug(null, buildDocument())).toBeNull();
		expect(findActiveHeadingSlug(document.createElement('div'), null)).toBeNull();
	});

	it('prefers a tier override over the DOM walk', () => {
		const container = buildDocument();
		const scroller = layout(container, { 'section-a': -400, 'sub-of-a': -120, 'section-b': 300 });
		expect(findActiveHeadingSlug(scroller, container, () => 'section-b')).toBe('section-b');
	});

	it('lets an override report "above the first heading" without falling back', () => {
		const container = buildDocument();
		const scroller = layout(container, { 'section-a': -400, 'sub-of-a': -120, 'section-b': 300 });
		expect(findActiveHeadingSlug(scroller, container, () => null)).toBeNull();
	});

	it('falls back to the DOM walk when the override has no opinion', () => {
		const container = buildDocument();
		const scroller = layout(container, { 'section-a': -400, 'sub-of-a': -120, 'section-b': 300 });
		expect(findActiveHeadingSlug(scroller, container, () => undefined)).toBe('sub-of-a');
	});
});
