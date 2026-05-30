/**
 * Tests for useEventListener — generic event-listener hook used across the
 * renderer. Covers the original window-only behaviour plus the new
 * `target` and `enabled` options.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { useEventListener } from '../../../../renderer/hooks/utils/useEventListener';
import { spyOnListeners, expectAllListenersRemoved } from '../../../helpers/listenerLeakAssertions';

describe('useEventListener', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('default target (window)', () => {
		it('invokes the handler when an event fires on window', () => {
			const handler = vi.fn();
			renderHook(() => useEventListener('keydown', handler));
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('removes the listener on unmount', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			const { unmount } = renderHook(() => useEventListener('keydown', handler));
			unmount();
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});

		it('reads the latest handler closure (ref pattern)', () => {
			let calls = 0;
			const { rerender } = renderHook(
				({ value }: { value: number }) =>
					useEventListener('keydown', () => {
						calls = value;
					}),
				{ initialProps: { value: 1 } }
			);
			rerender({ value: 42 });
			fireEvent.keyDown(window, { key: 'a' });
			expect(calls).toBe(42);
		});
	});

	describe('target option', () => {
		it('attaches to document when target=document', () => {
			const handler = vi.fn();
			renderHook(() => useEventListener('keydown', handler, { target: document }));
			fireEvent.keyDown(document, { key: 'a' });
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('does NOT receive window events when target=document', () => {
			const handler = vi.fn();
			renderHook(() => useEventListener('keydown', handler, { target: document }));
			// Dispatch directly on window (skipping body) so it doesn't bubble to document.
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
			expect(handler).not.toHaveBeenCalled();
		});

		it('attaches to a DOM element target and removes the listener on unmount', () => {
			const el = document.createElement('div');
			document.body.appendChild(el);
			try {
				const handler = vi.fn();
				const { unmount } = renderHook(() => useEventListener('click', handler, { target: el }));

				fireEvent.click(el);
				expect(handler).toHaveBeenCalledTimes(1);

				unmount();
				fireEvent.click(el);
				expect(handler).toHaveBeenCalledTimes(1);
			} finally {
				// Always remove the appended element, even if an assertion threw —
				// otherwise an orphan <div> persists in document.body for the next
				// test in this worker.
				document.body.removeChild(el);
			}
		});

		it('does not attach a listener when target is null', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			renderHook(() => useEventListener('keydown', handler, { target: null }));
			expect(spies.addSpy).not.toHaveBeenCalled();
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();
			spies.restore();
		});

		it('removes its document listener on unmount', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(document);
			const { unmount } = renderHook(() =>
				useEventListener('keydown', handler, { target: document })
			);
			unmount();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});
	});

	describe('enabled option', () => {
		it('does not attach when enabled is false', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			renderHook(() => useEventListener('keydown', handler, { enabled: false }));
			expect(spies.addSpy).not.toHaveBeenCalled();
			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();
			spies.restore();
		});

		it('attaches/detaches as enabled toggles', () => {
			const handler = vi.fn();
			const { rerender } = renderHook(
				({ on }: { on: boolean }) => useEventListener('keydown', handler, { enabled: on }),
				{ initialProps: { on: false } }
			);

			fireEvent.keyDown(window, { key: 'a' });
			expect(handler).not.toHaveBeenCalled();

			act(() => {
				rerender({ on: true });
			});
			fireEvent.keyDown(window, { key: 'b' });
			expect(handler).toHaveBeenCalledTimes(1);

			act(() => {
				rerender({ on: false });
			});
			fireEvent.keyDown(window, { key: 'c' });
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('cleans up the listener on unmount when enabled was true', () => {
			const handler = vi.fn();
			const spies = spyOnListeners(window);
			const { unmount } = renderHook(() => useEventListener('keydown', handler, { enabled: true }));
			unmount();
			expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
			spies.restore();
		});
	});
});
