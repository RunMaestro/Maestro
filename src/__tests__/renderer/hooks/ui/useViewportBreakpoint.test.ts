/**
 * Tests for useViewportBreakpoint and the phone-layout predicate built on it.
 *
 * `usePhoneLayout()` / `isPhoneLayout()` are THE gate for simplifying a surface
 * on a handheld. They must agree with each other and with the CSS twin
 * `html[data-runtime='web-desktop'][data-bp='xs']`, and the native Electron
 * app must never report phone layout however narrow its window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
	isPhoneLayout,
	usePhoneLayout,
	useViewportBreakpoint,
} from '../../../../renderer/hooks/ui/useViewportBreakpoint';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';

vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

const mockedIsWebDesktop = vi.mocked(isWebDesktop);
const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number) {
	Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

beforeEach(() => {
	mockedIsWebDesktop.mockReturnValue(false);
});

afterEach(() => {
	setViewportWidth(originalInnerWidth);
	document.documentElement.removeAttribute('data-bp');
});

describe('useViewportBreakpoint', () => {
	it('classifies the viewport and publishes data-bp on <html>', () => {
		setViewportWidth(390);
		const { result } = renderHook(() => useViewportBreakpoint());
		expect(result.current.bp).toBe('xs');
		expect(result.current.isXs).toBe(true);
		expect(result.current.isNarrow).toBe(true);
		expect(document.documentElement.getAttribute('data-bp')).toBe('xs');
	});

	it('tracks resizes across the breakpoint ladder', () => {
		setViewportWidth(1440);
		const { result } = renderHook(() => useViewportBreakpoint());
		expect(result.current.bp).toBe('xl');

		act(() => {
			setViewportWidth(700);
			window.dispatchEvent(new Event('resize'));
		});
		expect(result.current.bp).toBe('sm');
		expect(result.current.isNarrow).toBe(true);
		expect(result.current.isXs).toBe(false);
		expect(document.documentElement.getAttribute('data-bp')).toBe('sm');
	});
});

describe('usePhoneLayout / isPhoneLayout', () => {
	it('is true only for the web-desktop bundle at the xs breakpoint', () => {
		setViewportWidth(390);
		mockedIsWebDesktop.mockReturnValue(true);
		const { result } = renderHook(() => usePhoneLayout());
		expect(result.current).toBe(true);
		expect(isPhoneLayout()).toBe(true);
	});

	it('is false for the web-desktop bundle once the viewport reaches sm', () => {
		setViewportWidth(640);
		mockedIsWebDesktop.mockReturnValue(true);
		const { result } = renderHook(() => usePhoneLayout());
		expect(result.current).toBe(false);
		expect(isPhoneLayout()).toBe(false);
	});

	it('is never true in the native Electron app, however narrow the window', () => {
		setViewportWidth(320);
		mockedIsWebDesktop.mockReturnValue(false);
		const { result } = renderHook(() => usePhoneLayout());
		expect(result.current).toBe(false);
		expect(isPhoneLayout()).toBe(false);
	});

	it('follows a resize out of and back into phone width', () => {
		setViewportWidth(390);
		mockedIsWebDesktop.mockReturnValue(true);
		const { result } = renderHook(() => usePhoneLayout());
		expect(result.current).toBe(true);

		act(() => {
			setViewportWidth(1024);
			window.dispatchEvent(new Event('resize'));
		});
		expect(result.current).toBe(false);
		expect(isPhoneLayout()).toBe(false);

		act(() => {
			setViewportWidth(412);
			window.dispatchEvent(new Event('orientationchange'));
		});
		expect(result.current).toBe(true);
		expect(isPhoneLayout()).toBe(true);
	});
});
