import { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useElementHeight, useElementWidth } from '../../../../renderer/hooks/ui/useElementWidth';

/**
 * useElementWidth and useElementHeight share one ResizeObserver body; what is
 * under test is that each reads its own axis and follows a resize. jsdom has
 * no layout, so the element's box is stubbed.
 */

let box = { width: 0, height: 0 };
let triggerResize: (() => void) | null = null;
let disconnected = false;
const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

beforeEach(() => {
	box = { width: 0, height: 0 };
	triggerResize = null;
	disconnected = false;
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(cb: () => void) {
				triggerResize = cb;
			}
			observe() {}
			disconnect() {
				disconnected = true;
			}
		}
	);
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		get: () => box.width,
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get: () => box.height,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalWidth);
	if (originalHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
});

let seen = { width: -1, height: -1 };

function Probe({ enabled = true }: { enabled?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	seen = { width: useElementWidth(ref, enabled), height: useElementHeight(ref, enabled) };
	return <div ref={ref} />;
}

describe('useElementWidth / useElementHeight', () => {
	it('reads each axis on mount', () => {
		box = { width: 560, height: 148 };
		render(<Probe />);
		expect(seen).toEqual({ width: 560, height: 148 });
	});

	it('follows a resize on its own axis', () => {
		box = { width: 560, height: 148 };
		render(<Probe />);
		box = { width: 560, height: 212 };
		act(() => triggerResize?.());
		expect(seen).toEqual({ width: 560, height: 212 });
	});

	it('stays at 0 (not measured) while disabled', () => {
		box = { width: 560, height: 148 };
		render(<Probe enabled={false} />);
		expect(seen).toEqual({ width: 0, height: 0 });
		expect(triggerResize).toBeNull();
	});

	it('stops observing on unmount', () => {
		const { unmount } = render(<Probe />);
		unmount();
		expect(disconnected).toBe(true);
	});
});
