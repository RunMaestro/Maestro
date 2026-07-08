/**
 * Tests for useMobileKeyboardHandler hook
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
	useMobileKeyboardHandler,
	type MobileKeyboardSession,
	type MobileShortcutActions,
} from '../../web/hooks/useMobileKeyboardHandler';
import type { Shortcut } from '../../shared/shortcut-types';

const shortcuts: Record<string, Shortcut> = {
	toggleMode: { id: 'toggleMode', label: 'Switch AI/Shell Mode', keys: ['Meta', 'j'] },
	prevTab: { id: 'prevTab', label: 'Previous Tab', keys: ['Meta', '['] },
	nextTab: { id: 'nextTab', label: 'Next Tab', keys: ['Meta', ']'] },
	quickAction: { id: 'quickAction', label: 'Quick Actions', keys: ['Meta', 'k'] },
};

function dispatchKeyboardEvent(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
	act(() => {
		document.dispatchEvent(event);
	});
	return event;
}

function renderKeyboardHandler({
	activeSession = { inputMode: 'ai' },
	actions,
	isCommandPaletteOpen,
	onCloseCommandPalette,
}: {
	activeSession?: MobileKeyboardSession | null;
	actions: MobileShortcutActions;
	isCommandPaletteOpen?: boolean;
	onCloseCommandPalette?: () => void;
}) {
	return renderHook((props) => useMobileKeyboardHandler(props), {
		initialProps: {
			shortcuts,
			activeSession,
			actions,
			isCommandPaletteOpen,
			onCloseCommandPalette,
		},
	});
}

describe('useMobileKeyboardHandler', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		document.body.innerHTML = '';
	});

	it('dispatches a matched Meta shortcut action and prevents default', () => {
		const toggleMode = vi.fn();

		renderKeyboardHandler({ actions: { toggleMode } });
		const event = dispatchKeyboardEvent({ key: 'j', metaKey: true });

		expect(toggleMode).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it('treats Ctrl as the configurable Meta modifier equivalent', () => {
		const toggleMode = vi.fn();

		renderKeyboardHandler({ actions: { toggleMode } });
		dispatchKeyboardEvent({ key: 'j', ctrlKey: true });

		expect(toggleMode).toHaveBeenCalledTimes(1);
	});

	it('dispatches tab navigation actions from the action map', () => {
		const prevTab = vi.fn();
		const nextTab = vi.fn();

		renderKeyboardHandler({ actions: { prevTab, nextTab } });
		dispatchKeyboardEvent({ key: '[', metaKey: true });
		dispatchKeyboardEvent({ key: ']', metaKey: true });

		expect(prevTab).toHaveBeenCalledTimes(1);
		expect(nextTab).toHaveBeenCalledTimes(1);
	});

	it('ignores unrelated keyboard events', () => {
		const toggleMode = vi.fn();
		const prevTab = vi.fn();

		renderKeyboardHandler({ actions: { toggleMode, prevTab } });
		dispatchKeyboardEvent({ key: 'x', metaKey: true });
		dispatchKeyboardEvent({ key: 'j' });
		dispatchKeyboardEvent({ key: '[', altKey: true });

		expect(toggleMode).not.toHaveBeenCalled();
		expect(prevTab).not.toHaveBeenCalled();
	});

	it('closes the command palette with Escape before shortcut dispatch', () => {
		const onCloseCommandPalette = vi.fn();
		const quickAction = vi.fn();

		renderKeyboardHandler({
			actions: { quickAction },
			isCommandPaletteOpen: true,
			onCloseCommandPalette,
		});
		const event = dispatchKeyboardEvent({ key: 'Escape' });

		expect(onCloseCommandPalette).toHaveBeenCalledTimes(1);
		expect(quickAction).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(true);
	});

	it('does not dispatch plain typing from editable fields', () => {
		const quickAction = vi.fn();
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		renderKeyboardHandler({
			actions: { quickAction },
		});
		act(() => {
			input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
		});

		expect(quickAction).not.toHaveBeenCalled();
	});

	it('still dispatches modified shortcuts from editable fields', () => {
		const quickAction = vi.fn();
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		renderKeyboardHandler({
			actions: { quickAction },
		});
		act(() => {
			input.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'k',
					metaKey: true,
					bubbles: true,
					cancelable: true,
				})
			);
		});

		expect(quickAction).toHaveBeenCalledTimes(1);
	});

	it('keeps keyboard events inside xterm while terminal input is active', () => {
		const quickAction = vi.fn();
		const textarea = document.createElement('textarea');
		textarea.className = 'xterm-helper-textarea';
		document.body.appendChild(textarea);
		textarea.focus();

		renderKeyboardHandler({
			activeSession: { inputMode: 'terminal' },
			actions: { quickAction },
		});
		act(() => {
			textarea.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'k',
					metaKey: true,
					bubbles: true,
					cancelable: true,
				})
			);
		});

		expect(quickAction).not.toHaveBeenCalled();
	});
});
