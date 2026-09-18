import React, { RefObject } from 'react';
import { BarChart3, Search, X } from 'lucide-react';
import { Spinner } from '../../ui/Spinner';
import { SessionActivityGraph } from '../../SessionActivityGraph';
import type { ActivityEntry } from '../../SessionActivityGraph';
import type { Theme } from '../../../types';
import type { SearchMode } from '../types';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { SearchModeDropdown } from './SearchModeDropdown';
import { usePhoneLayout } from '../../../hooks/ui/useViewportBreakpoint';

interface SessionSearchBarProps {
	showSearchPanel: boolean;
	search: string;
	searchMode: SearchMode;
	isSearching: boolean;
	namedOnly: boolean;
	showAllSessions: boolean;
	searchModeDropdownOpen: boolean;
	searchModeDropdownRef: RefObject<HTMLDivElement>;
	inputRef: RefObject<HTMLInputElement>;
	activityEntries: ActivityEntry[];
	graphLookbackHours: number | null;
	theme: Theme;
	onSearchChange: (value: string) => void;
	onSearchKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
	onToggleSearchPanel: () => void;
	onToggleNamedOnly: (v: boolean) => void;
	onToggleShowAll: (v: boolean) => void;
	onSearchModeDropdownToggle: () => void;
	onSearchModeSelect: (mode: SearchMode) => void;
	onGraphBarClick: (bucketStart: number, bucketEnd: number) => void;
	onLookbackChange: (hours: number | null) => void;
}

export const SessionSearchBar = React.memo(function SessionSearchBar({
	showSearchPanel,
	search,
	searchMode,
	isSearching,
	namedOnly,
	showAllSessions,
	searchModeDropdownOpen,
	searchModeDropdownRef,
	inputRef,
	activityEntries,
	graphLookbackHours,
	theme,
	onSearchChange,
	onSearchKeyDown,
	onToggleSearchPanel,
	onToggleNamedOnly,
	onToggleShowAll,
	onSearchModeDropdownToggle,
	onSearchModeSelect,
	onGraphBarClick,
	onLookbackChange,
}: SessionSearchBarProps) {
	// Phone: the Named / Show All toggles and the mode dropdown drop to a second
	// row so the search box keeps its width. On one row they left it about
	// 60px, and its placeholder was drawn straight through the checkboxes.
	const phone = usePhoneLayout();
	const placeholder =
		searchMode === 'title'
			? 'Search titles...'
			: searchMode === 'user'
				? 'Search your messages...'
				: searchMode === 'assistant'
					? 'Search AI responses...'
					: 'Search all content...';

	return (
		<div className="px-4 py-3 border-b" style={{ borderColor: theme.colors.border }}>
			<div
				className={`flex items-center gap-3 rounded-lg ${phone ? 'flex-wrap px-3 py-2' : 'px-4 py-2.5'}`}
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<button
					onClick={onToggleSearchPanel}
					className="p-1.5 rounded hover:bg-white/10 transition-colors shrink-0"
					style={{ color: theme.colors.textDim }}
					title={
						showSearchPanel
							? 'Show activity graph'
							: `Search sessions (${formatShortcutKeys(['Meta', 'f'])})`
					}
				>
					{showSearchPanel ? <BarChart3 className="w-4 h-4" /> : <Search className="w-4 h-4" />}
				</button>

				<div className="flex-1 min-w-0 flex items-center" style={{ height: '38px' }}>
					{showSearchPanel ? (
						<div className="flex-1 min-w-0 flex items-center gap-2">
							<input
								ref={inputRef}
								className="flex-1 min-w-0 bg-transparent outline-none text-sm"
								placeholder={placeholder}
								style={{ color: theme.colors.textMain }}
								value={search}
								onChange={(e) => onSearchChange(e.target.value)}
								onKeyDown={onSearchKeyDown}
							/>
							{isSearching && <Spinner size={16} color={theme.colors.textDim} />}
							{search && !isSearching && (
								<button
									onClick={() => onSearchChange('')}
									className="p-0.5 rounded hover:bg-white/10"
									style={{ color: theme.colors.textDim }}
								>
									<X className="w-3 h-3" />
								</button>
							)}
						</div>
					) : (
						<SessionActivityGraph
							entries={activityEntries}
							theme={theme}
							onBarClick={onGraphBarClick}
							lookbackHours={graphLookbackHours}
							onLookbackChange={onLookbackChange}
						/>
					)}
				</div>

				<div
					className={phone ? 'basis-full flex items-center justify-between gap-3' : 'contents'}
					data-testid="session-search-filters"
				>
					<label
						className="flex items-center gap-1.5 text-xs cursor-pointer select-none shrink-0"
						style={{ color: namedOnly ? theme.colors.accent : theme.colors.textDim }}
						title="Only show sessions with custom names"
					>
						<input
							type="checkbox"
							checked={namedOnly}
							onChange={(e) => onToggleNamedOnly(e.target.checked)}
							className="w-3.5 h-3.5 rounded cursor-pointer accent-current"
							style={{ accentColor: theme.colors.accent }}
						/>
						<span>Named</span>
					</label>
					<label
						className="flex items-center gap-1.5 text-xs cursor-pointer select-none shrink-0"
						style={{ color: showAllSessions ? theme.colors.accent : theme.colors.textDim }}
						title="Show sessions from all projects"
					>
						<input
							type="checkbox"
							checked={showAllSessions}
							onChange={(e) => onToggleShowAll(e.target.checked)}
							className="w-3.5 h-3.5 rounded cursor-pointer accent-current"
							style={{ accentColor: theme.colors.accent }}
						/>
						<span>Show All</span>
					</label>

					<SearchModeDropdown
						searchMode={searchMode}
						isOpen={searchModeDropdownOpen}
						dropdownRef={searchModeDropdownRef}
						onToggle={onSearchModeDropdownToggle}
						onSelect={onSearchModeSelect}
						theme={theme}
					/>
				</div>
			</div>
		</div>
	);
});
