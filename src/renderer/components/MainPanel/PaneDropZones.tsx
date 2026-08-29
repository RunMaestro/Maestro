import React from 'react';

import { updateSessionWith } from '../../stores/sessionStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import {
	computeDropZone,
	createGroupFromDrop,
	generateGroupName,
	movePaneInGroup,
	sameTabRef,
	swapPanesInGroup,
	tileTabIntoGroup,
	type DropZone,
} from '../../utils/panelLayout';
import {
	dragHasTabTilePayload,
	readTabTilePayload,
	type TabTilePayload,
} from '../../utils/tabDragPayload';
import type { Session, TabGroup, Theme, UnifiedTabRef } from '../../types';

/**
 * Drop-zone overlay for tab tiling (Phase 3). Mounted over the main panel's
 * content area, it stays inert (`pointer-events-none`) until a tab drag carrying
 * the Maestro tiling payload enters. While such a drag is over the panel it:
 *
 *   - hit-tests the pointer against each visible pane (tagged `data-pane-leaf-id`
 *     by TiledLayout) or, when no group is active, against the whole panel as one
 *     implicit pane, and
 *   - renders a translucent highlight of the exact region the dropped tab would
 *     fill (a half for an edge zone, the whole pane for center), and
 *   - on drop, commits the tiling edit through the pure panelLayout helpers in a
 *     single `updateSessionWith` (split an existing group, or create a new group
 *     from the current single view + the dragged tab).
 *
 * This targets ONLY the intra-window tiling drag. It never touches the tab-bar
 * reorder (drop on a chip) or the multi-window drag-out (release outside the
 * window) - both operate on different drop targets and different dataTransfer
 * channels. A `source: 'pane'` drag (a pane dragged toward the tab bar) is ignored
 * here so pulling a pane out doesn't re-tile it in place.
 *
 * A tab never tiles beside ITSELF, so dragging the tab that is already on screen
 * (or a pane over its own tile) resolves to no target at all: no highlight, no
 * `dropEffect`, so the cursor reads "not allowed" and the gesture stays a plain
 * tab-bar reorder. The affordance is withheld rather than shown and then refused,
 * which is why no "you can't do that" flash is needed on drop.
 */
export interface PaneDropZonesProps {
	session: Session;
	/** The active tab group when one is tiled, else null (single-view panel). */
	activeGroup: TabGroup | null;
	/**
	 * The current single-view tab's ref (used only when `activeGroup` is null): a
	 * drop then creates a brand-new group from this tab plus the dragged one. Null
	 * when the single view has no tileable tab (e.g. an empty agent) - a drop is
	 * then a no-op.
	 */
	activeStandaloneRef: UnifiedTabRef | null;
	/** Display title of the single-view tab, for auto-naming a new group. */
	activeStandaloneTitle: string;
	theme: Theme;
	onGroupActivated?: (groupId: string) => void;
}

/** The pane + zone the pointer currently resolves to during a drag. */
interface HoverTarget {
	/** Leaf id of the hovered pane, or null for the single-view implicit pane. */
	leafId: string | null;
	zone: DropZone;
	/** Highlight rectangle in overlay-local coordinates (px). */
	highlight: { left: number; top: number; width: number; height: number };
}

/** Half-region of a pane rect for an edge zone; the whole rect for center. */
function highlightForZone(
	rect: { left: number; top: number; width: number; height: number },
	zone: DropZone
): { left: number; top: number; width: number; height: number } {
	const half = 0.5;
	switch (zone) {
		case 'left':
			return { left: rect.left, top: rect.top, width: rect.width * half, height: rect.height };
		case 'right':
			return {
				left: rect.left + rect.width * half,
				top: rect.top,
				width: rect.width * half,
				height: rect.height,
			};
		case 'top':
			return { left: rect.left, top: rect.top, width: rect.width, height: rect.height * half };
		case 'bottom':
			return {
				left: rect.left,
				top: rect.top + rect.height * half,
				width: rect.width,
				height: rect.height * half,
			};
		default:
			return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
	}
}

