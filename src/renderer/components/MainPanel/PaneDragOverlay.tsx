import { useUIStore } from '../../stores/uiStore';
import type { DropZone } from '../../utils/panelLayout';
import type { Theme } from '../../types';

/**
 * Drop-highlight overlay for the pointer-driven pane REARRANGE drag (see usePaneDrag).
 * It reads the transient `uiStore.paneDrag` state and, while a pane is being dragged,
 * paints - in fixed/client coordinates so it needs no local transform:
 *
 *   - a translucent accent box over the exact region the pane would fill (a half for
 *     an edge zone, the whole target for a center/swap), and
 *   - a "Move" / "⇄ Swap" badge naming the action, and
 *   - a small ghost chip trailing the cursor.
 *
 * Rendered once over the panel. Distinct from PaneDropZones, which still services the
 * native-DnD tab-bar -> panel tiling drag; this overlay is purely pointer-driven and
 * never intercepts events (it is always click-through).
 */
export function PaneDragOverlay({ theme }: { theme: Theme }) {
	const paneDrag = useUIStore((s) => s.paneDrag);
	if (!paneDrag) return null;

	const { pointer, hover } = paneDrag;

	// The highlight rect (client px) for the hovered pane + zone, measured live.
	let highlight: { left: number; top: number; width: number; height: number } | null = null;
	if (hover) {
		const el = document.querySelector<HTMLElement>(`[data-pane-leaf-id="${hover.leafId}"]`);
		if (el) {
			const r = el.getBoundingClientRect();
			highlight = highlightForZone(r, hover.zone);
		}
	}

	const isSwap = hover?.zone === 'center';

	return (
		<div className="fixed inset-0 z-[45] pointer-events-none">
			{highlight && (
				<div
					className="fixed rounded-sm transition-all duration-75 flex items-center justify-center"
					style={{
						left: highlight.left,
						top: highlight.top,
						width: highlight.width,
						height: highlight.height,
						backgroundColor: `${theme.colors.accent}26`,
						border: `2px solid ${theme.colors.accent}`,
					}}
				>
					<span
						className="px-2 py-0.5 rounded text-xs font-semibold select-none"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
					>
						{isSwap ? '⇄ Swap' : 'Move'}
					</span>
				</div>
			)}
			{/* Ghost chip trailing the cursor so the drag reads as "carrying" the tile. */}
			<div
				className="fixed px-2 py-1 rounded text-xs font-medium select-none shadow-lg"
				style={{
					left: pointer.x + 12,
					top: pointer.y + 12,
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.accent,
					border: `1px solid ${theme.colors.accent}`,
				}}
			>
				Rearranging tile…
			</div>
		</div>
	);
}

/** Half-region of a pane rect for an edge zone; the whole rect for center (swap). */
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
