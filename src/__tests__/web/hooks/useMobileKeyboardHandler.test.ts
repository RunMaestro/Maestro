/**
 * Tests for useMobileKeyboardHandler hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useMobileKeyboardHandler,
	type MobileKeyboardSession,
} from '../../../web/hooks/useMobileKeyboardHandler';
import { WEB_DEFAULT_SHORTCUTS } from '../../../web/constants/webShortcuts';
import type { AITabData } from '../../../web/hooks/useWebSocket';

function createTabs(): AITabData[] {
	return [
		{
			id: 'tab-1',
			agentSessionId: null,
			name: 'One',
			starred: false,
			inputValue: '',
			createdAt: 0,
			state: 'idle',
		},
		{
			id: 'tab-2',
			agentSessionId: null,
			name: 'Two',
			starred: false,
			inputValue: '',
			createdAt: 1,
			state: 'idle',
		},
		{
			id: 'tab-3',
			agentSessionId: null,
			name: 'Three',
			starred: false,
			inputValue: '',
			createdAt: 2,
			state: 'idle',
		},
	];
}

describe('useMobileKeyboardHandler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('dispatches toggleMode on the configured shortcut (Cmd+J)', () => {
		const toggleMode = vi.fn();
		const activeSession: MobileKeyboardSession = { inputMode: 'ai' };

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts: WEB_DEFAULT_SHORTCUTS,
				activeSession,
				actions: { toggleMode },
			})
		);

		const event = new KeyboardEvent('keydown', { key: 'j', metaKey: true, cancelable: true });

		act(() => {
			document.dispatchEvent(event);
		});

		expect(toggleMode).toHaveBeenCalledTimes(1);
	});

	it('dispatches prevTab/nextTab on Cmd+Shift+[ and Cmd+Shift+]', () => {
		const prevTab = vi.fn();
		const nextTab = vi.fn();
		const activeSession: MobileKeyboardSession = {
			inputMode: 'ai',
			aiTabs: createTabs(),
			activeTabId: 'tab-2',
		};

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts: WEB_DEFAULT_SHORTCUTS,
				activeSession,
				actions: { prevTab, nextTab },
			})
		);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: '[',
					metaKey: true,
					shiftKey: true,
					cancelable: true,
				})
			);
		});
		expect(prevTab).toHaveBeenCalledTimes(1);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: ']',
					metaKey: true,
					shiftKey: true,
					cancelable: true,
				})
			);
		});
		expect(nextTab).toHaveBeenCalledTimes(1);
	});

	it('dispatches cyclePrev/cycleNext on Cmd+[ and Cmd+]', () => {
		const cyclePrev = vi.fn();
		const cycleNext = vi.fn();

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts: WEB_DEFAULT_SHORTCUTS,
				activeSession: { inputMode: 'ai' },
				actions: { cyclePrev, cycleNext },
			})
		);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true })
			);
		});
		expect(cyclePrev).toHaveBeenCalledTimes(1);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: ']', metaKey: true, cancelable: true })
			);
		});
		expect(cycleNext).toHaveBeenCalledTimes(1);
	});

	it('closes the command palette on Escape when open', () => {
		const onCloseCommandPalette = vi.fn();

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts: WEB_DEFAULT_SHORTCUTS,
				activeSession: null,
				isCommandPaletteOpen: true,
				onCloseCommandPalette,
				actions: {},
			})
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		});

		expect(onCloseCommandPalette).toHaveBeenCalledTimes(1);
	});

	it('does not steal shortcuts from xterm when terminal is focused', () => {
		const toggleMode = vi.fn();

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts: WEB_DEFAULT_SHORTCUTS,
				activeSession: { inputMode: 'terminal' },
				actions: { toggleMode },
			})
		);

		const xtermInput = document.createElement('textarea');
		xtermInput.className = 'xterm-helper-textarea';
		document.body.appendChild(xtermInput);

		const event = new KeyboardEvent('keydown', {
			key: 'j',
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});

		act(() => {
			xtermInput.dispatchEvent(event);
		});

		expect(toggleMode).not.toHaveBeenCalled();
		xtermInput.remove();
	});

	it('ignores events when no handler is registered for the matched shortcut', () => {
		const quickAction = vi.fn();

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts: WEB_DEFAULT_SHORTCUTS,
				activeSession: null,
				actions: { quickAction },
			})
		);

		// Cmd+J (toggleMode) should be a no-op since only quickAction is registered.
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'j', metaKey: true, cancelable: true })
			);
		});

		expect(quickAction).not.toHaveBeenCalled();
	});

	it('skips plain typing inside an input field', () => {
		const newInstance = vi.fn();
		// Simulate a user-customized shortcut bound to a single bare key.
		const shortcuts = {
			...WEB_DEFAULT_SHORTCUTS,
			newInstance: { id: 'newInstance', label: 'New Agent', keys: ['n'] },
		};

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts,
				activeSession: null,
				actions: { newInstance },
			})
		);

		const event = new KeyboardEvent('keydown', { key: 'n', cancelable: true, bubbles: true });
		act(() => {
			input.dispatchEvent(event);
		});

		expect(newInstance).not.toHaveBeenCalled();
		input.remove();
	});

	it('still fires modifier shortcuts while an input field is focused', () => {
		const quickAction = vi.fn();

		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts: WEB_DEFAULT_SHORTCUTS,
				activeSession: null,
				actions: { quickAction },
			})
		);

		const event = new KeyboardEvent('keydown', {
			key: 'k',
			metaKey: true,
			cancelable: true,
			bubbles: true,
		});
		act(() => {
			input.dispatchEvent(event);
		});

		expect(quickAction).toHaveBeenCalledTimes(1);
		input.remove();
	});

	it('does not match an empty or modifier-only shortcut definition', () => {
		const newInstance = vi.fn();
		const shortcuts = {
			newInstance: { id: 'newInstance', label: 'New Agent', keys: [] },
		};

		renderHook(() =>
			useMobileKeyboardHandler({
				shortcuts,
				activeSession: null,
				actions: { newInstance },
			})
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', cancelable: true }));
		});

		expect(newInstance).not.toHaveBeenCalled();
	});
});
