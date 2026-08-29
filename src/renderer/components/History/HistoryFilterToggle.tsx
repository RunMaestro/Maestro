import { memo } from 'react';
import type { Theme, HistoryEntryType } from '../../types';
import { getPillColor, getEntryIcon } from './historyConstants';
import { ALL_HISTORY_ENTRY_TYPES } from '../../../shared/history';

export interface HistoryFilterToggleProps {
	activeFilters: Set<HistoryEntryType>;
	onToggleFilter: (type: HistoryEntryType) => void;
	theme: Theme;
	/** Which filter types to display. Defaults to all types when omitted. */
	visibleTypes?: readonly HistoryEntryType[];
	/** Hide pill icons to save horizontal space in narrow panels. */
	compact?: boolean;
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
 */
const PILL_TYPE_STYLE = {
	fontSize: '0.6875rem',
	// text-xs carried `line-height: 1rem`; dropping the class drops that too, and
	// an inherited line-height would resize the pill by whatever happened to be
	// above it. Restated so the pill keeps exactly the height it had - only the
	// glyphs shrink, which is the actual complaint.
	lineHeight: '1rem',
	letterSpacing: '0.01em',
} as const;

export const HistoryFilterToggle = memo(function HistoryFilterToggle({
	activeFilters,
	onToggleFilter,
	theme,
	visibleTypes = ALL_TYPES,
	compact = false,
}: HistoryFilterToggleProps) {
	return (
		<div className="flex gap-2 flex-shrink-0">
			{visibleTypes.map((type) => {
				const isActive = activeFilters.has(type);
				const colors = getPillColor(type, theme);
				const Icon = getEntryIcon(type);

				return (
					<button
						key={type}
						onClick={() => onToggleFilter(type)}
						className={`flex items-center gap-1.5 ${compact ? 'px-2' : 'px-3'} py-1.5 rounded-full font-bold uppercase transition-all ${
							isActive ? 'opacity-100' : 'opacity-40'
						}`}
						style={{
							...PILL_TYPE_STYLE,
							backgroundColor: isActive ? colors.bg : 'transparent',
							color: isActive ? colors.text : theme.colors.textDim,
							border: `1px solid ${isActive ? colors.border : theme.colors.border}`,
						}}
					>
						{!compact && <Icon className="w-3 h-3" />}
						{type}
					</button>
				);
			})}
		</div>
	);
});
