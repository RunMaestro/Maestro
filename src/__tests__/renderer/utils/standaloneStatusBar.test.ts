/**
 * Tests for the standalone status bar inset.
 *
 * The measurement only ever fires for an iOS home-screen web app in portrait
 * whose viewport is shorter than the screen by a status-bar-sized amount, which
 * is the WebKit state where env(safe-area-inset-top) reads 0 (WebKit bug 301994).
 * Everywhere else it must stay 0 so the CSS max() falls through to env().
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
	installStandaloneStatusBarInset,
	measureStandaloneStatusBarInset,
	STATUS_BAR_INSET_PROPERTY,
} from '../../../renderer/utils/standaloneStatusBar';

const portrait = { standalone: true, screenHeight: 874, innerHeight: 812, innerWidth: 402 };

describe('measureStandaloneStatusBarInset', () => {
	it('reports the height the viewport lost in a standalone portrait web app', () => {
		expect(measureStandaloneStatusBarInset(portrait)).toBe(62);
	});

	it('is zero when WebKit already sizes the viewport to the screen', () => {
		expect(measureStandaloneStatusBarInset({ ...portrait, innerHeight: 874 })).toBe(0);
	});

	it('is zero outside a home-screen web app', () => {
		expect(measureStandaloneStatusBarInset({ ...portrait, standalone: false })).toBe(0);
	});

	it('is zero in landscape, where iOS hides the status bar', () => {
		expect(
			measureStandaloneStatusBarInset({
				standalone: true,
				screenHeight: 874,
				innerHeight: 402,
				innerWidth: 874,
			})
		).toBe(0);
	});

	it('ignores a difference the size of the on-screen keyboard', () => {
		expect(measureStandaloneStatusBarInset({ ...portrait, innerHeight: 500 })).toBe(0);
	});

	it('rounds a fractional difference', () => {
		expect(measureStandaloneStatusBarInset({ ...portrait, innerHeight: 812.4 })).toBe(62);
	});
});

describe('installStandaloneStatusBarInset', () => {
	const originalInnerHeight = window.innerHeight;
	const originalInnerWidth = window.innerWidth;

	afterEach(() => {
		delete (window.navigator as Navigator & { standalone?: boolean }).standalone;
		Object.defineProperty(window, 'innerHeight', {
			value: originalInnerHeight,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(window, 'innerWidth', {
			value: originalInnerWidth,
			configurable: true,
			writable: true,
		});
		document.documentElement.style.removeProperty(STATUS_BAR_INSET_PROPERTY);
	});

	it('publishes the inset on <html>, follows resize, and stops after dispose', () => {
		const dispose = installStandaloneStatusBarInset(window);
		expect(document.documentElement.style.getPropertyValue(STATUS_BAR_INSET_PROPERTY)).toBe('0px');

		Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
		Object.defineProperty(window.screen, 'height', { value: 874, configurable: true });
		Object.defineProperty(window, 'innerHeight', {
			value: 812,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(window, 'innerWidth', { value: 402, configurable: true, writable: true });
		window.dispatchEvent(new Event('resize'));
		expect(document.documentElement.style.getPropertyValue(STATUS_BAR_INSET_PROPERTY)).toBe('62px');

		dispose();
		Object.defineProperty(window, 'innerHeight', {
			value: 874,
			configurable: true,
			writable: true,
		});
		window.dispatchEvent(new Event('resize'));
		expect(document.documentElement.style.getPropertyValue(STATUS_BAR_INSET_PROPERTY)).toBe('62px');
	});
});
