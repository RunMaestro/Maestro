/**
 * Unit tests for the shared "Vim keys in a CodeMirror surface" helper.
 *
 * `markdownEditorVim.test.tsx` already proves the behavior end to end through
 * `MarkdownEditor`. What is under test HERE is the contract a second CodeMirror
 * surface would consume directly: the pure gate, the setting it reads, and the
 * compartment lifecycle (stable identity, no reconfigure at mount, one
 * reconfigure per mode switch). Those are invisible from the component tests -
 * a helper that dispatched a redundant reconfigure on every render would still
 * pass every one of them while tearing the Vim plugin down and rebuilding it
 * under a typing user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { EditorState, Compartment, type StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
	vimKeysExtension,
	useVimKeysActive,
	useVimKeysCompartment,
} from '../../../../renderer/components/FilePreview/markdownEditor/vimKeys';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

/** A stand-in for the host's view ref: the hook only ever dispatches on it. */
function fakeViewRef() {
	const dispatch = vi.fn();
	return {
		dispatch,
		ref: { current: { dispatch } as unknown as EditorView },
	};
}

beforeEach(() => {
	useSettingsStore.setState({ keyboardMode: 'default' });
});

describe('vimKeysExtension', () => {
	it('is empty when the gate is off', () => {
		// An empty array is a real CM6 extension - it is how a compartment holds
		// "nothing" without being removed from the configuration.
		expect(vimKeysExtension(false)).toEqual([]);
	});

	it('produces the package extension when the gate is on', () => {
		const ext = vimKeysExtension(true);
		expect(Array.isArray(ext)).toBe(true);
		expect(ext as unknown[]).not.toHaveLength(0);
	});

	it('composes into an EditorState, in a compartment, both ways', () => {
		// The gate's whole job is to be swappable, so the thing worth pinning is
		// that CM6 accepts either value in a compartment without throwing.
		const compartment = new Compartment();
		const state = EditorState.create({
			doc: 'hello',
			extensions: [compartment.of(vimKeysExtension(false))],
		});
		const next = state.update({
			effects: compartment.reconfigure(vimKeysExtension(true)),
		}).state;
		expect(next.doc.toString()).toBe('hello');
	});
});

describe('useVimKeysActive', () => {
	it('is false in default keyboard mode', () => {
		const { result } = renderHook(() => useVimKeysActive());
		expect(result.current).toBe(false);
	});

	it('is true in Vim keyboard mode', () => {
		useSettingsStore.setState({ keyboardMode: 'vim' });
		const { result } = renderHook(() => useVimKeysActive());
		expect(result.current).toBe(true);
	});

	it('follows a live switch of the setting', () => {
		const { result } = renderHook(() => useVimKeysActive());
		act(() => {
			useSettingsStore.setState({ keyboardMode: 'vim' });
		});
		expect(result.current).toBe(true);
	});
});

describe('useVimKeysCompartment', () => {
	it('does not reconfigure at mount', () => {
		// The caller seeds the compartment with `extension` in its own
		// `EditorState.create`, so a dispatch here would tear down the plugin the
		// mount just installed. Both modes, because the no-op first run is the
		// one the applied-ref seed exists to skip.
		const off = fakeViewRef();
		renderHook(() => useVimKeysCompartment(off.ref));
		expect(off.dispatch).not.toHaveBeenCalled();

		useSettingsStore.setState({ keyboardMode: 'vim' });
		const on = fakeViewRef();
		renderHook(() => useVimKeysCompartment(on.ref));
		expect(on.dispatch).not.toHaveBeenCalled();
	});

	it('keeps one compartment across re-renders', () => {
		const { ref } = fakeViewRef();
		const { result, rerender } = renderHook(() => useVimKeysCompartment(ref));
		const first = result.current.compartment;
		rerender();
		rerender();
		// A fresh compartment per render would address a configuration slot the
		// mounted state does not have, so every later reconfigure would be a
		// silent no-op.
		expect(result.current.compartment).toBe(first);
	});

	it('keeps the same extension while the mode is unchanged', () => {
		const { ref } = fakeViewRef();
		const { result, rerender } = renderHook(() => useVimKeysCompartment(ref));
		const first = result.current.extension;
		rerender();
		expect(result.current.extension).toBe(first);
	});

	it('reconfigures exactly once per mode switch', () => {
		const { dispatch, ref } = fakeViewRef();
		renderHook(() => useVimKeysCompartment(ref));

		act(() => {
			useSettingsStore.setState({ keyboardMode: 'vim' });
		});
		expect(dispatch).toHaveBeenCalledTimes(1);

		// A settings write that does not touch the mode must not reach the view.
		act(() => {
			useSettingsStore.setState({ keyboardMode: 'vim' });
		});
		expect(dispatch).toHaveBeenCalledTimes(1);

		act(() => {
			useSettingsStore.setState({ keyboardMode: 'default' });
		});
		expect(dispatch).toHaveBeenCalledTimes(2);
	});

	it('dispatches an effect that swaps its own compartment to Vim', () => {
		const { dispatch, ref } = fakeViewRef();
		const { result } = renderHook(() => useVimKeysCompartment(ref));

		act(() => {
			useSettingsStore.setState({ keyboardMode: 'vim' });
		});

		// Replay the dispatched spec against a real state seeded the way the
		// caller seeds it. The compartment's content going from empty to the
		// package extension is the proof that this swaps the Vim subtree and
		// nothing else.
		const compartment = result.current.compartment;
		const before = EditorState.create({
			doc: 'hello',
			extensions: [compartment.of(vimKeysExtension(false))],
		});
		expect(compartment.get(before)).toEqual([]);

		const spec = dispatch.mock.calls[0][0] as { effects: StateEffect<unknown> };
		const after = before.update({ effects: spec.effects }).state;
		expect(compartment.get(after)).toBe(result.current.extension);
		expect(after.doc.toString()).toBe('hello');
	});

	it('survives a view that is not mounted yet', () => {
		const ref = { current: null } as { current: EditorView | null };
		const { result } = renderHook(() => useVimKeysCompartment(ref));
		expect(() => {
			act(() => {
				useSettingsStore.setState({ keyboardMode: 'vim' });
			});
		}).not.toThrow();
		expect(result.current.extension).not.toEqual([]);
	});
});
