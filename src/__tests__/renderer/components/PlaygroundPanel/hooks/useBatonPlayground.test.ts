import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBatonPlayground } from '../../../../../renderer/components/PlaygroundPanel/hooks';

describe('useBatonPlayground', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		document.head.querySelectorAll('style[data-baton-playground]').forEach((element) => {
			element.remove();
		});
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		document.head.querySelectorAll('style[data-baton-playground]').forEach((element) => {
			element.remove();
		});
	});

	it('starts with default baton settings and injects style CSS', () => {
		const { result } = renderHook(() => useBatonPlayground());

		expect(result.current).toMatchObject({
			duration: 3,
			fadeOutStart: 35,
			fadeInStart: 65,
			translateAmount: 0.5,
			staggerOffset: 0.5,
			easing: 'ease-in-out',
			batonActive: true,
		});
		expect(document.querySelector('style[data-baton-playground]')?.textContent).toContain(
			'playground-wand-sparkle'
		);
	});

	it('updates injected CSS when settings change', () => {
		const { result } = renderHook(() => useBatonPlayground());

		act(() => {
			result.current.setDuration(5);
			result.current.setTranslateAmount(2);
			result.current.setEasing('linear');
		});

		const text = document.querySelector('style[data-baton-playground]')?.textContent;
		expect(text).toContain('animation: playground-wand-sparkle 5s linear infinite');
		expect(text).toContain('translate(2px, -2px)');
	});

	it('removes the injected style on unmount', () => {
		const { unmount } = renderHook(() => useBatonPlayground());

		expect(document.querySelector('style[data-baton-playground]')).toBeInTheDocument();
		unmount();
		expect(document.querySelector('style[data-baton-playground]')).not.toBeInTheDocument();
	});

	it('toggles active state and resets defaults', () => {
		const { result } = renderHook(() => useBatonPlayground());

		act(() => {
			result.current.toggleBatonActive();
			result.current.setDuration(6);
		});
		expect(result.current.batonActive).toBe(false);
		expect(result.current.duration).toBe(6);

		act(() => {
			result.current.resetBatonDefaults();
		});
		expect(result.current.batonActive).toBe(true);
		expect(result.current.duration).toBe(3);
	});

	it('copies CSS and clears the success state after the timeout', async () => {
		vi.useFakeTimers();
		const { result } = renderHook(() => useBatonPlayground());

		await act(async () => {
			await result.current.copyBatonSettings();
		});

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			expect.stringContaining('@keyframes wand-sparkle')
		);
		expect(result.current.batonCopySuccess).toBe(true);

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.batonCopySuccess).toBe(false);
	});

	it('does not show copy success when clipboard write fails', async () => {
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn().mockRejectedValue(new Error('Clipboard error')),
			},
		});
		const { result } = renderHook(() => useBatonPlayground());

		await act(async () => {
			await result.current.copyBatonSettings();
		});

		expect(result.current.batonCopySuccess).toBe(false);
	});
});
