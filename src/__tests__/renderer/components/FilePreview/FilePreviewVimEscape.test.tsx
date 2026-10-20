/**
 * Escape inside the File Preview editor, end to end, with the REAL CodeMirror
 * editor and real Vim keys on it.
 *
 * The layer stack is one of two places Escape was claimed before Vim could see
 * it (that half is in `markdownEditorVim.test.tsx`). This is the other: the
 * host hook FilePreview composes at `Prec.highest`, which runs ahead of Vim
 * inside the editor and used to exit edit mode on every Escape. In Vim mode
 * that fired every time the user finished typing a word.
 *
 * Tab mode on purpose (`isTabMode`), because that is where no layer is
 * registered and this handler is the ONLY thing that sees the key - so what it
 * decides is the whole behavior.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { render, act } from '@testing-library/react';
import { mockTheme } from '../../../helpers/mockTheme';

// CM6's DOMObserver constructs an IntersectionObserver; the shared setup leaves
// it a non-constructable vi.fn(). Same dance as GiantPreview.test.tsx.
class StubIntersectionObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}
const ioGlobal = globalThis as typeof globalThis & {
	IntersectionObserver: typeof IntersectionObserver;
};
const originalIntersectionObserver = ioGlobal.IntersectionObserver;
ioGlobal.IntersectionObserver = StubIntersectionObserver as unknown as typeof IntersectionObserver;
afterAll(() => {
	ioGlobal.IntersectionObserver = originalIntersectionObserver;
});

vi.mock('../../../../renderer/components/FilePreview/giantPreview/languageLoader', () => ({
	loadLanguageExtension: vi.fn(async () => null),
	hasLanguageSupport: () => false,
}));

import { FilePreview } from '../../../../renderer/components/FilePreview';
import { vimEditorAt } from '../../../../renderer/components/FilePreview/markdownEditor';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

const file = { name: 'notes.md', content: 'alpha beta', path: '/test/notes.md' };

function mountEditing(vimMode: boolean) {
	useSettingsStore.setState({ keyboardMode: vimMode ? 'vim' : 'default' });
	const setMarkdownEditMode = vi.fn();
	const result = render(
		<LayerStackProvider>
			<FilePreview
				file={file}
				onClose={vi.fn()}
				theme={mockTheme}
				markdownEditMode
				setMarkdownEditMode={setMarkdownEditMode}
				shortcuts={{}}
				isTabMode
				onSave={vi.fn().mockResolvedValue(true)}
			/>
		</LayerStackProvider>
	);
	return { ...result, setMarkdownEditMode };
}

function contentDom(container: HTMLElement): HTMLElement {
	const el = container.querySelector('.cm-content');
	if (!el) throw new Error('CM6 content element did not mount');
	return el as HTMLElement;
}

function press(container: HTMLElement, key: string): KeyboardEvent {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	act(() => {
		contentDom(container).dispatchEvent(event);
	});
	return event;
}

beforeEach(() => {
	useSettingsStore.setState({ keyboardMode: 'default' });
});

describe('FilePreview - Escape in the editor under Vim mode', () => {
	it('stays in edit mode when Escape only ends insert mode', () => {
		const { container, setMarkdownEditMode } = mountEditing(true);

		press(container, 'i');
		expect(vimEditorAt(contentDom(container))?.mode).toBe('insert');

		press(container, 'Escape');

		// The host declined, so the user is back in normal mode with their
		// document still open. Drop the `vimEditorOwnsEscape` gate from
		// FilePreview and this becomes one call and a closed editor.
		expect(setMarkdownEditMode).not.toHaveBeenCalled();
		expect(vimEditorAt(contentDom(container))?.mode).toBe('normal');
	});

	it('stays in edit mode when Escape ends a visual selection', () => {
		const { container, setMarkdownEditMode } = mountEditing(true);

		press(container, 'v');
		expect(vimEditorAt(contentDom(container))?.mode).toBe('visual');

		press(container, 'Escape');

		expect(setMarkdownEditMode).not.toHaveBeenCalled();
		expect(vimEditorAt(contentDom(container))?.mode).toBe('normal');
	});

	it('leaves edit mode when Escape is pressed in normal mode', () => {
		const { container, setMarkdownEditMode } = mountEditing(true);
		expect(vimEditorAt(contentDom(container))?.mode).toBe('normal');

		press(container, 'Escape');

		// Normal mode has nothing to leave, and in tab mode this is the only way
		// out of the editor, so the host keeps the key.
		expect(setMarkdownEditMode).toHaveBeenCalledWith(false);
	});

	it('leaves edit mode on Escape in default keyboard mode', () => {
		const { container, setMarkdownEditMode } = mountEditing(false);

		press(container, 'Escape');

		// Unchanged behavior for anyone who never turned Vim mode on, which is
		// the half a gate like this is easiest to break.
		expect(setMarkdownEditMode).toHaveBeenCalledWith(false);
	});
});
