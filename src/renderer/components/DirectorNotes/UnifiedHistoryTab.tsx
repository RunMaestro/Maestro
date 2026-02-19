import React, {
	useState,
	useEffect,
	useCallback,
	useMemo,
	useRef,
	forwardRef,
	useImperativeHandle,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Loader2, Search, X } from 'lucide-react';
import type { Theme, HistoryEntry, HistoryEntryType } from '../../types';
import type { FileNode } from '../../types/fileTree';
import {
	ActivityGraph,
	HistoryEntryItem,
	HistoryFilterToggle,
	HistoryStatsBar,
	ESTIMATED_ROW_HEIGHT,
	ESTIMATED_ROW_HEIGHT_SIMPLE,
} from '../History';
import type { HistoryStats } from '../History';
import { HistoryDetailModal } from '../HistoryDetailModal';
import { useListNavigation } from '../../hooks';
import type { TabFocusHandle } from './OverviewTab';

/** Page size for progressive loading */
const PAGE_SIZE = 100;

/** Distance from bottom (in px) at which to trigger loading the next page */
const SCROLL_LOAD_THRESHOLD = 500;

interface UnifiedHistoryEntry extends HistoryEntry {
	agentName?: string;
	sourceSessionId: string;
}

interface UnifiedHistoryTabProps {
	theme: Theme;
	/** Navigate to a session tab — receives (sourceSessionId, agentSessionId) */
	onResumeSession?: (sourceSessionId: string, agentSessionId: string) => void;
	fileTree?: FileNode[];
	onFileClick?: (path: string) => void;
}

/** Convert lookbackHours to lookbackDays for the IPC call. null => 0 (all time). */
function lookbackHoursToDays(hours: number | null): number {
	if (hours === null) return 0;
	return Math.ceil(hours / 24);
}

