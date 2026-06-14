import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePlaygroundTabs } from '../../../../../renderer/components/PlaygroundPanel/hooks';

function fireKey(key: string, options: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		...options,
	});
	window.dispatchEvent(event);
	return event;
}

describe('usePlaygroundTabs', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('starts on achievements', () => {
		const { result } = renderHook(() => usePlaygroundTabs());

		expect(result.current.activeTab).toBe('achievements');
	});

	it('cycles to the next tab with Cmd+Shift+]', () => {
		const { result } = renderHook(() => usePlaygroundTabs());

		act(() => {
			fireKey(']', { metaKey: true, shiftKey: true });
		});

		expect(result.current.activeTab).toBe('confetti');
	});

	it('cycles to the previous tab with Cmd+Shift+[', () => {
		const { result } = renderHook(() => usePlaygroundTabs());

		act(() => {
			result.current.setActiveTab('confetti');
		});
		act(() => {
			fireKey('[', { metaKey: true, shiftKey: true });
		});

		expect(result.current.activeTab).toBe('achievements');
	});

	it('wraps in both directions and supports shifted brace keys', () => {
		const { result } = renderHook(() => usePlaygroundTabs());

		act(() => {
			fireKey('{', { metaKey: true, shiftKey: true });
		});
		expect(result.current.activeTab).toBe('baton');

		act(() => {
			fireKey('}', { metaKey: true, shiftKey: true });
		});
		expect(result.current.activeTab).toBe('achievements');
	});

	it('ignores non-meta and non-shift key presses', () => {
		const { result } = renderHook(() => usePlaygroundTabs());

		act(() => {
			fireKey(']', { shiftKey: true });
			fireKey(']', { metaKey: true });
			fireKey('ArrowRight', { metaKey: true, shiftKey: true });
		});

		expect(result.current.activeTab).toBe('achievements');
	});

	it('removes its keyboard listener on unmount', () => {
		const { result, unmount } = renderHook(() => usePlaygroundTabs());

		unmount();
		act(() => {
			fireKey(']', { metaKey: true, shiftKey: true });
		});

		expect(result.current.activeTab).toBe('achievements');
	});
});
