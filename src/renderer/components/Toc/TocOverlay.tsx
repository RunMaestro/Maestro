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
import { useScrollIntoView } from '../../hooks/ui/useScrollIntoView';
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
	 * plain heading in the DOM (the virtualized Fast tier, Rich Mode's cards),
	 * or where the host owns one jump path shared with another surface.
	 *
	 * It receives the BEHAVIOR too, because that is decided here rather than by
	 * the host: a click scrolls smoothly, but keyboard navigation scrolls
	 * instantly, since key repeat outruns a smooth animation and every repeat
	 * cancels the one still in flight.
	 */
	onSelectEntry?: (entry: TocEntry, behavior: ScrollBehavior) => boolean;
	/**
	 * Index of the entry the HOST document is currently scrolled under, or `-1`
	 * when the reader is above the first heading. Optional: a surface that cannot
	 * measure its own scroll simply never passes it, and the list then follows
	 * only what the user clicks.
	 *
	 * Deliberately separate from the row this overlay LIGHTS. A click or arrow
	 * press must light its row immediately rather than waiting for the jump's
	 * scroll to land, and near the bottom of a document the scroll clamps so
	 * `activeIndex` stops changing - a list driven only by the document would
	 * freeze there and the last few headings would be unreachable by keyboard.
	 */
	activeIndex?: number;
	/** Accessible label / tooltip for the toggle button. */
	buttonTitle?: string;
	/**
	 * Key that opens a searchable palette over these same headings, rendered as
	 * a keycap beside the heading count. Opt-in because the palette belongs to
	 * the SURFACE, not to this overlay: File Preview binds `#`, and advertising
	 * it from a surface that binds nothing sends the user to press a dead key.
	 */
	searchShortcutKey?: string;
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
	activeIndex,
	buttonTitle = 'Table of Contents',
	searchShortcutKey,
}: TocOverlayProps) {
	// The row this list LIGHTS, which is not the same question as where the
	// document is scrolled - see the `activeIndex` prop. `-1` is a real value:
	// the reader is above the first heading, so no row is lit and the Top sash
	// takes the accent rail instead.
	const [selectedIndex, setSelectedIndex] = useState(activeIndex ?? 0);
	// Keeps the lit row visible. Needed because the selection now MOVES ON ITS
	// OWN as the reader scrolls the document - without this the highlight walks
	// off the bottom of the list and the panel looks like it stopped tracking.
	// Instant, not smooth: the reader may be scrolling continuously, and a
	// per-section animation would never finish.
	const entryButtonRefs = useScrollIntoView<HTMLButtonElement>(
		open,
		selectedIndex,
		entries.length,
		'auto'
	);
	const prevOpenRef = useRef(false);

	// Follow the document. Only fires when the reader crosses into a new section.
	useEffect(() => {
		if (activeIndex === undefined) return;
		setSelectedIndex(activeIndex);
	}, [activeIndex]);

	// Focus the current entry whenever the overlay opens - supports keyboard-only nav.
	useEffect(() => {
		if (open && !prevOpenRef.current && entries.length > 0) {
			const landing = activeIndex ?? 0;
			setSelectedIndex(landing);
			// A `-1` landing lights no row, so focus the first one rather than
			// indexing off the end of the ref array.
			const focusIndex = Math.max(landing, 0);
			requestAnimationFrame(() => {
				entryButtonRefs.current[focusIndex]?.focus();
			});
		}
		prevOpenRef.current = open;
	}, [open, entries.length]);

	const scrollToEntry = useCallback(
		(entry: TocEntry, behavior: ScrollBehavior) => {
			if (onSelectEntry?.(entry, behavior)) {
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
		let next = selectedIndex;
		if (e.key === 'ArrowDown') next = Math.min(selectedIndex + 1, last);
		else if (e.key === 'ArrowUp') next = Math.max(selectedIndex - 1, 0);
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = last;
		if (next === selectedIndex) return;
		setSelectedIndex(next);
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
						<span
							className="text-2xs flex items-center gap-1.5"
							style={{ color: theme.colors.textDim }}
						>
							<span>{entries.length} headings</span>
							{searchShortcutKey && (
								<kbd
									className="px-1 rounded font-mono"
									style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.accent }}
									title={`Press ${searchShortcutKey} to search these headings`}
								>
									{searchShortcutKey}
								</kbd>
							)}
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
							// Lit when the reader is above the first heading: the row that
							// says where they are standing.
							backgroundColor:
								selectedIndex < 0 ? `${theme.colors.accent}25` : `${theme.colors.accent}15`,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							boxShadow: selectedIndex < 0 ? `inset 2px 0 0 ${theme.colors.accent}` : undefined,
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

							const isActive = index === selectedIndex;
							return (
								<button
									key={`${entry.slug}-${index}`}
									ref={(el) => {
										entryButtonRefs.current[index] = el;
									}}
									onClick={() => {
										setSelectedIndex(index);
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
