import { memo, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { FileAudio, FileVideo, X } from 'lucide-react';

import { GhostIconButton } from '../ui/GhostIconButton';
import { useAnchoredMenuPosition } from '../../hooks/ui/useAnchoredMenuPosition';
import { formatMediaTime, type MediaItem } from '../../utils/mediaItems';
import type { Theme } from '../../types';

interface MediaListMenuProps {
	/** The title bar button this list hangs off. */
	anchorRef: RefObject<HTMLElement | null>;
	/** Owned by the parent so its outside-click check can see the portaled list. */
	menuRef: RefObject<HTMLDivElement>;
	/** Heading, and the word the remove tooltips use ("queue" / "history"). */
	title: string;
	listLabel: string;
	entries: MediaItem[];
	/** Item ID -> length in seconds, for the time on each row. */
	durations: Record<string, number>;
	/** Item ID -> where playback was left, so a part-played row can say so. */
	resumeTimes: Record<string, number>;
	onSelect: (item: MediaItem) => void;
	onRemove: (itemId: string) => void;
	/** Empties the whole list. Omitted when there is nothing worth clearing. */
	onClear?: () => void;
	testId: string;
	theme: Theme;
}

/**
 * The player's drop-down list of media, used for both the play queue and the
 * recently played history.
 *
 * The two lists are the same UI over different data - one is what plays next in
 * open order, the other is what already played in recency order - so they share
 * a component rather than drifting apart. Media has no tabs, and the
 * transport's prev/next only step one position, so these menus are the only way
 * to reach a file that is neither adjacent nor loaded.
 *
 * Portaled to the body because the player clips its own overflow, which would
 * slice an in-flow menu off at the frame edge.
 */
export const MediaListMenu = memo(function MediaListMenu({
	anchorRef,
	menuRef,
	title,
	listLabel,
	entries,
	durations,
	resumeTimes,
	onSelect,
	onRemove,
	onClear,
	testId,
	theme,
}: MediaListMenuProps) {
	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef, { align: 'end' });

	return createPortal(
		<div
			ref={menuRef}
			data-testid={testId}
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
			<div className="flex items-center gap-2 px-3 py-1">
				<span
					className="text-[10px] uppercase tracking-wide flex-1"
					style={{ color: theme.colors.textDim }}
				>
					{title}
				</span>
				{onClear && entries.length > 0 && (
					<button
						onClick={onClear}
						className="text-[10px] uppercase tracking-wide hover:underline"
						style={{ color: theme.colors.textDim }}
					>
						Clear
					</button>
				)}
			</div>

			{entries.map((entry) => {
				const KindIcon = entry.kind === 'video' ? FileVideo : FileAudio;
				const duration = durations[entry.id];
				const resume = resumeTimes[entry.id] ?? 0;
				// "How much is left" is the useful number for something part-listened,
				// and it is only worth saying when the file is genuinely in the middle:
				// a second either end is the difference between "not started" and
				// "finished", which the plain length already conveys.
				const remaining =
					typeof duration === 'number' && resume > 1 && resume < duration - 1
						? duration - resume
						: null;
				return (
					<div
						key={entry.id}
						className="group flex items-center gap-2 px-3 py-1 hover:bg-white/10 transition-colors"
					>
						<KindIcon className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
						<button
							onClick={() => onSelect(entry)}
							className="flex flex-col items-start min-w-0 flex-1 text-left"
							title={entry.path}
						>
							<span
								className="text-xs truncate max-w-full"
								style={{ color: theme.colors.textMain }}
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

						{/* How long it runs, and how much of it is left if the user is
						    part way through. Tabular figures so the column lines up. */}
						<div className="flex flex-col items-end shrink-0 font-mono tabular-nums">
							<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
								{formatMediaTime(duration)}
							</span>
							{remaining !== null && (
								<span
									className="text-[10px] opacity-70"
									style={{ color: theme.colors.textDim }}
									title={`${formatMediaTime(remaining)} left`}
								>
									-{formatMediaTime(remaining)}
								</span>
							)}
						</div>

						<GhostIconButton
							onClick={() => onRemove(entry.id)}
							title={`Remove from the ${listLabel}`}
							ariaLabel={`Remove ${entry.name} from the ${listLabel}`}
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
