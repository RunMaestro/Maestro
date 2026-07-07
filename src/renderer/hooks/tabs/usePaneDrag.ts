import React from 'react';

import { useUIStore } from '../../stores/uiStore';
import { updateSessionWith } from '../../stores/sessionStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
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
 * On press we arm window-level pointer listeners; once the pointer clears
 * {@link DRAG_THRESHOLD} the drag is live and `uiStore.paneDrag` publishes the hovered
 * target so PaneDragOverlay can paint the drop highlight. On release we commit:
 *   - dropped on another pane's CENTER -> {@link swapPanesInGroup} (trade tiles in place)
 *   - dropped on another pane's EDGE   -> {@link movePaneInGroup} (re-split to that side)
 *   - dropped on the tab strip         -> {@link promotePaneToStandalone} (pop the pane out)
 *   - dropped anywhere else            -> cancel (no-op)
 */
export function usePaneDrag(sessionId: string, groupId: string, leafId: string) {
	const setPaneDrag = useUIStore((s) => s.setPaneDrag);

	return React.useCallback(
		(e: React.PointerEvent) => {
			// Left button only; ignore the chevron menu / maximize button (they stop
			// propagation themselves, but guard anyway) and modified clicks.
			if (e.button !== 0) return;
			const startX = e.clientX;
			const startY = e.clientY;
			let dragging = false;

			const onMove = (ev: PointerEvent) => {
				if (!dragging) {
					if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
					dragging = true;
				}
				setPaneDrag({
					groupId,
					leafId,
					pointer: { x: ev.clientX, y: ev.clientY },
					hover: resolvePaneHover(ev.clientX, ev.clientY, leafId),
				});
			};

			const onUp = (ev: PointerEvent) => {
				window.removeEventListener('pointermove', onMove, true);
				window.removeEventListener('pointerup', onUp, true);
				window.removeEventListener('pointercancel', onUp, true);
				if (dragging) {
					const hover = resolvePaneHover(ev.clientX, ev.clientY, leafId);
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
					} else if (isOverTabBar(ev.clientX, ev.clientY)) {
						updateSessionWith(sessionId, (s) =>
							promotePaneToStandalone(s, groupId, leafId, s.unifiedTabOrder?.length ?? 0)
						);
						notifyCenterFlash({ color: 'green', message: 'Popped out' });
					}
				}
				setPaneDrag(null);
			};

			window.addEventListener('pointermove', onMove, true);
			window.addEventListener('pointerup', onUp, true);
			window.addEventListener('pointercancel', onUp, true);
		},
		[sessionId, groupId, leafId, setPaneDrag]
	);
}
