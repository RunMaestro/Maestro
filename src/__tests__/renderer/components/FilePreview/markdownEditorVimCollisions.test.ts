/**
 * The two collision audits that need no DOM: the recorded Ctrl-chord table
 * against the Vim-mode effective set, and the focus predicate that keeps
 * normal-mode letters out of Maestro's hands while the editor has focus.
 *
 * The behavior these decisions produce (who actually receives Escape, Ctrl+W
 * and Ctrl+O) is in `markdownEditorVim.test.tsx`, which mounts a real
 * CodeMirror view. This file is the bookkeeping half: a table that drifts from
 * the shipped bindings is a comment that lies, and a comment that lies about a
 * keyboard decision is worse than no comment, because it is the thing the next
 * person checks instead of re-deriving it.
 */

import { describe, it, expect } from 'vitest';
import { VIM_EDITOR_CTRL_BINDINGS } from '../../../../renderer/components/FilePreview/markdownEditor/vimKeys';
import {
	isTextEntryTarget,
	isNormalMode,
} from '../../../../renderer/utils/messageScrollNavigation';
import { shortcutKeysCollide } from '../../../../shared/shortcutKeys';
import { effectiveActionsForMode } from '../../../helpers/shortcutModes';

/** Every action the Vim-mode effective set can fire, with its chord. */
const VIM_MODE_ACTIONS = effectiveActionsForMode('vim');

/** The action ids a chord really fires in Vim mode, recomputed from the set. */
function collidingIds(keys: string[]): string[] {
	return VIM_MODE_ACTIONS.filter((a) => shortcutKeysCollide(a.keys, keys))
		.map((a) => a.id)
		.sort();
}

describe('VIM_EDITOR_CTRL_BINDINGS - the recorded table', () => {
	it('names every Maestro action each chord collides with, and no others', () => {
		// Both directions. A missing id is an undocumented collision the next
		// reader will not know to look for; an extra one is a decision defended
		// against a binding that no longer exists. Recomputing from
		// `effectiveShortcutsForMode('vim')` is also what makes the table survive
		// a rebind: move `closeTab` off Cmd+W and this fails until the row is
		// updated, rather than silently describing last year's keyboard.
		const drift = VIM_EDITOR_CTRL_BINDINGS.filter(
			(b) => collidingIds(b.keys).join(',') !== [...b.collides].sort().join(',')
		).map((b) => ({
			chord: b.keys.join('+'),
			recorded: [...b.collides].sort(),
			actual: collidingIds(b.keys),
		}));

		expect(drift).toEqual([]);
	});

	it('still records the chords that would otherwise close a tab or move focus', () => {
		// The four the task of resolving this turned on, pinned by name rather
		// than by count: emptying the table would satisfy the drift test above
		// (nothing recorded, nothing to disagree with), so one of these has to
		// fail loudly instead.
		const byChord = new Map(VIM_EDITOR_CTRL_BINDINGS.map((b) => [b.keys.join('+'), b]));

		expect(byChord.get('Ctrl+w')?.collides).toContain('closeTab');
		expect(byChord.get('Ctrl+t')?.collides).toContain('newTab');
		expect(byChord.get('Ctrl+o')?.collides).toContain('agentSwitcher');
		expect(byChord.get('Ctrl+n')?.collides).toContain('newInstance');
		expect(byChord.get('Ctrl+[')?.collides).toContain('cyclePrev');
	});

	it('is a lookup table: one row per key, every row a real Ctrl chord', () => {
		const eventKeys = VIM_EDITOR_CTRL_BINDINGS.map((b) => b.eventKey);
		expect(new Set(eventKeys).size).toBe(eventKeys.length);

		for (const binding of VIM_EDITOR_CTRL_BINDINGS) {
			// Two entries, `Ctrl` first: the gate reads `event.ctrlKey` and the
			// drift test above reads `keys` through `shortcutKeysCollide`, which
			// canonicalizes a chord rather than parsing it, so a three-key row
			// would compare against nothing and pass vacuously.
			expect(binding.keys[0]).toBe('Ctrl');
			expect(binding.keys).toHaveLength(2);
			expect(binding.modes.length).toBeGreaterThan(0);
			// `eventKey` is matched against `event.key.toLowerCase()`.
			expect(binding.eventKey).toBe(binding.eventKey.toLowerCase());
		}
	});

	it('covers the half-page and jump-list chords a Vim user reaches for first', () => {
		// `<C-d>`, `<C-u>`, `<C-f>`, `<C-b>`, `<C-o>`, `<C-r>`, `<C-v>`: the
		// chords that make the difference between Vim mode and a keymap with Vim
		// letters in it. Listed explicitly because "the package binds it" is not
		// something the table can prove about itself.
		const keys = new Set(VIM_EDITOR_CTRL_BINDINGS.map((b) => b.eventKey));
		for (const k of ['d', 'u', 'f', 'b', 'o', 'r', 'v']) {
			expect(keys.has(k)).toBe(true);
		}
	});
});

describe('normal-mode letters inside the editor', () => {
	/**
	 * The other half of the collision question, and the half that needed no new
	 * code: Vim mode binds bare `h`, `j`, `k`, `l`, `z`, `g g` and `g t` as
	 * SEQUENCES, and the sequence layer is gated on `isNormalMode`, which counts
	 * anything inside `.cm-editor` as text entry (Phase 02 put the selector
	 * there). So the editor keeps its own letters without the keyboard handler
	 * needing to know Vim editing exists.
	 */
	it('counts a node inside .cm-editor as text entry', () => {
		const editor = document.createElement('div');
		editor.className = 'cm-editor';
		const content = document.createElement('div');
		content.className = 'cm-content';
		editor.appendChild(content);
		document.body.appendChild(editor);

		try {
			expect(isTextEntryTarget(content)).toBe(true);
			// Not only the contenteditable: a click target in the editor's gutter
			// or its Vim status panel is the editor too.
			const gutter = document.createElement('span');
			editor.appendChild(gutter);
			expect(isTextEntryTarget(gutter)).toBe(true);
		} finally {
			editor.remove();
		}
	});

	it('closes the sequence gate while the editor holds focus', () => {
		const editor = document.createElement('div');
		editor.className = 'cm-editor';
		const content = document.createElement('div');
		content.className = 'cm-content';
		content.setAttribute('contenteditable', 'true');
		content.tabIndex = 0;
		editor.appendChild(content);
		document.body.appendChild(editor);

		try {
			content.focus();
			// `g` then `g` is Go to Tab 1 in Vim mode, and `h` is Focus Region
			// Left. Both are sequences, so both die here - which is why typing
			// `gg` in the editor moves the caret to the top of the DOCUMENT and
			// not to the first tab.
			expect(isNormalMode({ target: content })).toBe(false);
			// And from a window-level handler, where the target is the body.
			expect(isNormalMode({ target: document.body })).toBe(false);
		} finally {
			editor.remove();
		}
	});

	it('opens the gate again once focus leaves the editor', () => {
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		try {
			outside.focus();
			expect(isNormalMode({ target: outside })).toBe(true);
		} finally {
			outside.remove();
		}
	});
});
