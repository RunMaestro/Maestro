import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Theme, HistoryEntryType } from '../../types';
import { getPillColor, getEntryIcon } from './historyConstants';
import { resolvePillDensity } from './historyPillDensity';
import { ALL_HISTORY_ENTRY_TYPES } from '../../../shared/history';
import { useElementWidth, useFreeWidthInFlexRow } from '../../hooks/ui/useElementWidth';
import {
	RIGHT_PANEL_PILL_FONT_SIZE,
	RIGHT_PANEL_PILL_LINE_HEIGHT,
} from '../../constants/rightPanel';

export interface HistoryFilterToggleProps {
	activeFilters: Set<HistoryEntryType>;
	onToggleFilter: (type: HistoryEntryType) => void;
	theme: Theme;
	/** Which filter types to display. Defaults to all types when omitted. */
	visibleTypes?: readonly HistoryEntryType[];
	/**
	 * Hide pill icons to save horizontal space in narrow panels.
	 *
	 * Consulted only before the first measurement lands, and whenever
	 * `fillWidth` is off. It is a static prediction from the panel width; once
	 * the row has measured itself the density ladder decides, because the panel
	 * width alone cannot know the interface font, the zoom level, or how many
	 * pills there are.
	 */
	compact?: boolean;
	/**
	 * Let the row size its pills from the space its toolbar actually has left.
	 *
	 * The row does NOT claim that space - it stays its natural width so the
	 * controls flanking it sit right beside the pills rather than being pushed
	 * out to the panel's edges. It only needs to KNOW the figure, which it reads
	 * from its parent (see `useFreeWidthInFlexRow`). It is still allowed to
	 * shrink, so a squeeze the ladder has not caught up with clips the pills
	 * instead of pushing a neighbour off screen.
	 *
	 * Opt-in, because a surface that sits beside something already consuming the
	 * leftover width (the Director's Notes activity graph) has no free figure to
	 * read and should render at full size.
	 */
	fillWidth?: boolean;
}

const ALL_TYPES: readonly HistoryEntryType[] = ALL_HISTORY_ENTRY_TYPES;

/**
 * Type scale for the pills, one step below Tailwind's `text-xs`.
 *
 * `text-xs` (0.75rem) was tuned when the root font was always 14px monospace.
 * The root is now the interface font size, which under the Default typography
 * preset is a proportional face at 15px - so these grew on both axes at once:
 * a bigger root, and a face whose uppercase glyphs are far wider per em than a
 * monospace one (Roboto Mono is a flat 0.6em per character; Inter's capitals
 * average nearer 0.7em). Uppercase bold has no ascender/descender variation to
 * break up its mass either, so the pills ended up reading as a headline in a
 * row of secondary chrome.
 *
 * Deliberately in `rem`, not a pixel literal: these still have to scale with
 * Cmd+= like everything else. Only the STEP changes, so the pills sit below the
 * surrounding controls at every zoom level instead of only at the old default.
 * The slight negative tracking is what uppercase at small sizes wants once the
 * face is proportional - monospace supplied that spacing for free.
 *
 * This is the BASE rung. Narrow panels step down from here - see
 * `historyPillDensity.ts`.
 */
const PILL_TYPE_STYLE = {
	// Deliberately NOT the tab labels' size. These are controls that label the
	// rows beneath them, so they sit below their own content; the tabs above are
	// the panel's heading and sit above theirs. See rightPanel.ts.
	fontSize: RIGHT_PANEL_PILL_FONT_SIZE,
	lineHeight: RIGHT_PANEL_PILL_LINE_HEIGHT,
	letterSpacing: '0.01em',
} as const;

export const HistoryFilterToggle = memo(function HistoryFilterToggle({
	activeFilters,
	onToggleFilter,
	theme,
	visibleTypes = ALL_TYPES,
	compact = false,
	fillWidth = false,
}: HistoryFilterToggleProps) {
	const rowRef = useRef<HTMLDivElement>(null);
	const mirrorRef = useRef<HTMLDivElement>(null);
	// Read from the PARENT, never from the row. The row's own width is the thing
	// being decided here, so measuring it to choose it would be circular.
	const availableWidth = useFreeWidthInFlexRow(rowRef, fillWidth);
	const labelsWidth = useElementWidth(mirrorRef, fillWidth);

	// Read alongside the labels, because the two move together: a change to the
	// interface font or the Cmd+= zoom changes the root size and resizes the
	// mirror, so the mirror's ResizeObserver is the signal that this needs
	// re-reading.
	const [remPx, setRemPx] = useState(16);
	useLayoutEffect(() => {
		const px = parseFloat(getComputedStyle(document.documentElement).fontSize);
		if (Number.isFinite(px) && px > 0) setRemPx(px);
	}, [labelsWidth]);

	const density = useMemo(
		() =>
			resolvePillDensity({
				availableWidth,
				labelsWidth,
				count: visibleTypes.length,
				remPx,
				compact,
				enabled: fillWidth,
			}),
		[availableWidth, labelsWidth, visibleTypes.length, remPx, compact, fillWidth]
	);

	return (
		<div
			ref={rowRef}
			data-testid="history-filter-toggle"
			className={
				fillWidth
					? // Natural width, so the toolbar's `justify-center` gathers the
						// pills and the controls flanking them into one centred group
						// instead of spreading them to the panel's two edges.
						//
						// `min-w-0` plus the default flex-shrink is the guarantee behind
						// that: a squeeze the ladder has not caught up with shrinks THIS
						// row and clips a pill, rather than pushing the search and help
						// buttons out past the panel. Losing the edge of a pill is
						// survivable; losing a control is not.
						'relative flex gap-2 min-w-0 justify-center overflow-hidden'
					: 'relative flex gap-2 flex-shrink-0'
			}
		>
			{fillWidth && (
				// Measurement mirror: every label at the base size, out of flow and
				// invisible, so its width is a property of the FONT rather than of the
				// rung currently rendered. Measuring the live pills instead would feed
				// each choice back into the next one and oscillate.
				<div
					ref={mirrorRef}
					aria-hidden="true"
					data-testid="history-filter-pill-mirror"
					className="absolute left-0 top-0 whitespace-nowrap font-bold uppercase pointer-events-none"
					style={{ ...PILL_TYPE_STYLE, visibility: 'hidden' }}
				>
					{visibleTypes.join('')}
				</div>
			)}
			{visibleTypes.map((type) => {
				const isActive = activeFilters.has(type);
				const colors = getPillColor(type, theme);
				const Icon = getEntryIcon(type);

				return (
					<button
						key={type}
						onClick={() => onToggleFilter(type)}
						className={`flex items-center gap-1.5 py-1.5 rounded-full font-bold uppercase whitespace-nowrap transition-all ${
							isActive ? 'opacity-100' : 'opacity-40'
						}`}
						style={{
							...PILL_TYPE_STYLE,
							fontSize: `${density.fontRem}rem`,
							paddingLeft: `${density.padXRem}rem`,
							paddingRight: `${density.padXRem}rem`,
							backgroundColor: isActive ? colors.bg : 'transparent',
							color: isActive ? colors.text : theme.colors.textDim,
							border: `1px solid ${isActive ? colors.border : theme.colors.border}`,
						}}
					>
						{density.icon && <Icon className="w-3 h-3" />}
						{type}
					</button>
				);
			})}
		</div>
	);
});
