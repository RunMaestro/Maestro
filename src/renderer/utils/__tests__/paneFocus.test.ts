/**
 * Tests for paneFocus.ts - where the caret goes when a tiled pane takes focus.
 *
 * The two DOM-resolved kinds (browser address bar, file editor) are the point
 * of this module: before it, focusing a tiled browser or file pane moved the
 * ring but left the caret in the pane the user came from, so the next keystroke
 * went to the wrong tab. The retry wrapper matters just as much - a pane created
 * and tiled in one commit has not rendered when the focus request is published.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { UnifiedTabRef } from '../../types';
import {
	browserAddressBarId,
	filePaneAttrs,
	focusPaneInput,
	focusPaneInputWhenReady,
} from '../paneFocus';

const ref = (type: UnifiedTabRef['type'], id: string): UnifiedTabRef =>
	({ type, id }) as UnifiedTabRef;

function mountBrowserAddressBar(tabId: string): HTMLInputElement {
	const input = document.createElement('input');
	input.id = browserAddressBarId(tabId);
	input.value = 'https://example.com';
	document.body.appendChild(input);
	return input;
}

/** A file pane subtree: the tagged wrapper, a focusable container, and (optionally) the editor. */
function mountFilePane(tabId: string, opts: { withEditor: boolean }): HTMLElement {
	const pane = document.createElement('div');
	Object.entries(filePaneAttrs(tabId)).forEach(([k, v]) => pane.setAttribute(k, v));
	const container = document.createElement('div');
	container.tabIndex = 0;
	container.setAttribute('data-role', 'container');
	pane.appendChild(container);
	if (opts.withEditor) {
		const editor = document.createElement('div');
		editor.className = 'cm-content';
		editor.tabIndex = 0;
		container.appendChild(editor);
	}
	document.body.appendChild(pane);
	return pane;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.useRealTimers();
});

describe('focusPaneInput - handle-backed kinds', () => {
	it('routes a terminal to its xterm BY ID and reports the handle result', () => {
		const focusTerminal = vi.fn(() => true);
		expect(focusPaneInput(ref('terminal', 'term-1'), { focusTerminal })).toBe(true);
		// By id, not "the active terminal" - a tiled terminal never sets
		// activeTerminalTabId, so the active variant lands on the wrong one.
		expect(focusTerminal).toHaveBeenCalledWith('term-1');
	});

	it('reports failure when the terminal has not registered yet', () => {
		expect(focusPaneInput(ref('terminal', 'term-1'), { focusTerminal: () => false })).toBe(false);
	});

	it('routes an AI pane to the chat input', () => {
		const focusAiInput = vi.fn(() => true);
		expect(focusPaneInput(ref('ai', 'ai-1'), { focusAiInput })).toBe(true);
		expect(focusAiInput).toHaveBeenCalledOnce();
	});

	it('reports failure when no handle was supplied', () => {
		expect(focusPaneInput(ref('terminal', 't'), {})).toBe(false);
		expect(focusPaneInput(ref('ai', 'a'), {})).toBe(false);
	});
});

describe('focusPaneInput - browser', () => {
	it('focuses and selects that tab address bar', () => {
		const input = mountBrowserAddressBar('br-1');
		const select = vi.spyOn(input, 'select');

		expect(focusPaneInput(ref('browser', 'br-1'), {})).toBe(true);
		expect(document.activeElement).toBe(input);
		// Selected so typing REPLACES the home URL instead of appending to it.
		expect(select).toHaveBeenCalledOnce();
	});

	it('picks the right address bar when two browser panes are tiled', () => {
		mountBrowserAddressBar('br-1');
		const second = mountBrowserAddressBar('br-2');
		focusPaneInput(ref('browser', 'br-2'), {});
		expect(document.activeElement).toBe(second);
	});

	it('reports failure when the keep-alive overlay has not mounted yet', () => {
		expect(focusPaneInput(ref('browser', 'missing'), {})).toBe(false);
	});
});

describe('focusPaneInput - file', () => {
	it('focuses the editor so a freshly tiled blank file is typeable', () => {
		const pane = mountFilePane('file-1', { withEditor: true });
		expect(focusPaneInput(ref('file', 'file-1'), {})).toBe(true);
		expect(document.activeElement).toBe(pane.querySelector('.cm-content'));
	});

	it('picks the right editor when two file panes are tiled', () => {
		mountFilePane('file-1', { withEditor: true });
		const second = mountFilePane('file-2', { withEditor: true });
		focusPaneInput(ref('file', 'file-2'), {});
		expect(document.activeElement).toBe(second.querySelector('.cm-content'));
	});

	it('falls back to the preview container when there is no editor', () => {
		// Preview mode has no text input; landing on the scrollable container still
		// moves arrow keys to THIS pane rather than the one the user came from.
		const pane = mountFilePane('file-1', { withEditor: false });
		expect(focusPaneInput(ref('file', 'file-1'), {})).toBe(true);
		expect(document.activeElement).toBe(pane.querySelector('[data-role="container"]'));
	});

	it('reports failure when the pane is not in the DOM', () => {
		expect(focusPaneInput(ref('file', 'nope'), {})).toBe(false);
	});

	it('does not throw on an id containing CSS selector metacharacters', () => {
		// Ids are generated, but a selector built by string concatenation is one
		// bad id away from a SyntaxError that would kill the focus effect.
		expect(() => focusPaneInput(ref('file', 'a"b]c'), {})).not.toThrow();
	});
});

describe('focusPaneInputWhenReady', () => {
	beforeEach(() => vi.useFakeTimers());

	it('keeps retrying until the pane mounts', () => {
		focusPaneInputWhenReady(ref('file', 'late'), {}, { intervalMs: 50, timeoutMs: 1000 });

		vi.advanceTimersByTime(200);
		expect(document.activeElement).toBe(document.body);

		// The lazily-imported CodeMirror bundle finally lands.
		const pane = mountFilePane('late', { withEditor: true });
		vi.advanceTimersByTime(50);
		expect(document.activeElement).toBe(pane.querySelector('.cm-content'));
	});

	it('stops retrying once focus lands', () => {
		const focusTerminal = vi.fn(() => true);
		focusPaneInputWhenReady(ref('terminal', 't'), { focusTerminal }, { intervalMs: 50 });
		vi.advanceTimersByTime(500);
		expect(focusTerminal).toHaveBeenCalledTimes(1);
	});

	it('gives up at the deadline instead of polling forever', () => {
		const focusTerminal = vi.fn(() => false);
		focusPaneInputWhenReady(
			ref('terminal', 't'),
			{ focusTerminal },
			{ intervalMs: 50, timeoutMs: 200 }
		);
		vi.advanceTimersByTime(10_000);
		expect(focusTerminal).toHaveBeenCalledTimes(4);
	});

	it('cancel stops a superseded request from stealing focus later', () => {
		// The user moved on before the pane mounted; the stale request must not
		// yank the caret out from under them when it finally could.
		const cancel = focusPaneInputWhenReady(ref('file', 'slow'), {}, { intervalMs: 50 });
		cancel();
		mountFilePane('slow', { withEditor: true });
		vi.advanceTimersByTime(1000);
		expect(document.activeElement).toBe(document.body);
	});
});
