/**
 * Tests for SymphonyModal/hooks/useSymphonyTabCycle - Cmd+Shift+[/] tab cycle
 * across the 4 SymphonyModal tabs, wrap behavior, isOpen gating.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSymphonyTabCycle } from '../../../../../renderer/components/SymphonyModal/hooks/useSymphonyTabCycle';
import type { ModalTab } from '../../../../../renderer/components/SymphonyModal/types';

function fire(key: '[' | ']', opts: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}) {
	const event = new KeyboardEvent('keydown', {
		key,
		metaKey: opts.meta ?? true,
		ctrlKey: opts.ctrl ?? false,
		shiftKey: opts.shift ?? true,
		cancelable: true,
		bubbles: true,
	});
	window.dispatchEvent(event);
	return event;
}

describe('useSymphonyTabCycle', () => {
	it('Cmd+Shift+] cycles forward', () => {
		const onTabChange = vi.fn();
		renderHook(() => useSymphonyTabCycle({ isOpen: true, activeTab: 'projects', onTabChange }));
		fire(']');
		expect(onTabChange).toHaveBeenCalledWith('active');
	});

	it('Cmd+Shift+[ cycles backward', () => {
		const onTabChange = vi.fn();
		renderHook(() => useSymphonyTabCycle({ isOpen: true, activeTab: 'projects', onTabChange }));
		fire('[');
		expect(onTabChange).toHaveBeenCalledWith('stats');
	});

	it('wraps backward at "projects" → "stats"', () => {
		const onTabChange = vi.fn();
		renderHook(() => useSymphonyTabCycle({ isOpen: true, activeTab: 'projects', onTabChange }));
		fire('[');
		expect(onTabChange).toHaveBeenLastCalledWith('stats');
	});

	it('wraps forward at "stats" → "projects"', () => {
		const onTabChange = vi.fn();
		renderHook(() => useSymphonyTabCycle({ isOpen: true, activeTab: 'stats', onTabChange }));
		fire(']');
		expect(onTabChange).toHaveBeenLastCalledWith('projects');
	});

	it('is a no-op when isOpen is false', () => {
		const onTabChange = vi.fn();
		renderHook(() => useSymphonyTabCycle({ isOpen: false, activeTab: 'projects', onTabChange }));
		fire(']');
		expect(onTabChange).not.toHaveBeenCalled();
	});

	it('is a no-op without Cmd/Ctrl + Shift modifiers', () => {
		const onTabChange = vi.fn();
		renderHook(() => useSymphonyTabCycle({ isOpen: true, activeTab: 'projects', onTabChange }));
		fire(']', { meta: false, shift: true });
		fire(']', { meta: true, shift: false });
		fire(']', { meta: false, shift: false });
		expect(onTabChange).not.toHaveBeenCalled();
	});

	it('calls preventDefault + stopPropagation', () => {
		renderHook(() =>
			useSymphonyTabCycle({ isOpen: true, activeTab: 'projects', onTabChange: vi.fn() })
		);
		const event = new KeyboardEvent('keydown', {
			key: ']',
			metaKey: true,
			shiftKey: true,
			cancelable: true,
			bubbles: true,
		});
		const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
		expect(stopPropagationSpy).toHaveBeenCalledTimes(1);
	});

	it('removes the listener on unmount', () => {
		const onTabChange = vi.fn();
		const { unmount } = renderHook(() =>
			useSymphonyTabCycle({ isOpen: true, activeTab: 'projects', onTabChange })
		);
		unmount();
		fire(']');
		expect(onTabChange).not.toHaveBeenCalled();
	});

	it('cycles through all 4 tabs in forward direction', () => {
		const order: ModalTab[] = ['projects', 'active', 'history', 'stats'];
		for (let i = 0; i < order.length; i++) {
			const onTabChange = vi.fn();
			const { unmount } = renderHook(() =>
				useSymphonyTabCycle({ isOpen: true, activeTab: order[i], onTabChange })
			);
			fire(']');
			const expected = order[(i + 1) % order.length];
			expect(onTabChange).toHaveBeenCalledWith(expected);
			unmount();
		}
	});
});