export function PaneDropZones({
	session,
	activeGroup,
	activeStandaloneRef,
	activeStandaloneTitle,
	theme,
	onGroupActivated,
}: PaneDropZonesProps) {
	const overlayRef = React.useRef<HTMLDivElement>(null);
	// True while ANY native drag is in flight in this window. The overlay is
	// click-through (pointer-events-none) at rest so it never blocks normal panel
	// interaction; it only becomes a live drop target once a drag begins. Tracked
	// via window-level dragstart/dragend because a `pointer-events-none` element
	// receives no dragenter of its own to arm on.
	const [dragActive, setDragActive] = React.useState(false);
	const [hover, setHover] = React.useState<HoverTarget | null>(null);
	// The in-flight tiling drag's payload: which tab is being dragged and where from
	// ('pane' when a tile header is being dragged, 'tab-bar' when a strip tab is).
	// Only a pane-rearrange drag unlocks the central swap zone; a tab-bar drag stays
	// edges-only. Captured on dragstart (the one phase where reading dataTransfer is
	// allowed) because dragover can only see the type list, not the payload - yet the
	// hover hint must already know whether this drag is a self-drop.
	const dragPayloadRef = React.useRef<TabTilePayload | null>(null);
	// Pending handle for the deferred arm below, so a drag that ends immediately
	// cannot be re-armed by a timer that was already in flight.
	const armTimerRef = React.useRef<number | null>(null);

	React.useEffect(() => {
		const onDragStart = (e: DragEvent) => {
			dragPayloadRef.current = e.dataTransfer ? readTabTilePayload(e.dataTransfer) : null;
			// Arming MUST NOT happen synchronously inside `dragstart`. Chromium has
			// not committed the drag session yet at this point, and the re-render
			// this triggers mounts the overlay over the whole panel, which
			// invalidates the drag source's paint before the browser can snapshot a
			// drag image. The browser's response is to cancel the drag outright:
			// `dragstart` fires, then `dragend` immediately, with no drag session
			// and no `dragover`/`drop` anywhere.
			//
			// Because this listener is on `window`, it armed on EVERY native drag in
			// the app, so one rc-only feature silently killed unrelated drags - the
			// staged-image thumbnails could not be dragged out of the composer at
			// all. Deferring to the next macrotask lets the drag commit first; a
			// user cannot reach a drop zone within a tick, so the overlay is live
			// long before it can be aimed at.
			if (armTimerRef.current !== null) window.clearTimeout(armTimerRef.current);
			armTimerRef.current = window.setTimeout(() => {
				armTimerRef.current = null;
				setDragActive(true);
			}, 0);
		};
		const onDragEnd = () => {
			if (armTimerRef.current !== null) {
				window.clearTimeout(armTimerRef.current);
				armTimerRef.current = null;
			}
			dragPayloadRef.current = null;
			setDragActive(false);
			setHover(null);
		};
		window.addEventListener('dragstart', onDragStart);
		window.addEventListener('dragend', onDragEnd);
		// A drop anywhere also ends the drag; dragend fires after drop, but guard in
		// case a drop is handled elsewhere and dragend is missed on some platforms.
		window.addEventListener('drop', onDragEnd);
		return () => {
			if (armTimerRef.current !== null) {
				window.clearTimeout(armTimerRef.current);
				armTimerRef.current = null;
			}
			window.removeEventListener('dragstart', onDragStart);
			window.removeEventListener('dragend', onDragEnd);
			window.removeEventListener('drop', onDragEnd);
		};
	}, []);

	// Resolve the pointer to a pane + zone using DOM rects measured live (panes can
	// be resized, so we never cache). In a group, hit-test each tagged pane box; in
	// the single view, the whole overlay is one implicit pane (leafId null).
	const resolveHover = React.useCallback(
		(clientX: number, clientY: number): HoverTarget | null => {
			const overlay = overlayRef.current;
			if (!overlay) return null;
			const overlayRect = overlay.getBoundingClientRect();
			const toLocal = (r: DOMRect) => ({
				left: r.left - overlayRect.left,
				top: r.top - overlayRect.top,
				width: r.width,
				height: r.height,
			});

			const payload = dragPayloadRef.current;

			if (activeGroup) {
				const paneEls = overlay.parentElement?.querySelectorAll<HTMLElement>('[data-pane-leaf-id]');
				if (!paneEls || paneEls.length === 0) return null;
				// A pane-rearrange drag (a tile header) unlocks the central swap zone; a
				// tab-bar drag tiling a new tab stays edges-only (no swap target exists).
				const allowCenter = payload?.source === 'pane';
				for (const el of Array.from(paneEls)) {
					const r = el.getBoundingClientRect();
					if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
						// A pane dragged over its own tile has nothing to move or swap with.
						if (payload?.source === 'pane' && payload.leafId === el.dataset.paneLeafId) {
							return null;
						}
						const local = toLocal(r);
						const zone = computeDropZone(
							local,
							clientX - overlayRect.left,
							clientY - overlayRect.top,
							allowCenter
						);
						return {
							leafId: el.dataset.paneLeafId ?? null,
							zone,
							highlight: highlightForZone(local, zone),
						};
					}
				}
				return null;
			}

			// Single view: dragging the tab that is already on screen is a reorder, not a
			// split - it has no second tab to pair with, so it gets no drop target.
			if (payload && activeStandaloneRef && sameTabRef(payload.ref, activeStandaloneRef)) {
				return null;
			}

			// Single view: the overlay itself is the one implicit pane.
			const local = { left: 0, top: 0, width: overlayRect.width, height: overlayRect.height };
			const zone = computeDropZone(local, clientX - overlayRect.left, clientY - overlayRect.top);
			return { leafId: null, zone, highlight: highlightForZone(local, zone) };
		},
		[activeGroup, activeStandaloneRef]
	);

	const handleDragOver = React.useCallback(
		(e: React.DragEvent) => {
			if (!dragHasTabTilePayload(e.dataTransfer)) return;
			const target = resolveHover(e.clientX, e.clientY);
			setHover(target);
			// No target means this drag can't tile here (a tab over its own view, a pane
			// over its own tile). Leave the default in place so the drop is refused and
			// the cursor says so, instead of promising a split that would do nothing.
			if (!target) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
		},
		[resolveHover]
	);

	const handleDragLeave = React.useCallback((e: React.DragEvent) => {
		// Only clear the highlight when the cursor actually left the overlay (not on
		// crossing into a child); a relatedTarget outside the overlay is a true exit.
		const overlay = overlayRef.current;
		const next = e.relatedTarget as Node | null;
		if (overlay && next && overlay.contains(next)) return;
		setHover(null);
	}, []);

	const applyDrop = React.useCallback(
		(payload: TabTilePayload, target: HoverTarget) => {
			// A pane dragged from within the group (source: 'pane') dropped back onto the
			// tiled panel REARRANGES it to the target pane's quadrant. (A pane dropped on the
			// TAB BAR promotes out - a different drop target, handled in TabBar.) Only applies
			// while the same group is active and the drop lands on a different pane.
			if (payload.source === 'pane') {
				if (!activeGroup || !payload.groupId || !payload.leafId) return;
				if (payload.groupId !== activeGroup.id) return;
				if (!target.leafId || target.leafId === payload.leafId) return;
				const groupId = activeGroup.id;
				const draggedLeafId = payload.leafId;
				const targetLeafId = target.leafId;
				const zone = target.zone;
				// Center drop = swap the two tiles in place (keeps the grid shape); an edge
				// drop = reslice, moving the pane to that side of the target (changes the
				// split, e.g. vertical -> horizontal).
				if (zone === 'center') {
					updateSessionWith(session.id, (s) =>
						swapPanesInGroup(s, groupId, draggedLeafId, targetLeafId)
					);
					notifyCenterFlash({ color: 'green', message: 'Swapped' });
					return;
				}
				updateSessionWith(session.id, (s) =>
					movePaneInGroup(s, groupId, draggedLeafId, targetLeafId, zone)
				);
				notifyCenterFlash({ color: 'green', message: 'Moved' });
				return;
			}
			const dragged = payload.ref;

			if (activeGroup) {
				if (!target.leafId) {
					notifyCenterFlash({ color: 'yellow', message: 'Drop onto a pane to tile it' });
					return;
				}
				const groupId = activeGroup.id;
				const leafId = target.leafId;
				updateSessionWith(session.id, (s) =>
					tileTabIntoGroup(s, groupId, leafId, target.zone, dragged)
				);
				notifyCenterFlash({ color: 'green', message: 'Tiled' });
				return;
			}

			// No group yet: create one from the current single view + the dragged tab.
			if (!activeStandaloneRef) {
				notifyCenterFlash({ color: 'yellow', message: 'Nothing here to tile with' });
				return;
			}
			// A tab can't tile beside itself, and resolveHover already refuses that drag
			// (no highlight, no drop), so anything arriving here is a different tab.
			const targetRef = activeStandaloneRef;
			let newGroupId: string | null = null;
			updateSessionWith(session.id, (s) => {
				const next = createGroupFromDrop(
					s,
					targetRef,
					dragged,
					target.zone,
					generateGroupName(activeStandaloneTitle)
				);
				newGroupId = next.activeGroupId;
				return next;
			});
			if (newGroupId) onGroupActivated?.(newGroupId);
			notifyCenterFlash({ color: 'green', message: 'Tiled' });
		},
		[activeGroup, activeStandaloneRef, activeStandaloneTitle, session.id, onGroupActivated]
	);

	const handleDrop = React.useCallback(
		(e: React.DragEvent) => {
			const payload = readTabTilePayload(e.dataTransfer);
			if (!payload) return;
			e.preventDefault();
			e.stopPropagation();
			const target = hover ?? resolveHover(e.clientX, e.clientY);
			if (target) applyDrop(payload, target);
			setDragActive(false);
			setHover(null);
		},
		[hover, resolveHover, applyDrop]
	);

	return (
		<div
			ref={overlayRef}
			className={`absolute inset-0 z-30 ${dragActive ? '' : 'pointer-events-none'}`}
			// Idle: transparent + click-through (pointer-events-none) so it never
			// interferes with normal panel interaction. It becomes a live drop target
			// only while a drag is in flight (dragActive, armed by window dragstart).
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{dragActive && hover && (
				<div
					className="absolute rounded-sm transition-all duration-75 pointer-events-none flex items-center justify-center"
					style={{
						left: hover.highlight.left,
						top: hover.highlight.top,
						width: hover.highlight.width,
						height: hover.highlight.height,
						backgroundColor: `${theme.colors.accent}26`,
						border: `2px solid ${theme.colors.accent}`,
					}}
				>
					{/* Center drop swaps the two tiles; label it so the gesture is discoverable. */}
					{hover.zone === 'center' && (
						<span
							className="px-2 py-0.5 rounded text-xs font-semibold select-none"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
						>
							⇄ Swap
						</span>
					)}
				</div>
			)}
		</div>
	);
}