export const UnifiedHistoryTab = forwardRef<TabFocusHandle, UnifiedHistoryTabProps>(
	function UnifiedHistoryTab({ theme, onResumeSession, fileTree, onFileClick }, ref) {
		const [entries, setEntries] = useState<UnifiedHistoryEntry[]>([]);
		const [isLoading, setIsLoading] = useState(true);
		const [isLoadingMore, setIsLoadingMore] = useState(false);
		const [hasMore, setHasMore] = useState(true);
		const [totalEntries, setTotalEntries] = useState(0);
		const [activeFilters, setActiveFilters] = useState<Set<HistoryEntryType>>(
			new Set(['AUTO', 'USER'])
		);
		const [detailModalEntry, setDetailModalEntry] = useState<HistoryEntry | null>(null);
		const [lookbackHours, setLookbackHours] = useState<number | null>(null); // null = all time
		const [historyStats, setHistoryStats] = useState<HistoryStats | null>(null);
		const [searchExpanded, setSearchExpanded] = useState(false);
		const [searchQuery, setSearchQuery] = useState('');

		// Stable snapshot of entries for the graph — only updated on fresh loads, not scroll-appends
		const [graphEntries, setGraphEntries] = useState<UnifiedHistoryEntry[]>([]);

		const listRef = useRef<HTMLDivElement>(null);
		const loadingMoreRef = useRef(false); // Guard against concurrent loads
		const searchInputRef = useRef<HTMLInputElement>(null);

		useImperativeHandle(
			ref,
			() => ({
				focus: () => listRef.current?.focus(),
				onEscape: () => {
					if (searchExpanded) {
						setSearchExpanded(false);
						setSearchQuery('');
						listRef.current?.focus();
						return true;
					}
					return false;
				},
			}),
			[searchExpanded]
		);

		// Load a page of unified history
		const loadPage = useCallback(
			async (offset: number, append: boolean, lookback: number | null) => {
				if (append) {
					setIsLoadingMore(true);
				} else {
					setIsLoading(true);
				}
				try {
					const result = await window.maestro.directorNotes.getUnifiedHistory({
						lookbackDays: lookbackHoursToDays(lookback),
						filter: null,
						limit: PAGE_SIZE,
						offset,
					});
					const newEntries = result.entries as UnifiedHistoryEntry[];
					if (append) {
						setEntries((prev) => [...prev, ...newEntries]);
					} else {
						setEntries(newEntries);
						// Update graph snapshot only on fresh loads
						setGraphEntries(newEntries);
					}
					setHasMore(result.hasMore);
					setTotalEntries(result.total);
					// Capture stats on every load (they cover the full dataset, not just the page)
					if (result.stats) {
						setHistoryStats(result.stats);
					}
				} catch (error) {
					console.error('Failed to load unified history:', error);
					if (!append) {
						setEntries([]);
						setGraphEntries([]);
					}
					setHasMore(false);
				} finally {
					setIsLoading(false);
					setIsLoadingMore(false);
					loadingMoreRef.current = false;
				}
			},
			[]
		);

		// Initial load
		useEffect(() => {
			loadPage(0, false, lookbackHours);
		}, [loadPage, lookbackHours]);

		// Auto-focus the list after initial loading completes
		useEffect(() => {
			if (!isLoading) {
				listRef.current?.focus();
			}
		}, [isLoading]);

		// Handle lookback change from graph right-click menu
		const handleLookbackChange = useCallback((hours: number | null) => {
			setLookbackHours(hours);
			// Reset scroll position and entries — useEffect will trigger a fresh load
			setEntries([]);
			setGraphEntries([]);
			setHasMore(true);
			setTotalEntries(0);
			setHistoryStats(null);
		}, []);

		// Load next page when scrolling near the bottom
		const handleScroll = useCallback(() => {
			if (!hasMore || loadingMoreRef.current || isLoading) return;

			const el = listRef.current;
			if (!el) return;

			const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_LOAD_THRESHOLD;
			if (nearBottom) {
				loadingMoreRef.current = true;
				loadPage(entries.length, true, lookbackHours);
			}
		}, [hasMore, isLoading, entries.length, loadPage, lookbackHours]);

		// Filter entries client-side
		const filteredEntries = useMemo(() => {
			return entries.filter((entry) => {
				if (!activeFilters.has(entry.type)) return false;
				if (searchQuery) {
					const search = searchQuery.toLowerCase();
					if (
						!entry.summary?.toLowerCase().includes(search) &&
						!entry.agentName?.toLowerCase().includes(search)
					) {
						return false;
					}
				}
				return true;
			});
		}, [entries, activeFilters, searchQuery]);

		// Toggle filter
		const toggleFilter = useCallback((type: HistoryEntryType) => {
			setActiveFilters((prev) => {
				const next = new Set(prev);
				if (next.has(type)) next.delete(type);
				else next.add(type);
				return next;
			});
		}, []);

		// Virtualization
		const estimateSize = useCallback(
			(index: number) => {
				const entry = filteredEntries[index];
				if (!entry) return ESTIMATED_ROW_HEIGHT;
				const hasFooter =
					entry.elapsedTimeMs !== undefined ||
					(entry.usageStats && entry.usageStats.totalCostUsd > 0);
				return hasFooter ? ESTIMATED_ROW_HEIGHT : ESTIMATED_ROW_HEIGHT_SIMPLE;
			},
			[filteredEntries]
		);

		const virtualizer = useVirtualizer({
			count: filteredEntries.length,
			getScrollElement: () => listRef.current,
			estimateSize,
			overscan: 5,
			gap: 12,
			initialRect: { width: 300, height: 600 },
		});

		// List navigation
		const {
			selectedIndex,
			setSelectedIndex,
			handleKeyDown: listNavKeyDown,
		} = useListNavigation({
			listLength: filteredEntries.length,
			onSelect: (index) => {
				if (index >= 0 && index < filteredEntries.length) {
					setDetailModalEntry(filteredEntries[index]);
				}
			},
			initialIndex: -1,
		});

		// Scroll selected into view
		useEffect(() => {
			if (selectedIndex >= 0) {
				virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
			}
		}, [selectedIndex, virtualizer]);

		// Search toggle
		const openSearch = useCallback(() => {
			setSearchExpanded(true);
			requestAnimationFrame(() => searchInputRef.current?.focus());
		}, []);

		const closeSearch = useCallback(() => {
			setSearchExpanded(false);
			setSearchQuery('');
			listRef.current?.focus();
		}, []);

		const handleKeyDown = useCallback(
			(e: React.KeyboardEvent) => {
				// Cmd/Ctrl+F to open search
				if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !e.shiftKey) {
					e.preventDefault();
					e.stopPropagation();
					if (searchExpanded) {
						searchInputRef.current?.focus();
						searchInputRef.current?.select();
					} else {
						openSearch();
					}
					return;
				}
				listNavKeyDown(e);
			},
			[listNavKeyDown, searchExpanded, openSearch]
		);

		// Navigate to a session tab — looks up sourceSessionId from the unified entry
		const handleOpenSessionAsTab = useCallback(
			(agentSessionId: string) => {
				if (!onResumeSession) return;
				const entry = entries.find((e) => e.agentSessionId === agentSessionId) as
					| UnifiedHistoryEntry
					| undefined;
				if (entry) {
					onResumeSession(entry.sourceSessionId, agentSessionId);
				}
			},
			[onResumeSession, entries]
		);

		// Navigate to a session from the detail modal
		const handleDetailResumeSession = useCallback(
			(agentSessionId: string) => {
				if (!onResumeSession || !detailModalEntry) return;
				const entry = detailModalEntry as UnifiedHistoryEntry;
				onResumeSession(entry.sourceSessionId, agentSessionId);
			},
			[onResumeSession, detailModalEntry]
		);

		const openDetailModal = useCallback(
			(entry: HistoryEntry, index: number) => {
				setSelectedIndex(index);
				setDetailModalEntry(entry);
			},
			[setSelectedIndex]
		);

		const closeDetailModal = useCallback(() => {
			setDetailModalEntry(null);
			listRef.current?.focus();
		}, []);

		// Update a history entry (e.g. toggling validated) via the per-session history API
		const handleUpdateEntry = useCallback(
			async (entryId: string, updates: { validated?: boolean }) => {
				// Find the entry to get its sourceSessionId for the per-session lookup
				const target = entries.find((e) => e.id === entryId);
				if (!target) return false;
				const success = await window.maestro.history.update(
					entryId,
					updates,
					target.sourceSessionId
				);
				if (success) {
					setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e)));
					setDetailModalEntry((prev) =>
						prev && prev.id === entryId ? { ...prev, ...updates } : prev
					);
				}
				return success;
			},
			[entries]
		);

		return (
			<div className="flex flex-col h-full p-4">
				{/* Search bar (above filter row) */}
				{searchExpanded && (
					<div
						className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-full border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.accent + '40',
						}}
					>
						<Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: theme.colors.accent }} />
						<input
							ref={searchInputRef}
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Filter by summary or agent name..."
							className="flex-1 bg-transparent outline-none text-xs"
							style={{ color: theme.colors.textMain }}
							autoFocus
						/>
						{searchQuery && (
							<span
								className="text-[10px] font-mono whitespace-nowrap flex-shrink-0"
								style={{ color: theme.colors.textDim }}
							>
								{filteredEntries.length}
							</span>
						)}
						<button
							onClick={closeSearch}
							className="p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
							title="Close search (Esc)"
						>
							<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
						</button>
					</div>
				)}

				{/* Header: Search icon + Filters + Activity Graph */}
				<div className="flex items-start gap-3 mb-4">
					<button
						onClick={openSearch}
						className="flex-shrink-0 p-1.5 rounded-full transition-colors hover:bg-white/10"
						title="Search entries (⌘F)"
						style={{ color: searchExpanded ? theme.colors.accent : theme.colors.textDim }}
					>
						<Search className="w-4 h-4" />
					</button>
					<HistoryFilterToggle
						activeFilters={activeFilters}
						onToggleFilter={toggleFilter}
						theme={theme}
					/>
					<ActivityGraph
						entries={graphEntries}
						theme={theme}
						lookbackHours={lookbackHours}
						onLookbackChange={handleLookbackChange}
						onBarClick={(start, end) => {
							// Find first entry in range and select it
							const idx = filteredEntries.findIndex(
								(e) => e.timestamp >= start && e.timestamp < end
							);
							if (idx >= 0) {
								setSelectedIndex(idx);
								virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
							}
						}}
					/>
					{/* Entry count badge */}
					{!isLoading && totalEntries > 0 && (
						<span
							className="text-[10px] font-mono whitespace-nowrap flex-shrink-0 mt-1"
							style={{ color: theme.colors.textDim }}
						>
							{entries.length < totalEntries
								? `${entries.length}/${totalEntries}`
								: `${totalEntries}`}
						</span>
					)}
				</div>

				{/* Entry list with infinite scroll */}
				<div
					ref={listRef}
					className="flex-1 overflow-y-auto outline-none scrollbar-thin"
					tabIndex={0}
					onKeyDown={handleKeyDown}
					onScroll={handleScroll}
				>
					{/* Stats bar — scrolls with entries */}
					{!isLoading && historyStats && historyStats.totalCount > 0 && (
						<HistoryStatsBar stats={historyStats} theme={theme} />
					)}

					{isLoading ? (
						<div className="text-center py-8 text-xs" style={{ color: theme.colors.textDim }}>
							Loading history...
						</div>
					) : filteredEntries.length === 0 ? (
						<div className="text-center py-8 text-xs" style={{ color: theme.colors.textDim }}>
							{searchQuery
								? `No entries matching "${searchQuery}".`
								: entries.length === 0
									? lookbackHours !== null
										? 'No history entries in this time range. Try expanding the lookback period.'
										: 'No history entries found across any agents.'
									: 'No entries match the current filters.'}
						</div>
					) : (
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								width: '100%',
								position: 'relative',
							}}
						>
							{virtualizer.getVirtualItems().map((virtualItem) => {
								const entry = filteredEntries[virtualItem.index];
								if (!entry) return null;

								return (
									<div
										key={entry.id || `entry-${virtualItem.index}`}
										data-index={virtualItem.index}
										ref={virtualizer.measureElement}
										style={{
											position: 'absolute',
											top: 0,
											left: 0,
											width: '100%',
											transform: `translateY(${virtualItem.start}px)`,
										}}
									>
										<HistoryEntryItem
											entry={entry}
											index={virtualItem.index}
											isSelected={virtualItem.index === selectedIndex}
											theme={theme}
											onOpenDetailModal={openDetailModal}
											onOpenSessionAsTab={onResumeSession ? handleOpenSessionAsTab : undefined}
											showAgentName
										/>
									</div>
								);
							})}
						</div>
					)}

					{/* Loading more indicator */}
					{isLoadingMore && (
						<div className="flex items-center justify-center py-4 gap-2">
							<Loader2
								className="w-3.5 h-3.5 animate-spin"
								style={{ color: theme.colors.accent }}
							/>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Loading more...
							</span>
						</div>
					)}
				</div>

				{/* Detail Modal */}
				{detailModalEntry && (
					<HistoryDetailModal
						theme={theme}
						entry={detailModalEntry}
						onClose={closeDetailModal}
						onResumeSession={onResumeSession ? handleDetailResumeSession : undefined}
						onUpdate={handleUpdateEntry}
						filteredEntries={filteredEntries}
						currentIndex={selectedIndex}
						onNavigate={(entry, index) => {
							setSelectedIndex(index);
							setDetailModalEntry(entry);
							virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
						}}
						fileTree={fileTree}
						onFileClick={onFileClick}
					/>
				)}
			</div>
		);
	}
);
