import { memo } from 'react';
import type { Theme, HistoryEntryType } from '../../types';
import { getPillColor, getEntryIcon } from './historyConstants';

export interface HistoryFilterToggleProps {
	activeFilters: Set<HistoryEntryType>;
	onToggleFilter: (type: HistoryEntryType) => void;
	theme: Theme;
	/** Which filter types to display. Defaults to all types when omitted. */
	visibleTypes?: HistoryEntryType[];
	/** Hide pill icons to save horizontal space in narrow panels. */
	compact?: boolean;
}

const ALL_TYPES: HistoryEntryType[] = ['AUTO', 'USER', 'CUE'];

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
						className={`flex items-center gap-1.5 ${compact ? 'px-2' : 'px-3'} py-1.5 rounded-full text-xs font-bold uppercase transition-all ${
							isActive ? 'opacity-100' : 'opacity-40'
						}`}
						style={{
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
