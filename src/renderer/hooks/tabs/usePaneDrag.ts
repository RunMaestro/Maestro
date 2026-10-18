import React from 'react';

import { useUIStore } from '../../stores/uiStore';
import { updateSessionWith } from '../../stores/sessionStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { usePointerDrag } from '../utils/usePointerDrag';
import {
	computeDropZone,
	movePaneInGroup,
	swapPanesInGroup,
	promotePaneToStandalone,
	type DropZone,
} from '../../utils/panelLayout';

/** How far the pointer must travel from the press point before a drag begins (px). */
const DRAG_THRESHOLD = 5;

/** The pane + zone under the pointer during a rearrange drag, or null over nothing. */
export interface PaneDragHover {
	leafId: string;
	zone: DropZone;
}

/**
 * Hit-test the pointer against every rendered pane EXCEPT the one being dragged,
 * returning the target leaf id and drop zone (edge = move/re-split, center = swap).
 * Panes are tagged `data-pane-leaf-id` by TiledLayout; rects are measured live so a
 * resize mid-drag stays accurate. Returns null when the pointer is over no pane.
 */
function resolvePaneHover(
	clientX: number,
	clientY: number,
	selfLeafId: string
): PaneDragHover | null {
	const panes = document.querySelectorAll<HTMLElement>('[data-pane-leaf-id]');
	for (const el of Array.from(panes)) {
		const id = el.dataset.paneLeafId;
		if (!id || id === selfLeafId) continue;
		const r = el.getBoundingClientRect();
		if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
			const zone = computeDropZone(
				{ left: r.left, top: r.top, width: r.width, height: r.height },
				clientX,
				clientY,
				true // pane rearrange unlocks the central SWAP zone
			);
			return { leafId: id, zone };
		}
	}
	return null;
}

/** True when the pointer is over the tab strip (release there pops the pane out). */
function isOverTabBar(clientX: number, clientY: number): boolean {
	const el = document.elementFromPoint(clientX, clientY);
	return !!el?.closest('[data-tour="tab-bar"]');
}

/**
 * Pointer-driven drag for rearranging a tiled pane by its header. Returns an
 * `onPointerDown` handler to spread onto the pane's title bar.
 *
 * Why pointer events and not native HTML5 drag: inside a child Electron window on a
 * scaled display, Chromium's native macOS drag session (`NSDraggingSession`) fires
 * `dragstart` but then ends immediately without ever delivering `drag`/`dragover`/
 * `drop`, so a native-DnD pane rearrange silently no-ops. Pointer events are immune -
 * they behave identically in every window - so tiling drags run entirely on them.
 *
 * Runs on {@link usePointerDrag} for pointer capture. A tiled browser pane is a
 * guest `<webview>`, and without capture the pointer moving over it stops feeding
 * this window's listeners: the release lands in the guest, the drag never ends, and
 * the "Rearranging tile" ghost stays stuck on screen. A release that is still lost
 * settles on the next buttonless move; Escape and an unmount mid-drag cancel through
 * `onCancel`, which clears `uiStore.paneDrag` without moving anything.
 *
 * Once the pointer clears {@link DRAG_THRESHOLD} the drag is live and
 * `uiStore.paneDrag` publishes the hovered target so PaneDragOverlay can paint the
 * drop highlight. On release we commit:
 *   - dropped on another pane's CENTER -> {@link swapPanesInGroup} (trade tiles in place)
 *   - dropped on another pane's EDGE   -> {@link movePaneInGroup} (re-split to that side)
 *   - dropped on the tab strip         -> {@link promotePaneToStandalone} (pop the pane out)
 *   - dropped anywhere else            -> cancel (no-op)
 */
export function usePaneDrag(sessionId: string, groupId: string, leafId: string) {
	const setPaneDrag = useUIStore((s) => s.setPaneDrag);
	const startDrag = usePointerDrag();

	return React.useCallback(
		(e: React.PointerEvent<HTMLElement>) => {
			// Left button only. Header buttons (chevron menu, maximize) are skipped by
			// `ignoreButtons`: capturing the pointer on the bar would retarget their click.
			if (e.button !== 0) return;
			const startX = e.clientX;
			const startY = e.clientY;
			let dragging = false;
			let last = { x: startX, y: startY };

			const clear = () => {
				if (dragging) setPaneDrag(null);
			};

			startDrag(
				e,
				(dx, dy) => {
					if (!dragging) {
						if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
						dragging = true;
					}
					last = { x: startX + dx, y: startY + dy };
					setPaneDrag({
						groupId,
						leafId,
						pointer: last,
						hover: resolvePaneHover(last.x, last.y, leafId),
					});
				},
				{
					ignoreButtons: true,
					onCancel: clear,
					onEnd: () => {
						if (!dragging) return;
						// Clear before committing so a throwing commit cannot strand the overlay.
						clear();
						const hover = resolvePaneHover(last.x, last.y, leafId);
						if (hover) {
							if (hover.zone === 'center') {
								updateSessionWith(sessionId, (s) =>
									swapPanesInGroup(s, groupId, leafId, hover.leafId)
								);
								notifyCenterFlash({ color: 'green', message: 'Swapped' });
							} else {
								updateSessionWith(sessionId, (s) =>
									movePaneInGroup(s, groupId, leafId, hover.leafId, hover.zone)
								);
								notifyCenterFlash({ color: 'green', message: 'Moved' });
							}
						} else if (isOverTabBar(last.x, last.y)) {
							updateSessionWith(sessionId, (s) =>
								promotePaneToStandalone(s, groupId, leafId, s.unifiedTabOrder?.length ?? 0)
							);
							notifyCenterFlash({ color: 'green', message: 'Popped out' });
						}
					},
				}
			);
		},
		[sessionId, groupId, leafId, setPaneDrag, startDrag]
	);
}
