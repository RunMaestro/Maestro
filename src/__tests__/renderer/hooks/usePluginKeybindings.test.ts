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

	it('never hijacks typing in a textarea (bare chord)', async () => {
		// A plugin that bound a bare letter must stay inert while the user types.
		await mountWithChords([{ ...OVERLAY_CHORD, key: 'F' }]);

		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		const bare = press({ key: 'F', target: textarea });
		const shifted = press({ key: 'F', shiftKey: true, target: textarea }); // Shift+letter is typing too
		textarea.remove();

		expect(pluginBridge.invokeCommand).not.toHaveBeenCalled();
		// Not calling the command is only half of it: a preventDefault() would
		// swallow the keystroke and the character would never reach the textarea.
		expect(bare.defaultPrevented).toBe(false);
		expect(shifted.defaultPrevented).toBe(false);
	});

	// Greptile P1 on PR #1354: narrowing the input-focus skip to bare keys made
	// contributed chords usable from the composer, but it also handed plugins
	// every Ctrl/Cmd and Alt combination the app does not bind. Since a match
	// calls preventDefault(), a plugin binding Ctrl+Z would silently break undo
	// while the user is editing.
	it.each([
		['ctrl+z (undo)', { key: 'z', ctrlKey: true }],
		['meta+z (undo, mac)', { key: 'z', metaKey: true }],
		['ctrl+shift+z (redo)', { key: 'z', ctrlKey: true, shiftKey: true }],
		['ctrl+a (select all)', { key: 'a', ctrlKey: true }],
		['ctrl+v (paste)', { key: 'v', ctrlKey: true }],
		['ctrl+arrowleft (word motion)', { key: 'ArrowLeft', ctrlKey: true }],
		['alt+backspace (delete word)', { key: 'Backspace', altKey: true }],
	])('leaves the reserved native editing chord %s alone in a textarea', async (_label, init) => {
		// Bind the plugin to exactly that chord, so only the reserved-chord guard
		// can stop it from firing.
		await mountWithChords([
			{
				...OVERLAY_CHORD,
				key: `${init.ctrlKey || init.metaKey ? 'Ctrl+' : ''}${init.altKey ? 'Alt+' : ''}${init.shiftKey ? 'Shift+' : ''}${init.key}`,
			},
		]);

		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		const event = press({ ...init, target: textarea });
		textarea.remove();

		expect(pluginBridge.invokeCommand).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it('still fires a reserved-looking chord when NO text surface has focus', async () => {
		// The guard is scoped to editable targets. Outside one, Ctrl+Z is fair game.
		await mountWithChords([{ ...OVERLAY_CHORD, key: 'Ctrl+z' }]);

		press({ key: 'z', ctrlKey: true });

		expect(pluginBridge.invokeCommand).toHaveBeenCalledWith(
			`${OVERLAY_CHORD.pluginId}/${OVERLAY_CHORD.command}`
		);
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
