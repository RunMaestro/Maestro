/**
 * Tests for useContextMenuPosition hook
 *
 * This hook measures a context menu element after render and adjusts
 * its position to stay fully visible within the viewport.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useContextMenuPosition } from '../../../renderer/hooks/ui/useContextMenuPosition';

describe('useContextMenuPosition', () => {
	const originalInnerWidth = window.innerWidth;
	const originalInnerHeight = window.innerHeight;
	const originalGetBCR = Element.prototype.getBoundingClientRect;

	afterEach(() => {
		Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
		Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
		Element.prototype.getBoundingClientRect = originalGetBCR;
		vi.restoreAllMocks();
	});

	function setupViewport(width: number, height: number) {
		Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
		Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
	}

	function mockMenuSize(width: number, height: number) {
		Element.prototype.getBoundingClientRect = function () {
			return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
		};
	}

	it('returns click position when menu fits within viewport', () => {
		setupViewport(1024, 768);
		mockMenuSize(160, 120);

		const el = document.createElement('div');
		document.body.appendChild(el);

		const { result } = renderHook(() => {
			const ref = useRef<HTMLDivElement>(el);
			return useContextMenuPosition(ref, 200, 300);
		});

		expect(result.current.left).toBe(200);
		expect(result.current.top).toBe(300);
		expect(result.current.ready).toBe(true);

		document.body.removeChild(el);
	});

	it('clamps position when menu would overflow right edge', () => {
		setupViewport(800, 600);
		mockMenuSize(180, 120);

		const el = document.createElement('div');
		document.body.appendChild(el);

		const { result } = renderHook(() => {
			const ref = useRef<HTMLDivElement>(el);
			return useContextMenuPosition(ref, 750, 100);
		});

		// 800 - 180 - 8 (padding) = 612
		expect(result.current.left).toBe(612);
		expect(result.current.top).toBe(100);
		expect(result.current.ready).toBe(true);

		document.body.removeChild(el);
	});

	it('clamps position when menu would overflow bottom edge', () => {
		setupViewport(800, 600);
		mockMenuSize(160, 200);

		const el = document.createElement('div');
		document.body.appendChild(el);

		const { result } = renderHook(() => {
			const ref = useRef<HTMLDivElement>(el);
			return useContextMenuPosition(ref, 100, 500);
		});

		// 600 - 200 - 8 (padding) = 392
		expect(result.current.left).toBe(100);
		expect(result.current.top).toBe(392);
		expect(result.current.ready).toBe(true);

		document.body.removeChild(el);
	});

	it('clamps position when menu would overflow both edges', () => {
		setupViewport(800, 600);
		mockMenuSize(180, 200);

		const el = document.createElement('div');
		document.body.appendChild(el);

		const { result } = renderHook(() => {
			const ref = useRef<HTMLDivElement>(el);
			return useContextMenuPosition(ref, 750, 500);
		});

		expect(result.current.left).toBe(612); // 800 - 180 - 8
		expect(result.current.top).toBe(392);  // 600 - 200 - 8
		expect(result.current.ready).toBe(true);

		document.body.removeChild(el);
	});

	it('enforces minimum padding from top-left', () => {
		setupViewport(800, 600);
		mockMenuSize(100, 100);

		const el = document.createElement('div');
		document.body.appendChild(el);

		const { result } = renderHook(() => {
			const ref = useRef<HTMLDivElement>(el);
			return useContextMenuPosition(ref, 2, 3);
		});

		// Math.max(8, 2) = 8, Math.max(8, 3) = 8
		expect(result.current.left).toBe(8);
		expect(result.current.top).toBe(8);

		document.body.removeChild(el);
	});

	it('respects custom padding parameter', () => {
		setupViewport(800, 600);
		mockMenuSize(180, 120);

		const el = document.createElement('div');
		document.body.appendChild(el);

		const { result } = renderHook(() => {
			const ref = useRef<HTMLDivElement>(el);
			return useContextMenuPosition(ref, 750, 100, 16);
		});

		// 800 - 180 - 16 = 604
		expect(result.current.left).toBe(604);
		expect(result.current.top).toBe(100);

		document.body.removeChild(el);
	});

	it('returns ready=false when ref has no element', () => {
		const { result } = renderHook(() => {
			const ref = useRef<HTMLDivElement>(null);
			return useContextMenuPosition(ref, 100, 200);
		});

		expect(result.current.ready).toBe(false);
		expect(result.current.left).toBe(100);
		expect(result.current.top).toBe(200);
	});
});
