/**
 * Tests for hooks/utils/useBracketTabCycle — generic Cmd+Shift+[/] tab cycle
 * with wrap behavior, enabled gating, modifier requirements, and cleanup.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBracketTabCycle } from '../../../../renderer/hooks/utils/useBracketTabCycle';

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

const MODES: readonly ('spec' | 'goal')[] = ['spec', 'goal'];

describe('useBracketTabCycle', () => {
	it('Cmd+Shift+] cycles forward', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		fire(']');
		expect(onChange).toHaveBeenCalledWith('goal');
	});

	it('Cmd+Shift+[ cycles backward', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'goal', onChange })
		);
		fire('[');
		expect(onChange).toHaveBeenCalledWith('spec');
	});

	it('wraps forward from the last value to the first', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'goal', onChange })
		);
		fire(']');
		expect(onChange).toHaveBeenLastCalledWith('spec');
	});

	it('wraps backward from the first value to the last', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		fire('[');
		expect(onChange).toHaveBeenLastCalledWith('goal');
	});

	it('Ctrl+Shift+] also cycles (non-mac modifier)', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		fire(']', { meta: false, ctrl: true, shift: true });
		expect(onChange).toHaveBeenCalledWith('goal');
	});

	it('is a no-op when enabled is false', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: false, values: MODES, active: 'spec', onChange })
		);
		fire(']');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('is a no-op without Cmd/Ctrl + Shift modifiers', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		fire(']', { meta: false, shift: true });
		fire(']', { meta: true, shift: false });
		fire(']', { meta: false, shift: false });
		expect(onChange).not.toHaveBeenCalled();
	});

	it('is a no-op when the active value is not in the list', () => {
		const onChange = vi.fn();
		renderHook(() =>
			useBracketTabCycle({
				enabled: true,
				values: ['spec', 'goal'],
				active: 'other',
				onChange,
			})
		);
		fire(']');
		expect(onChange).not.toHaveBeenCalled();
	});

	it('calls preventDefault + stopPropagation', () => {
		renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange: vi.fn() })
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
		const onChange = vi.fn();
		const { unmount } = renderHook(() =>
			useBracketTabCycle({ enabled: true, values: MODES, active: 'spec', onChange })
		);
		unmount();
		fire(']');
		expect(onChange).not.toHaveBeenCalled();
	});
});
