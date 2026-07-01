import React from 'react';

import { updateSessionWith } from '../../stores/sessionStore';
import {
	computeDropZone,
	createGroupFromDrop,
	generateGroupName,
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

	React.useEffect(() => {
		const onDragStart = () => setDragActive(true);
		const onDragEnd = () => {
			setDragActive(false);
			setHover(null);
		};
		window.addEventListener('dragstart', onDragStart);
		window.addEventListener('dragend', onDragEnd);
		// A drop anywhere also ends the drag; dragend fires after drop, but guard in
		// case a drop is handled elsewhere and dragend is missed on some platforms.
		window.addEventListener('drop', onDragEnd);
		return () => {
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

			if (activeGroup) {
				const paneEls = overlay.parentElement?.querySelectorAll<HTMLElement>('[data-pane-leaf-id]');
				if (!paneEls || paneEls.length === 0) return null;
				for (const el of Array.from(paneEls)) {
					const r = el.getBoundingClientRect();
					if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
						const local = toLocal(r);
						const zone = computeDropZone(
							local,
							clientX - overlayRect.left,
							clientY - overlayRect.top
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

			// Single view: the overlay itself is the one implicit pane.
			const local = { left: 0, top: 0, width: overlayRect.width, height: overlayRect.height };
			const zone = computeDropZone(local, clientX - overlayRect.left, clientY - overlayRect.top);
			return { leafId: null, zone, highlight: highlightForZone(local, zone) };
		},
		[activeGroup]
	);

	const handleDragOver = React.useCallback(
		(e: React.DragEvent) => {
			if (!dragHasTabTilePayload(e.dataTransfer)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			setHover(resolveHover(e.clientX, e.clientY));
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
			// A pane being dragged toward the tab bar must not re-tile onto the panel.
			if (payload.source === 'pane') return;
			const dragged = payload.ref;

			if (activeGroup) {
				if (!target.leafId) return;
				const groupId = activeGroup.id;
				const leafId = target.leafId;
				updateSessionWith(session.id, (s) =>
					tileTabIntoGroup(s, groupId, leafId, target.zone, dragged)
				);
				return;
			}

			// No group yet: create one from the current single view + the dragged tab.
			if (!activeStandaloneRef) return;
			// Dropping a tab onto its own single view is a no-op (nothing to pair with).
			if (activeStandaloneRef.type === dragged.type && activeStandaloneRef.id === dragged.id) {
				return;
			}
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
					className="absolute rounded-sm transition-all duration-75 pointer-events-none"
					style={{
						left: hover.highlight.left,
						top: hover.highlight.top,
						width: hover.highlight.width,
						height: hover.highlight.height,
						backgroundColor: `${theme.colors.accent}26`,
						border: `2px solid ${theme.colors.accent}`,
					}}
				/>
			)}
		</div>
	);
}
