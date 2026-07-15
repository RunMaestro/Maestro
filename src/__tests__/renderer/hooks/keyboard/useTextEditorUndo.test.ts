/**
 * Tests for useTextEditorUndo - the window-level Cmd/Ctrl+Z fallback that
 * routes undo/redo to focused text inputs after Maestro's Edit menu
 * intentionally omits the undo/redo roles (image annotator owns Cmd+Z).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTextEditorUndo } from '../../../../renderer/hooks/keyboard/useTextEditorUndo';

describe('useTextEditorUndo', () => {
	// jsdom does not define document.execCommand; install our own and reset
	// per-test so each case starts clean.
	const execCommand = vi.fn().mockReturnValue(true);
	beforeEach(() => {
		execCommand.mockClear();
		Object.defineProperty(document, 'execCommand', {
			value: execCommand,
			configurable: true,
			writable: true,
		});
	});
	afterEach(() => {
		// Leave the property in place across tests; jsdom shares document between
		// them, so wiping it would only buy us a re-install on the next iteration.
	});

	function dispatchKey(
		target: EventTarget,
		opts: {
			key: string;
			metaKey?: boolean;
			ctrlKey?: boolean;
			shiftKey?: boolean;
			altKey?: boolean;
		}
	): KeyboardEvent {
		const ev = new KeyboardEvent('keydown', {
			key: opts.key,
			metaKey: opts.metaKey ?? false,
			ctrlKey: opts.ctrlKey ?? false,
			shiftKey: opts.shiftKey ?? false,
			altKey: opts.altKey ?? false,
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(ev, 'target', { value: target, configurable: true });
		window.dispatchEvent(ev);
		return ev;
	}

	it('routes Cmd+Z on a textarea to document.execCommand("undo")', () => {
		renderHook(() => useTextEditorUndo());
		const textarea = document.createElement('textarea');
		const ev = dispatchKey(textarea, { key: 'z', metaKey: true });
		expect(execCommand).toHaveBeenCalledWith('undo');
		expect(ev.defaultPrevented).toBe(true);
	});

	it('routes Cmd+Shift+Z on an input to document.execCommand("redo")', () => {
		renderHook(() => useTextEditorUndo());
		const input = document.createElement('input');
		dispatchKey(input, { key: 'z', metaKey: true, shiftKey: true });
		expect(execCommand).toHaveBeenCalledWith('redo');
	});

	it('routes Ctrl+Z on Windows/Linux-style chord to undo', () => {
		renderHook(() => useTextEditorUndo());
		const textarea = document.createElement('textarea');
		dispatchKey(textarea, { key: 'z', ctrlKey: true });
		expect(execCommand).toHaveBeenCalledWith('undo');
	});

	it('routes Ctrl+Y to redo on Windows/Linux', () => {
		renderHook(() => useTextEditorUndo());
		const textarea = document.createElement('textarea');
		dispatchKey(textarea, { key: 'y', ctrlKey: true });
		expect(execCommand).toHaveBeenCalledWith('redo');
	});

	it('does NOT fire on non-text targets (e.g. div)', () => {
		renderHook(() => useTextEditorUndo());
		const div = document.createElement('div');
		dispatchKey(div, { key: 'z', metaKey: true });
		expect(execCommand).not.toHaveBeenCalled();
	});

	it('fires on contentEditable elements', () => {
		renderHook(() => useTextEditorUndo());
		const ce = document.createElement('div');
		ce.setAttribute('contenteditable', 'true');
		// jsdom does not honor the contenteditable attribute for isContentEditable;
		// stub it directly so the hook's branch is exercised.
		Object.defineProperty(ce, 'isContentEditable', { value: true, configurable: true });
		dispatchKey(ce, { key: 'z', metaKey: true });
		expect(execCommand).toHaveBeenCalledWith('undo');
	});

	it('skips events with defaultPrevented=true (lets editor-owned undo win)', () => {
		renderHook(() => useTextEditorUndo());
		const textarea = document.createElement('textarea');
		const ev = new KeyboardEvent('keydown', {
			key: 'z',
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(ev, 'target', { value: textarea, configurable: true });
		ev.preventDefault(); // simulate an upstream editor handler claiming the chord
		window.dispatchEvent(ev);
		expect(execCommand).not.toHaveBeenCalled();
	});

	it('ignores chords without a modifier (plain "z")', () => {
		renderHook(() => useTextEditorUndo());
		const textarea = document.createElement('textarea');
		dispatchKey(textarea, { key: 'z' });
		expect(execCommand).not.toHaveBeenCalled();
	});

	it('ignores chords that include Alt (likely an OS / IME combo)', () => {
		renderHook(() => useTextEditorUndo());
		const textarea = document.createElement('textarea');
		dispatchKey(textarea, { key: 'z', metaKey: true, altKey: true });
		expect(execCommand).not.toHaveBeenCalled();
	});

	it('removes the listener on unmount', () => {
		const { unmount } = renderHook(() => useTextEditorUndo());
		unmount();
		const textarea = document.createElement('textarea');
		dispatchKey(textarea, { key: 'z', metaKey: true });
		expect(execCommand).not.toHaveBeenCalled();
	});
});
