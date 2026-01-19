/**
 * Tests for useClickOutside hook
 *
 * This hook provides a reusable way to detect clicks outside of elements,
 * commonly used for closing dropdowns, menus, and overlays.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import { useClickOutside } from '../../../renderer/hooks';

describe('useClickOutside', () => {
	let container: HTMLDivElement;
	let outsideElement: HTMLDivElement;

	beforeEach(() => {
		// Create DOM elements for testing
		container = document.createElement('div');
		container.setAttribute('data-testid', 'container');
		document.body.appendChild(container);

		outsideElement = document.createElement('div');
		outsideElement.setAttribute('data-testid', 'outside');
		document.body.appendChild(outsideElement);
	});

	afterEach(() => {
		document.body.removeChild(container);
		document.body.removeChild(outsideElement);
		vi.restoreAllMocks();
	});

	describe('basic functionality', () => {
		it('should call callback when clicking outside the element', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside);
				return ref;
			});

			// Click outside
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});

			expect(onClickOutside).toHaveBeenCalledTimes(1);
		});

		it('should NOT call callback when clicking inside the element', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside);
				return ref;
			});

			// Click inside
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				container.dispatchEvent(event);
			});

			expect(onClickOutside).not.toHaveBeenCalled();
		});

		it('should NOT call callback when clicking inside a child element', () => {
			const onClickOutside = vi.fn();
			const childElement = document.createElement('span');
			container.appendChild(childElement);

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside);
				return ref;
			});

			// Click inside child
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				childElement.dispatchEvent(event);
			});

			expect(onClickOutside).not.toHaveBeenCalled();
		});

		it('should cleanup event listener on unmount', () => {
			const onClickOutside = vi.fn();
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { unmount } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside);
				return ref;
			});

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
		});
	});

	describe('enabled parameter', () => {
		it('should NOT listen when enabled is false', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside, false);
				return ref;
			});

			// Click outside
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});

			expect(onClickOutside).not.toHaveBeenCalled();
		});

		it('should start listening when enabled changes from false to true', () => {
			const onClickOutside = vi.fn();

			const { rerender } = renderHook(
				({ enabled }) => {
					const ref = useRef<HTMLDivElement>(container);
					useClickOutside(ref, onClickOutside, enabled);
					return ref;
				},
				{ initialProps: { enabled: false } }
			);

			// Click outside while disabled
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});
			expect(onClickOutside).not.toHaveBeenCalled();

			// Enable
			rerender({ enabled: true });

			// Click outside while enabled
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});
			expect(onClickOutside).toHaveBeenCalledTimes(1);
		});

		it('should stop listening when enabled changes from true to false', () => {
			const onClickOutside = vi.fn();

			const { rerender } = renderHook(
				({ enabled }) => {
					const ref = useRef<HTMLDivElement>(container);
					useClickOutside(ref, onClickOutside, enabled);
					return ref;
				},
				{ initialProps: { enabled: true } }
			);

			// Click outside while enabled
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});
			expect(onClickOutside).toHaveBeenCalledTimes(1);

			// Disable
			rerender({ enabled: false });

			// Click outside while disabled
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});
			expect(onClickOutside).toHaveBeenCalledTimes(1); // Still 1, not 2
		});
	});

	describe('eventType option', () => {
		it('should use mousedown by default', () => {
			const onClickOutside = vi.fn();
			const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside);
				return ref;
			});

			expect(addEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
		});

		it('should use click event when specified', () => {
			const onClickOutside = vi.fn();
			const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside, true, { eventType: 'click' });
				return ref;
			});

			expect(addEventListenerSpy).toHaveBeenCalledWith('click', expect.any(Function));
		});

		it('should respond to click event when using click eventType', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside, true, { eventType: 'click' });
				return ref;
			});

			// Click event (not mousedown)
			act(() => {
				const event = new MouseEvent('click', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});

			expect(onClickOutside).toHaveBeenCalledTimes(1);
		});
	});

	describe('delay option', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('should delay adding event listener when delay is true', () => {
			const onClickOutside = vi.fn();
			const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside, true, { delay: true });
				return ref;
			});

			// Event listener should not be added immediately
			expect(addEventListenerSpy).not.toHaveBeenCalled();

			// Advance timers
			act(() => {
				vi.runAllTimers();
			});

			// Now it should be added
			expect(addEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
		});

		it('should NOT call callback on immediate click when delay is true', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside, true, { delay: true });
				return ref;
			});

			// Click immediately (before setTimeout fires)
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});

			expect(onClickOutside).not.toHaveBeenCalled();
		});

		it('should call callback after delay when delay is true', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside, true, { delay: true });
				return ref;
			});

			// Advance timers to enable listener
			act(() => {
				vi.runAllTimers();
			});

			// Now click outside
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});

			expect(onClickOutside).toHaveBeenCalledTimes(1);
		});

		it('should clear timeout on unmount', () => {
			const onClickOutside = vi.fn();
			const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

			const { unmount } = renderHook(() => {
				const ref = useRef<HTMLDivElement>(container);
				useClickOutside(ref, onClickOutside, true, { delay: true });
				return ref;
			});

			unmount();

			expect(clearTimeoutSpy).toHaveBeenCalled();
		});
	});

	describe('multiple refs', () => {
		let secondContainer: HTMLDivElement;

		beforeEach(() => {
			secondContainer = document.createElement('div');
			secondContainer.setAttribute('data-testid', 'second-container');
			document.body.appendChild(secondContainer);
		});

		afterEach(() => {
			document.body.removeChild(secondContainer);
		});

		it('should NOT call callback when clicking inside any of the excluded elements', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref1 = useRef<HTMLDivElement>(container);
				const ref2 = useRef<HTMLDivElement>(secondContainer);
				useClickOutside([ref1, ref2], onClickOutside);
				return { ref1, ref2 };
			});

			// Click inside first container
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				container.dispatchEvent(event);
			});
			expect(onClickOutside).not.toHaveBeenCalled();

			// Click inside second container
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				secondContainer.dispatchEvent(event);
			});
			expect(onClickOutside).not.toHaveBeenCalled();
		});

		it('should call callback when clicking outside all excluded elements', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref1 = useRef<HTMLDivElement>(container);
				const ref2 = useRef<HTMLDivElement>(secondContainer);
				useClickOutside([ref1, ref2], onClickOutside);
				return { ref1, ref2 };
			});

			// Click outside both containers
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});

			expect(onClickOutside).toHaveBeenCalledTimes(1);
		});
	});

	describe('null ref handling', () => {
		it('should handle null ref gracefully', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref = useRef<HTMLDivElement>(null);
				useClickOutside(ref, onClickOutside);
				return ref;
			});

			// Click somewhere - should call callback since ref is null
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});

			expect(onClickOutside).toHaveBeenCalledTimes(1);
		});

		it('should handle array with some null refs', () => {
			const onClickOutside = vi.fn();

			renderHook(() => {
				const ref1 = useRef<HTMLDivElement>(container);
				const ref2 = useRef<HTMLDivElement>(null);
				useClickOutside([ref1, ref2], onClickOutside);
				return { ref1, ref2 };
			});

			// Click inside the valid container
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				container.dispatchEvent(event);
			});

			expect(onClickOutside).not.toHaveBeenCalled();
		});
	});

	describe('callback updates', () => {
		it('should use the latest callback when handler changes', () => {
			const callback1 = vi.fn();
			const callback2 = vi.fn();

			const { rerender } = renderHook(
				({ callback }) => {
					const ref = useRef<HTMLDivElement>(container);
					useClickOutside(ref, callback);
					return ref;
				},
				{ initialProps: { callback: callback1 } }
			);

			// Update callback
			rerender({ callback: callback2 });

			// Click outside
			act(() => {
				const event = new MouseEvent('mousedown', { bubbles: true });
				outsideElement.dispatchEvent(event);
			});

			expect(callback1).not.toHaveBeenCalled();
			expect(callback2).toHaveBeenCalledTimes(1);
		});
	});
});
