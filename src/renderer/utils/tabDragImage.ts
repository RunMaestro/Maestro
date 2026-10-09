import type { DragEvent } from 'react';
import type { Theme } from '../types';

/**
 * Cursor hotspot offset (px) within the synthesized drag image, so the floating
 * preview trails just below-right of the pointer instead of sitting centered
 * under it (which would hide the cursor).
 */
const DRAG_IMAGE_CURSOR_OFFSET = { x: 14, y: 14 };

/**
 * Attach a themed "floating tab" preview to an in-flight HTML5 tab drag.
 *
 * A tab dragged out of its window has to leave the window's bounds, and a
 * `position: fixed` cursor-following div is clipped to the source window - so it
 * would vanish exactly when the drag-out feedback matters. The OS-rendered drag
 * image (set via `dataTransfer.setDragImage`) instead follows the cursor across
 * windows and over empty space, which is what the cross-window detach gesture
 * needs.
 *
 * Builds a detached, off-screen pill styled from the active theme, hands it to
 * `setDragImage`, then removes it on the next macrotask. The node must outlive
 * the synchronous handler: Chromium snapshots it asynchronously after `dragstart`
 * returns, so removing it immediately would leave a blank preview.
 *
 * Degrades to a no-op (keeping the browser's default ghost) when `setDragImage`
 * is unavailable, e.g. under jsdom in unit tests.
 */
export function setTabDragImage(e: DragEvent, opts: { label: string; theme: Theme }): void {
	if (typeof document === 'undefined' || !e.dataTransfer?.setDragImage) return;
	const { label, theme } = opts;

	const node = document.createElement('div');
	node.textContent = label;
	// Off-screen so it never flashes in the page before the OS snapshots it.
	node.style.position = 'fixed';
	node.style.top = '-1000px';
	node.style.left = '-1000px';
	node.style.pointerEvents = 'none';
	node.style.zIndex = '-1';
	node.style.maxWidth = '220px';
	node.style.overflow = 'hidden';
	node.style.textOverflow = 'ellipsis';
	node.style.whiteSpace = 'nowrap';
	node.style.padding = '6px 12px';
	node.style.borderRadius = '6px';
	node.style.fontSize = '12px';
	node.style.fontWeight = '500';
	// Theme tokens keep the preview consistent with the live tab bar.
	node.style.color = theme.colors.textMain;
	node.style.backgroundColor = theme.colors.bgMain;
	node.style.border = `1px solid ${theme.colors.accent}`;
	node.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';

	document.body.appendChild(node);
	e.dataTransfer.setDragImage(node, DRAG_IMAGE_CURSOR_OFFSET.x, DRAG_IMAGE_CURSOR_OFFSET.y);
	// Snapshot is captured after this handler returns; remove on the next tick.
	setTimeout(() => node.remove(), 0);
}
