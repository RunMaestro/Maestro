import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { Compartment, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { vim } from '@replit/codemirror-vim';
import { useSettingsStore } from '../../../stores/settingsStore';

/**
 * "Vim keys in a CodeMirror surface", in one place.
 *
 * `MarkdownEditor` is the only caller today, but the gate is three separate
 * pieces of knowledge that a second CodeMirror surface would otherwise have to
 * rediscover, and each one was a bug before it was written down:
 *
 *   1. WHICH setting decides. Vim editing follows the app-wide `keyboardMode`,
 *      not a per-surface prop. A surface that reads a prop instead ends up with
 *      Vim keys in the file preview and not in the memory viewer, for no reason
 *      a user could explain.
 *   2. WHERE the extension sits. `vim()` claims keys through a plain
 *      `eventHandlers.keydown` at DEFAULT precedence, while `keymap.of([...])`
 *      runs its bindings through `Prec.default(...)`. Two extensions at the same
 *      precedence are offered the key in ARRAY ORDER, so the Vim compartment has
 *      to come BEFORE the compartment holding `defaultKeymap` or the default
 *      keymap answers first and Vim is a no-op on every key they share. This is
 *      what the package README means by "make sure vim is included before other
 *      keymaps". A host handler at `Prec.highest` still outranks both, which is
 *      how Cmd+S / Cmd+E and the template autocomplete keep winning.
 *   3. HOW the switch is applied. Reconfiguring a compartment keeps the SAME
 *      `EditorState`, so the document, the caret, the scroll offset, and the
 *      undo history all survive the user flipping the setting. Recreating the
 *      view instead throws away all four.
 *
 * Keep this file as the one home for those rules: a second copy drifts the
 * first time one of them changes.
 */

/**
 * The Vim subtree for a CodeMirror compartment, gated on `active`.
 *
 * Pure, so a caller outside React (or a test asking what the gate produces)
 * does not have to stand up a store. The empty array is a real extension to
 * CM6 - it is how a compartment holds "nothing" without being removed.
 */
export function vimKeysExtension(active: boolean): Extension {
	return active ? vim() : [];
}

/** Whether editor-level Vim keys are live right now, per the app-wide setting. */
export function useVimKeysActive(): boolean {
	return useSettingsStore((s) => s.keyboardMode === 'vim');
}

export interface VimKeysCompartment {
	/**
	 * Put `compartment.of(extension)` FIRST in the editor's extension array,
	 * ahead of whatever holds `keymap.of([...defaultKeymap])`. See rule 2 above.
	 */
	compartment: Compartment;
	/** The Vim subtree as it should be right now. Stable while the mode is. */
	extension: Extension;
}

/**
 * Own the Vim compartment for a CodeMirror view: build it, seed it with the
 * mode at mount, and reconfigure it in place whenever the mode changes.
 *
 * The caller keeps its own `EditorView` ref and mounts the view itself; this
 * hook only needs to reach the view to dispatch the reconfigure.
 */
export function useVimKeysCompartment(viewRef: RefObject<EditorView | null>): VimKeysCompartment {
	const active = useVimKeysActive();
	const compartment = useMemo(() => new Compartment(), []);
	const extension = useMemo(() => vimKeysExtension(active), [active]);

	// Which way the compartment was last configured. Seeded with the value the
	// caller's mount effect uses, so the effect below skips its no-op first run
	// instead of tearing down and rebuilding the plugin the mount just installed.
	const appliedRef = useRef(active);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		if (appliedRef.current === active) return;
		appliedRef.current = active;
		view.dispatch({ effects: compartment.reconfigure(extension) });
	}, [active, extension, compartment, viewRef]);

	return { compartment, extension };
}
