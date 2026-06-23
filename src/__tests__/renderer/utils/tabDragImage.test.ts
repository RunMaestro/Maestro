/**
 * Tests for setTabDragImage (Phase 3 multi-window tab drag-out preview).
 *
 * The helper builds an off-screen, themed pill and hands it to
 * `dataTransfer.setDragImage` so a tab dragged out of its window shows a
 * cursor-following preview the OS renders across windows / empty space. The node
 * must be mounted when handed over (Chromium snapshots it asynchronously) and
 * removed on the next tick, and the whole thing must degrade to a no-op where
 * `setDragImage` is unavailable (jsdom, web build).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DragEvent } from 'react';
import { setTabDragImage } from '../../../renderer/utils/tabDragImage';
import { mockTheme } from '../../helpers/mockTheme';

type SetDragImage = (image: Element, x: number, y: number) => void;

/** A minimal React.DragEvent whose dataTransfer exposes (or omits) setDragImage. */
function makeDragEvent(setDragImage?: SetDragImage): DragEvent {
	return {
		dataTransfer: setDragImage
			? ({ setDragImage } as unknown as DataTransfer)
			: ({} as DataTransfer),
	} as unknown as DragEvent;
}

describe('setTabDragImage', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('mounts a themed preview node and hands it to setDragImage, then removes it', () => {
		vi.useFakeTimers();
		const setDragImage = vi.fn<SetDragImage>();
		const before = document.body.childElementCount;

		setTabDragImage(makeDragEvent(setDragImage), { label: 'Agent Tab', theme: mockTheme });

		expect(setDragImage).toHaveBeenCalledTimes(1);
		const node = setDragImage.mock.calls[0][0] as HTMLElement;
		expect(node.textContent).toBe('Agent Tab');
		// Styled from theme tokens for visual consistency with the live tab bar.
		expect(node.style.border).toContain(mockTheme.colors.accent);
		// Mounted off-screen so the OS can snapshot it before it is removed.
		expect(document.body.contains(node)).toBe(true);

		// The node is cleaned up on the next macrotask once the snapshot is taken.
		vi.runAllTimers();
		expect(document.body.contains(node)).toBe(false);
		expect(document.body.childElementCount).toBe(before);
	});

	it('is a no-op (keeps the default ghost) when setDragImage is unavailable', () => {
		const before = document.body.childElementCount;
		expect(() =>
			setTabDragImage(makeDragEvent(undefined), { label: 'x', theme: mockTheme })
		).not.toThrow();
		// Nothing is appended when the API is missing.
		expect(document.body.childElementCount).toBe(before);
	});
});
