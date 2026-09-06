/**
 * One staged-image thumbnail. Shared by the composer strip and the organizer
 * modal so both surfaces get the same slot badge, drag visuals, and per-image
 * controls; the only difference between them is `size`.
 */

import { memo } from 'react';
import { PenLine, X } from 'lucide-react';
import type { Theme } from '../../../types';
import { StagedImageDropLine, type StagedImageTileDragHandlers } from './stagedImageDrag';

const TILE_SIZES = {
	strip: { height: '4rem', maxWidth: '200px', badge: 'text-2xs px-1.5' },
	large: { height: '11rem', maxWidth: '340px', badge: 'text-xs px-2' },
} as const;

interface StagedImageTileProps {
	image: string;
	index: number;
	theme: Theme;
	size: keyof typeof TILE_SIZES;
	/** Show the slot badge. The strip only reveals it during a drag. */
	showSlotNumber: boolean;
	isDragging: boolean;
	isDimmed: boolean;
	/** Zoom multiplier over the size preset. Defaults to 1. */
	scale?: number;
	dropBefore: boolean;
	dropAfter: boolean;
	dragHandlers: StagedImageTileDragHandlers;
	onOpen: () => void;
	onAnnotate: () => void;
	onRemove: () => void;
}

export const StagedImageTile = memo(function StagedImageTile({
	image,
	index,
	theme,
	size,
	showSlotNumber,
	isDragging,
	isDimmed,
	scale = 1,
	dropBefore,
	dropAfter,
	dragHandlers,
	onOpen,
	onAnnotate,
	onRemove,
}: StagedImageTileProps) {
	const dims = TILE_SIZES[size];
	const slot = index + 1;
	// Scale in CSS rather than recomputing a rem number: the presets are the
	// design sizes, and `calc()` keeps the zoom a pure multiplier over them.
	const scaled = (value: string) => (scale === 1 ? value : `calc(${value} * ${scale})`);

	return (
		// The wrapper is the drag source, the drop target, AND the click target.
		// The press has to land on a plain div for the drag to start at all (see
		// StagedImageTileDragHandlers), which rules out wrapping the thumbnail in
		// a <button>, so the open-in-lightbox affordance moves here and brings
		// role/tabIndex/Enter-Space with it.
		<div
			role="button"
			tabIndex={0}
			aria-label={`Staged image ${slot}`}
			className="relative group shrink-0 flex items-center justify-center transition-opacity cursor-grab active:cursor-grabbing outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
			style={{
				minWidth: '64px',
				opacity: isDragging ? 0.4 : isDimmed ? 0.65 : 1,
			}}
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key !== 'Enter' && e.key !== ' ') return;
				e.preventDefault();
				onOpen();
			}}
			{...dragHandlers}
		>
			<StagedImageDropLine theme={theme} side="left" isActive={dropBefore} />
			<StagedImageDropLine theme={theme} side="right" isActive={dropAfter} />

			{/* pointer-events-none keeps the press on the wrapper: the image's own
			    `draggable={false}` computes `-webkit-user-drag: none`, which would
			    stop the drag if it were ever the hit-test target. */}
			<img
				src={image}
				alt=""
				draggable={false}
				className="rounded border group-hover:opacity-80 transition-opacity block pointer-events-none"
				style={{
					height: scaled(dims.height),
					borderColor: theme.colors.border,
					objectFit: 'contain',
					maxWidth: scaled(dims.maxWidth),
				}}
			/>

			<button
				type="button"
				draggable={false}
				onClick={(e) => {
					e.stopPropagation();
					onAnnotate();
				}}
				title="Annotate image"
				aria-label="Annotate image"
				className="absolute top-0.5 left-0.5 bg-black/60 text-white rounded-full p-1 shadow-md hover:bg-black/80 transition-colors opacity-90 hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-white"
			>
				<PenLine className="w-3 h-3" />
			</button>

			<button
				type="button"
				draggable={false}
				onClick={(e) => {
					e.stopPropagation();
					onRemove();
				}}
				title={`Remove image ${slot}`}
				aria-label={`Remove image ${slot}`}
				className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-white"
			>
				<X className="w-3 h-3" />
			</button>

			{/* Slot badge. Overlaid on the thumbnail rather than placed under it so
			    revealing it mid-drag cannot reflow the row the user is dragging in.
			    Anchored bottom-left (clear of the top-corner controls) with a solid
			    accent fill and accent-foreground text plus a shadow, so the number
			    stays legible over any thumbnail rather than washing out against a
			    dark screenshot. */}
			<div
				className={`absolute bottom-1 left-1 rounded font-semibold pointer-events-none transition-opacity duration-150 shadow-md ${dims.badge}`}
				style={{
					opacity: showSlotNumber ? 1 : 0,
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				}}
			>
				{slot}
			</div>
		</div>
	);
});
