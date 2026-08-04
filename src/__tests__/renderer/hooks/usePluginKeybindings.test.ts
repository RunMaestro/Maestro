/**
 * @file usePluginKeybindings.test.ts
 * @description The keyboard half of the summon path: a contributed chord must
 * reach the plugin command that calls `ui.togglePanel`. Uses the agent-flow
 * overlay chord (Alt+Shift+F) as the fixture, and pins the conflict policy the
 * hook's module doc promises - app shortcuts win, typing is never hijacked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { usePluginKeybindings } from '../../../renderer/hooks/usePluginKeybindings';
import type { AggregatedContributions } from '../../../shared/plugins/contributions';

const EMPTY: AggregatedContributions = {
	themes: [],
	iconPacks: [],
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	agents: [],
	tools: [],
	keybindings: [],
	uiItems: [],
	hostViews: [],
	groupings: [],
	errorsByPlugin: {},
};

const OVERLAY_CHORD = {
	id: 'acme.flow/toggle-overlay',
	localId: 'toggle-overlay',
	pluginId: 'acme.flow',
	key: 'Alt+Shift+F',
	command: 'overlay',
};

const pluginBridge = {
	contributions: vi.fn<() => Promise<AggregatedContributions>>(),
	onChanged: vi.fn(() => () => {}),
	invokeCommand: vi.fn().mockResolvedValue({ dispatched: true }),
};

/** Dispatch a keydown on window, returning the event so callers can read
 * `defaultPrevented`. */
function press(init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent {
	const { target, ...eventInit } = init;
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...eventInit });
	act(() => {
		(target ?? window).dispatchEvent(event);
	});
	return event;
}

/** Mount the hook and wait until the contributed chords have landed. */
async function mountWithChords(keybindings = [OVERLAY_CHORD]) {
	pluginBridge.contributions.mockResolvedValue({ ...EMPTY, keybindings });
	const view = renderHook(() => usePluginKeybindings());
	await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
	// Flush the resolved contributions state update so the parse effect has run.
	await act(async () => {});
	return view;
}

beforeEach(() => {
	window.maestro.plugins = pluginBridge as unknown as typeof window.maestro.plugins;
	pluginBridge.contributions.mockReset().mockResolvedValue(EMPTY);
	pluginBridge.onChanged.mockClear();
	pluginBridge.invokeCommand.mockClear();
});

afterEach(() => cleanup());

describe('usePluginKeybindings - overlay summon chord', () => {
	it('invokes the bound plugin command on a chord match', async () => {
		await mountWithChords();

		const event = press({ key: 'F', altKey: true, shiftKey: true });

		expect(pluginBridge.invokeCommand).toHaveBeenCalledTimes(1);
		expect(pluginBridge.invokeCommand).toHaveBeenCalledWith('acme.flow/overlay');
		// Claimed, so the browser default (and any later listener) is suppressed.
		expect(event.defaultPrevented).toBe(true);
	});

	it('matches on e.code when the layout rewrites the Alt key (macOS)', async () => {
		await mountWithChords();

		// macOS turns Alt+f into "ƒ"; the physical key still names the chord.
		press({ key: 'ƒ', code: 'KeyF', altKey: true, shiftKey: true });

		expect(pluginBridge.invokeCommand).toHaveBeenCalledWith('acme.flow/overlay');
	});

	it('ignores a near-miss chord (wrong modifiers)', async () => {
		await mountWithChords();

		press({ key: 'F', altKey: true }); // no Shift
		press({ key: 'F', shiftKey: true }); // no Alt
		press({ key: 'F', altKey: true, shiftKey: true, metaKey: true }); // extra meta
		press({ key: 'G', altKey: true, shiftKey: true }); // wrong key

		expect(pluginBridge.invokeCommand).not.toHaveBeenCalled();
	});

	it('yields to an app shortcut that already claimed the event', async () => {
		await mountWithChords();

		const event = new KeyboardEvent('keydown', {
			key: 'F',
			altKey: true,
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		event.preventDefault();
		act(() => {
			window.dispatchEvent(event);
		});

		expect(pluginBridge.invokeCommand).not.toHaveBeenCalled();
	});

	it('never hijacks typing in an input (bare chord)', async () => {
		// A plugin that bound a bare letter must stay inert while the user types.
		await mountWithChords([{ ...OVERLAY_CHORD, key: 'F' }]);

		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		press({ key: 'F', target: textarea });
		press({ key: 'F', shiftKey: true, target: textarea }); // Shift+letter is typing too
		textarea.remove();

		expect(pluginBridge.invokeCommand).not.toHaveBeenCalled();
	});

	it('still fires a modifier-bearing chord while a textarea has focus', async () => {
		// The composer textarea is Maestro's resting focus state, so Alt+Shift+F
		// must work there or the chord is inert in the default state (finding AA1).
		await mountWithChords();

		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		const event = press({ key: 'F', altKey: true, shiftKey: true, target: textarea });
		textarea.remove();

		expect(pluginBridge.invokeCommand).toHaveBeenCalledTimes(1);
		expect(pluginBridge.invokeCommand).toHaveBeenCalledWith('acme.flow/overlay');
		expect(event.defaultPrevented).toBe(true);
	});

	it('stops matching once the chord is unmounted', async () => {
		const { unmount } = await mountWithChords();
		unmount();

		press({ key: 'F', altKey: true, shiftKey: true });

		expect(pluginBridge.invokeCommand).not.toHaveBeenCalled();
	});
});
