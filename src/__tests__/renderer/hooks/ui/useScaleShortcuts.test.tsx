/**
 * `useScaleShortcuts` - bare `+` / `-` / `0` zoom for a scalable surface.
 *
 * What is worth pinning: the keys fire without a modifier, a modified press is
 * left alone (Cmd +/- is the application's own zoom), typing in a text field
 * never zooms, and `enabled: false` unbinds entirely so a surface underneath an
 * open overlay stops answering the same keypress.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScaleShortcuts } from '../../../../renderer/hooks/ui/useScaleShortcuts';
import type { UseScalePreferenceReturn } from '../../../../renderer/hooks/ui/useScalePreference';

function makeControl(): UseScalePreferenceReturn {
	return {
		scale: 1,
		adjustScale: vi.fn(),
		resetScale: vi.fn(),
		canDecrease: true,
		canIncrease: true,
	};
}

function press(key: string, init: KeyboardEventInit = {}, target?: EventTarget) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
	(target ?? window).dispatchEvent(event);
	return event;
}

describe('useScaleShortcuts', () => {
	let control: UseScalePreferenceReturn;

	beforeEach(() => {
		control = makeControl();
	});

	it('steps up on + and =', () => {
		renderHook(() => useScaleShortcuts(control));
		press('+');
		press('=');
		expect(control.adjustScale).toHaveBeenCalledTimes(2);
		expect(control.adjustScale).toHaveBeenNthCalledWith(1, 1);
		expect(control.adjustScale).toHaveBeenNthCalledWith(2, 1);
	});

	it('steps down on - and _', () => {
		renderHook(() => useScaleShortcuts(control));
		press('-');
		press('_');
		expect(control.adjustScale).toHaveBeenCalledTimes(2);
		expect(control.adjustScale).toHaveBeenNthCalledWith(1, -1);
		expect(control.adjustScale).toHaveBeenNthCalledWith(2, -1);
	});

	it('resets on 0', () => {
		renderHook(() => useScaleShortcuts(control));
		press('0');
		expect(control.resetScale).toHaveBeenCalledTimes(1);
	});

	it('consumes the event so a global handler cannot also act on it', () => {
		renderHook(() => useScaleShortcuts(control));
		expect(press('+').defaultPrevented).toBe(true);
	});

	it('ignores keys it does not own', () => {
		renderHook(() => useScaleShortcuts(control));
		const event = press('a');
		expect(control.adjustScale).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('leaves modified presses to the application zoom', () => {
		renderHook(() => useScaleShortcuts(control));
		press('+', { metaKey: true });
		press('-', { ctrlKey: true });
		press('=', { altKey: true });
		expect(control.adjustScale).not.toHaveBeenCalled();
	});

	it('does not zoom while typing in a text field', () => {
		renderHook(() => useScaleShortcuts(control));
		const input = document.createElement('input');
		document.body.appendChild(input);
		press('-', {}, input);
		expect(control.adjustScale).not.toHaveBeenCalled();
		input.remove();
	});

	it('stays unbound while disabled, and binds when re-enabled', () => {
		const { rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => useScaleShortcuts(control, { enabled }),
			{ initialProps: { enabled: false } }
		);
		press('+');
		expect(control.adjustScale).not.toHaveBeenCalled();

		rerender({ enabled: true });
		press('+');
		expect(control.adjustScale).toHaveBeenCalledTimes(1);
	});

	it('unbinds on unmount', () => {
		const { unmount } = renderHook(() => useScaleShortcuts(control));
		unmount();
		press('+');
		expect(control.adjustScale).not.toHaveBeenCalled();
	});

	it('calls the latest control without rebinding', () => {
		const next = makeControl();
		const { rerender } = renderHook(
			({ c }: { c: UseScalePreferenceReturn }) => useScaleShortcuts(c),
			{
				initialProps: { c: control },
			}
		);
		rerender({ c: next });
		press('+');
		expect(control.adjustScale).not.toHaveBeenCalled();
		expect(next.adjustScale).toHaveBeenCalledWith(1);
	});
});
