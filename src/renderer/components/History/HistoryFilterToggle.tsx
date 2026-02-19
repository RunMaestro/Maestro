import { memo } from 'react';
import { Bot, User } from 'lucide-react';
import type { Theme, HistoryEntryType } from '../../types';

export interface HistoryFilterToggleProps {
	activeFilters: Set<HistoryEntryType>;
	onToggleFilter: (type: HistoryEntryType) => void;
	theme: Theme;
}

// Get pill color based on type
const getPillColor = (type: HistoryEntryType, theme: Theme) => {
	switch (type) {
		case 'AUTO':
			return {
				bg: theme.colors.warning + '20',
				text: theme.colors.warning,
				border: theme.colors.warning + '40',
			};
		case 'USER':
			return {
				bg: theme.colors.accent + '20',
				text: theme.colors.accent,
				border: theme.colors.accent + '40',
			};
		default:
			return {
				bg: theme.colors.bgActivity,
				text: theme.colors.textDim,
				border: theme.colors.border,
			};
	}
};

// Get icon for entry type
const getEntryIcon = (type: HistoryEntryType) => {
	switch (type) {
		case 'AUTO':
			return Bot;
		case 'USER':
			return User;
		default:
			return Bot;
	}
};

export const HistoryFilterToggle = memo(function HistoryFilterToggle({
	activeFilters,
	onToggleFilter,
	theme,
}: HistoryFilterToggleProps) {
	return (
		<div className="flex gap-2 flex-shrink-0">
			{(['AUTO', 'USER'] as HistoryEntryType[]).map((type) => {
				const isActive = activeFilters.has(type);
				const colors = getPillColor(type, theme);
				const Icon = getEntryIcon(type);

				return (
					<button
						key={type}
						onClick={() => onToggleFilter(type)}
						className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase transition-all ${
							isActive ? 'opacity-100' : 'opacity-40'
						}`}
						style={{
							backgroundColor: isActive ? colors.bg : 'transparent',
							color: isActive ? colors.text : theme.colors.textDim,
							border: `1px solid ${isActive ? colors.border : theme.colors.border}`,
						}}
					>
						<Icon className="w-3 h-3" />
						{type}
					</button>
				);
			})}
		</div>
	);
});
