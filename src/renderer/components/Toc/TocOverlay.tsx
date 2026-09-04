/**
 * TocOverlay
 *
 * The floating table-of-contents control: a round button pinned bottom-right
 * and the panel it opens (Top sash, scrollable entries, Bottom sash).
 *
 * This is the SINGLE implementation of the TOC's look and feel. It was lifted
 * out of `FilePreviewToc` when Director's Notes needed the same control, so the
 * muscle memory built in File Preview carries over exactly: first entry focused
 * on open, Arrow/Home/End move focus and scroll instantly, clicking an entry
 * scrolls smoothly and leaves the panel open, and the panel is dismissed by
 * Escape or a click outside (both owned by `useTocOverlay`).
 *
 * Presentational only: it does not own the open state, the hotkey, or the
 * dismiss wiring. Pair it with `useTocOverlay` so every surface gets identical
 * behavior rather than a re-implementation that drifts.
 */

import React, { RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { List, ChevronUp, ChevronDown } from 'lucide-react';
import type { Theme } from '../../types';
import type { TocEntry } from './types';

interface TocOverlayProps {
	theme: Theme;
	/** Entries to list. The overlay renders nothing when this is empty. */
	entries: TocEntry[];
	/** Overlay width in px - use `computeTocWidth(entries)`. */
	width: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Jump the scroll container to its top or bottom (the two sashes). */
	onScrollToBoundary: (direction: 'top' | 'bottom') => void;
	/**
	 * Scroll container searched for `#slug` when `onSelectEntry` is absent or
	 * declines. Optional so a surface can rely solely on `onSelectEntry`.
	 */
	containerRef?: RefObject<HTMLElement | null>;
	/** Ref for the toggle button - `useTocOverlay` needs it for click-outside. */
	buttonRef: RefObject<HTMLButtonElement>;
	/** Ref for the panel - `useTocOverlay` needs it for click-outside. */
	overlayRef: RefObject<HTMLDivElement>;
	/**
	 * Custom scroll handler. Return true when handled; false falls back to
	 * `containerRef.querySelector('#slug')`. Used where the target isn't a
	 * plain heading in the DOM (the virtualized Fast tier, Rich Mode's cards).
	 */
	onSelectEntry?: (entry: TocEntry) => boolean;
	/** Accessible label / tooltip for the toggle button. */
	buttonTitle?: string;
}

export const TocOverlay = React.memo(function TocOverlay({
	theme,
	entries,
	width,
	open,
	onOpenChange,
	onScrollToBoundary,
	containerRef,
	buttonRef,
	overlayRef,
	onSelectEntry,
	buttonTitle = 'Table of Contents',
}: TocOverlayProps) {
	const entryButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const [activeIndex, setActiveIndex] = useState(0);
	const prevOpenRef = useRef(false);

	// Focus the first entry whenever the overlay opens - supports keyboard-only nav.
	useEffect(() => {
		if (open && !prevOpenRef.current && entries.length > 0) {
			setActiveIndex(0);
			requestAnimationFrame(() => {
				entryButtonRefs.current[0]?.focus();
			});
		}
		prevOpenRef.current = open;
	}, [open, entries.length]);

	const scrollToEntry = useCallback(
		(entry: TocEntry, behavior: ScrollBehavior) => {
			if (onSelectEntry?.(entry)) {
				return;
			}
			const targetElement = containerRef?.current?.querySelector(`#${CSS.escape(entry.slug)}`);
			if (targetElement) {
				targetElement.scrollIntoView({ behavior, block: 'start' });
			}
		},
		[containerRef, onSelectEntry]
	);

	const handleEntriesKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
			return;
		}
		// Stop propagation so the host container's arrow-scroll handler doesn't
		// also fire and nudge the content on each press.
		e.preventDefault();
		e.stopPropagation();
		const last = entries.length - 1;
		let next = activeIndex;
		if (e.key === 'ArrowDown') next = Math.min(activeIndex + 1, last);
		else if (e.key === 'ArrowUp') next = Math.max(activeIndex - 1, 0);
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = last;
		if (next === activeIndex) return;
		setActiveIndex(next);
		entryButtonRefs.current[next]?.focus();
		// Instant scroll on keyboard nav so rapid arrow presses stay responsive.
		scrollToEntry(entries[next], 'auto');
	};

	if (entries.length === 0) {
		return null;
	}

	return (
		<>
			{/* Floating TOC Button */}
			<button
				ref={buttonRef}
				onClick={() => onOpenChange(!open)}
				className="absolute bottom-4 right-4 p-2.5 rounded-full shadow-lg transition-all duration-200 hover:scale-105 z-10"
				style={{
					backgroundColor: open ? theme.colors.accent : theme.colors.bgSidebar,
					color: open ? theme.colors.accentForeground : theme.colors.textMain,
					border: `1px solid ${theme.colors.border}`,
				}}
				title={buttonTitle}
			>
				<List className="w-5 h-5" />
			</button>

			{/* TOC Overlay - click outside and Escape handled by useTocOverlay */}
			{open && (
				<div
					ref={overlayRef}
					className="absolute bottom-16 right-4 rounded-lg shadow-xl overflow-hidden z-20 animate-in fade-in slide-in-from-bottom-2 duration-200 flex flex-col"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						maxHeight: 'calc(70vh - 80px)',
						width: `${width}px`,
					}}
					onWheel={(e) => e.stopPropagation()}
				>
					{/* TOC Header */}
					<div
						className="px-3 py-2 border-b flex items-center justify-between flex-shrink-0"
						style={{ borderColor: theme.colors.border }}
					>
						<span
							className="text-xs font-medium uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Contents
						</span>
						<span className="text-2xs" style={{ color: theme.colors.textDim }}>
							{entries.length} headings
						</span>
					</div>

					{/* Top Navigation Sash */}
					<button
						data-testid="toc-top-button"
						onClick={() => {
							onScrollToBoundary('top');
						}}
						className="w-full px-3 py-2 text-left text-xs border-b transition-colors flex items-center gap-2 hover:brightness-110 flex-shrink-0"
						style={{
							backgroundColor: `${theme.colors.accent}15`,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						title="Jump to top"
					>
						<ChevronUp className="w-3 h-3" style={{ color: theme.colors.accent }} />
						<span>Top</span>
					</button>

					{/* TOC Entries - scrollable middle section */}
					<div
						className="overflow-y-auto px-1 py-1 flex-1 min-h-0"
						style={{ overscrollBehavior: 'contain' }}
						onWheel={(e) => e.stopPropagation()}
						onKeyDown={handleEntriesKeyDown}
					>
						{entries.map((entry, index) => {
							// Color by level (matches the prose styles).
							const levelColors: Record<number, string> = {
								1: theme.colors.accent,
								2: theme.colors.success,
								3: theme.colors.warning,
								4: theme.colors.textMain,
								5: theme.colors.textMain,
								6: theme.colors.textDim,
							};
							const entryColor = levelColors[entry.level] || theme.colors.textMain;

							const isActive = index === activeIndex;
							return (
								<button
									key={`${entry.slug}-${index}`}
									ref={(el) => {
										entryButtonRefs.current[index] = el;
									}}
									onClick={() => {
										setActiveIndex(index);
										// Click is deliberate - keep smooth scroll for visual continuity.
										scrollToEntry(entry, 'smooth');
										// Panel stays open so the user can click several entries.
										// Dismiss with a click outside or Escape.
									}}
									className="w-full px-2 py-1.5 text-left text-sm rounded hover:bg-white/10 transition-colors flex items-center gap-1 focus:outline-none"
									style={{
										color: entryColor,
										paddingLeft: `${(entry.level - 1) * 12 + 8}px`,
										opacity: entry.level > 3 ? 0.85 : 1,
										fontSize:
											entry.level === 1 ? '0.875rem' : entry.level === 2 ? '0.8125rem' : '0.75rem',
										backgroundColor: isActive ? `${theme.colors.accent}25` : undefined,
										boxShadow: isActive ? `inset 2px 0 0 ${theme.colors.accent}` : undefined,
									}}
									title={entry.text}
								>
									<span>{entry.text}</span>
								</button>
							);
						})}
					</div>

					{/* Bottom Navigation Sash */}
					<button
						data-testid="toc-bottom-button"
						onClick={() => {
							onScrollToBoundary('bottom');
						}}
						className="w-full px-3 py-2 text-left text-xs border-t transition-colors flex items-center gap-2 hover:brightness-110 flex-shrink-0"
						style={{
							backgroundColor: `${theme.colors.accent}15`,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						title="Jump to bottom"
					>
						<ChevronDown className="w-3 h-3" style={{ color: theme.colors.accent }} />
						<span>Bottom</span>
					</button>
				</div>
			)}
		</>
	);
});

export default TocOverlay;
