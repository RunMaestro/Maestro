import { memo, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FileAudio, FileVideo, Volume2, X } from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { useAnchoredMenuPosition } from '../../hooks/ui/useAnchoredMenuPosition';
import type { MediaItem } from '../../utils/mediaItems';
import type { Theme } from '../../types';

interface MediaHistoryMenuProps {
	/** The history button this list hangs off. */
	anchorRef: RefObject<HTMLElement | null>;
	/** Owned by the parent so its outside-click check can see the portaled list. */
	menuRef: RefObject<HTMLDivElement>;
	/** Most-recently-played first. */
	entries: MediaItem[];
	activeItemId: string | null;
	onSelect: (itemId: string) => void;
	onRemove: (itemId: string) => void;
	theme: Theme;
}

/**
 * Recently played media, newest first.
 *
 * Media has no tabs, so the transport's prev/next (which walk the queue in open
 * order) are not enough to get back to something heard earlier - this is the
 * jump-anywhere list. Portaled to the body because the player clips its own
 * overflow, which would slice an in-flow menu off at the frame edge.
 */
export const MediaHistoryMenu = memo(function MediaHistoryMenu({
	anchorRef,
	menuRef,
	entries,
	activeItemId,
	onSelect,
	onRemove,
	theme,
}: MediaHistoryMenuProps) {
	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef, { align: 'end' });

	return createPortal(
		<div
			ref={menuRef}
			data-testid="media-history-menu"
			// Above the player (60), far below modals (9999) so it can never cover
			// an overlay.
			className="fixed z-[100] py-1 rounded shadow-xl border max-h-80 overflow-y-auto select-none min-w-[16rem] max-w-[24rem]"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			<div
				className="px-3 py-1 text-[10px] uppercase tracking-wide"
				style={{ color: theme.colors.textDim }}
			>
				Recently Played
			</div>

			{entries.map((entry) => {
				const isActive = entry.id === activeItemId;
				const KindIcon = entry.kind === 'video' ? FileVideo : FileAudio;
				return (
					<div
						key={entry.id}
						className="group flex items-center gap-2 px-3 py-1 hover:bg-white/10 transition-colors"
					>
						<KindIcon
							className="w-3.5 h-3.5 shrink-0"
							style={{ color: isActive ? theme.colors.accent : theme.colors.textDim }}
						/>
						<button
							onClick={() => onSelect(entry.id)}
							className="flex flex-col items-start min-w-0 flex-1 text-left"
							title={entry.path}
						>
							<span
								className="text-xs truncate max-w-full"
								style={{ color: isActive ? theme.colors.accent : theme.colors.textMain }}
							>
								{entry.name}
							</span>
							<span
								className="text-[10px] truncate max-w-full"
								style={{ color: theme.colors.textDim }}
							>
								{entry.sessionName}
							</span>
						</button>

						{/* Marks what is loaded right now, so the list reads as a place you
						    are in rather than a flat log. */}
						{isActive && (
							<Volume2 className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
						)}

						<GhostIconButton
							onClick={() => onRemove(entry.id)}
							title="Remove from the queue"
							ariaLabel={`Remove ${entry.name} from the queue`}
							color={theme.colors.textDim}
						>
							<X className="w-3 h-3" />
						</GhostIconButton>
					</div>
				);
			})}
		</div>,
		document.body
	);
});
