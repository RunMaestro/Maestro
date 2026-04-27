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
import { Search, X, ArrowUp } from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import type { Theme, HistoryEntry, HistoryEntryType } from '../../types';
import type { FileNode } from '../../types/fileTree';
import {
	ActivityGraph,
	HistoryEntryItem,
	HistoryFilterToggle,
	HistoryStatsBar,
	ESTIMATED_ROW_HEIGHT,
	ESTIMATED_ROW_HEIGHT_SIMPLE,
	LOOKBACK_OPTIONS,
} from '../History';
import type { GraphBucket } from '../History/ActivityGraph';
import type { HistoryStats } from '../History';
import { HistoryDetailModal } from '../HistoryDetailModal';
import { useListNavigation, useSettings, useThrottledCallback } from '../../hooks';
import { useHistoryPagination } from '../../hooks/history/useHistoryPagination';
import type { PaginatedPage } from '../../hooks/history/useHistoryPagination';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { TabFocusHandle } from './OverviewTab';
import { logger } from '../../utils/logger';

/** Page size for progressive loading */
const PAGE_SIZE = 100;

/** Distance from bottom (in px) at which to trigger loading the next page */
const SCROLL_LOAD_THRESHOLD = 500;

/**
 * Resolve the bucket count for a given lookback selection. Each lookback
 * option carries its own preferred resolution (24 for short windows, 28
 * for "1 week", 30 for "1 month", etc.).
 */
function bucketCountForLookback(hours: number | null): number {
	const config = LOOKBACK_OPTIONS.find((o) => o.hours === hours);
	return config?.bucketCount ?? 24;
}

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

/** Find the smallest LOOKBACK_OPTIONS entry that covers the given number of days. 0 => null (All time). */
function daysToLookbackHours(days: number): number | null {
	if (days <= 0) return null; // 0 encodes "All time"
	const targetHours = days * 24;
	for (const option of LOOKBACK_OPTIONS) {
		if (option.hours !== null && option.hours >= targetHours) return option.hours;
	}
	return null; // all options too small — fall back to "All time"
}

export const UnifiedHistoryTab = forwardRef<TabFocusHandle, UnifiedHistoryTabProps>(
	function UnifiedHistoryTab({ theme, onResumeSession, fileTree, onFileClick }, ref) {
		const { directorNotesSettings } = useSettings();
		const maestroCueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue);
		const visibleTypes: HistoryEntryType[] = maestroCueEnabled
			? ['AUTO', 'USER', 'CUE']
			: ['AUTO', 'USER'];

		const [activeFilters, setActiveFilters] = useState<Set<HistoryEntryType>>(
			() => new Set(maestroCueEnabled ? ['AUTO', 'USER', 'CUE'] : ['AUTO', 'USER'])
		);
		const [detailModalEntry, setDetailModalEntry] = useState<HistoryEntry | null>(null);
		const [lookbackHours, setLookbackHours] = useState<number | null>(() =>
			daysToLookbackHours(directorNotesSettings.defaultLookbackDays)
		);
		const [historyStats, setHistoryStats] = useState<HistoryStats | null>(null);
		const [searchExpanded, setSearchExpanded] = useState(false);
		const [searchQuery, setSearchQuery] = useState('');

		// Pre-computed graph buckets from backend (covers all entries in
		// the lookback window — server-cached). Independent from the
		// paginated entry list below.
		const [graphBuckets, setGraphBuckets] = useState<GraphBucket[] | undefined>(undefined);
		const [graphRange, setGraphRange] = useState<{ start: number; end: number } | undefined>(
			undefined
		);
		// Viewport range for the red scroll indicator on the activity graph
		const [graphViewportRange, setGraphViewportRange] = useState<
			{ start: number; end: number } | undefined
		>(undefined);
		const graphRefreshScheduled = useRef(false);

		const listRef = useRef<HTMLDivElement>(null);
		const searchInputRef = useRef<HTMLInputElement>(null);

		// Page loader for the shared pagination hook. Memoized on
		// `lookbackHours` so changing the lookback resets the window
		// (the hook re-runs its initial load when this identity changes).
		// Side effect: keeps `historyStats` in sync from the same IPC
		// response so we don't fan out to a second call.
		const loadPage = useCallback(
			async (offset: number, limit: number): Promise<PaginatedPage<UnifiedHistoryEntry>> => {
				const result = await window.maestro.directorNotes.getUnifiedHistory({
					lookbackDays: lookbackHoursToDays(lookbackHours),
					filter: null,
					limit,
					offset,
				});
				if (result.stats) {
					setHistoryStats(result.stats);
				}
				return {
					entries: result.entries as UnifiedHistoryEntry[],
					hasMore: result.hasMore,
					total: result.total,
				};
			},
			[lookbackHours]
		);

		const getEntryId = useCallback((entry: UnifiedHistoryEntry) => entry.id, []);

		const {
			entries,
			startOffset,
			totalCount: totalEntries,
			isLoading,
			isLoadingMore,
			isJumping,
			isAtTop,
			loadMoreOlder,
			jumpToOffset,
			jumpToTop,
			prependLiveEntry,
			mutateEntries,
		} = useHistoryPagination<UnifiedHistoryEntry>({
			pageSize: PAGE_SIZE,
			loadPage,
			getEntryId,
		});

		// --- Live agent activity from Zustand (primitive selectors for efficient re-renders) ---
		const activeAgentCount = useSessionStore(
			(s) => s.sessions.filter((sess) => sess.state === 'busy').length
		);
		const totalQueuedItems = useSessionStore((s) =>
			s.sessions.reduce((sum, sess) => sum + (sess.executionQueue?.length || 0), 0)
		);

		// Merge live counts into history stats for the stats bar
		const enrichedStats = useMemo<HistoryStats | null>(() => {
			if (!historyStats) return null;
			return {
				...historyStats,
				activeAgentCount,
				totalQueuedItems,
			};
		}, [historyStats, activeAgentCount, totalQueuedItems]);

		// --- Real-time streaming of new history entries ---
		const pendingEntriesRef = useRef<UnifiedHistoryEntry[]>([]);
		const rafIdRef = useRef<number | null>(null);

		// Stable ref for session names — avoids making the streaming effect depend on session state
		const sessionsRef = useRef(useSessionStore.getState().sessions);
		useEffect(() => {
			return useSessionStore.subscribe((s) => {
				sessionsRef.current = s.sessions;
			});
		}, []);

		useEffect(() => {
			const flushPending = () => {
				rafIdRef.current = null;
				const batch = pendingEntriesRef.current;
				if (batch.length === 0) return;
				pendingEntriesRef.current = [];

				// Dedupe within the batch itself
				const seen = new Set<string>();
				const uniqueBatch: UnifiedHistoryEntry[] = [];
				for (const entry of batch) {
					if (!seen.has(entry.id)) {
						seen.add(entry.id);
						uniqueBatch.push(entry);
					}
				}

				// Per-type tally of what we'll attempt to insert; needed
				// for the stats bump regardless of whether the prepend
				// actually lands (it only lands when the window is at top).
				let newAuto = 0;
				let newUser = 0;
				let prepended = 0;
				for (const entry of uniqueBatch) {
					if (entry.type === 'AUTO') newAuto++;
					else if (entry.type === 'USER') newUser++;
					if (prependLiveEntry(entry)) prepended++;
				}

				if (newAuto > 0 || newUser > 0) {
					setHistoryStats((prevStats) => {
						if (!prevStats) return prevStats;
						return {
							...prevStats,
							autoCount: prevStats.autoCount + newAuto,
							userCount: prevStats.userCount + newUser,
							totalCount: prevStats.totalCount + newAuto + newUser,
						};
					});
				}

				// Schedule a graph refetch when entries actually landed in
				// the visible window. The server cache is keyed by file
				// mtime+size so any append invalidates it; one coalesced
				// refresh per animation frame keeps the graph fresh
				// without per-entry IPC churn.
				if (prepended > 0 && !graphRefreshScheduled.current) {
					graphRefreshScheduled.current = true;
					requestAnimationFrame(() => {
						graphRefreshScheduled.current = false;
						void refreshGraphData();
					});
				}
			};

			const cleanup = window.maestro.directorNotes.onHistoryEntryAdded(
				(rawEntry, sourceSessionId) => {
					// Check if entry is within lookback window
					if (lookbackHours !== null) {
						const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
						if (rawEntry.timestamp < cutoff) return;
					}

					const enriched = {
						...rawEntry,
						sourceSessionId,
						agentName: sessionsRef.current.find((s) => s.id === sourceSessionId)?.name,
					} as UnifiedHistoryEntry;

					pendingEntriesRef.current.push(enriched);

					// Coalesce into a single frame update
					if (rafIdRef.current === null) {
						rafIdRef.current = requestAnimationFrame(flushPending);
					}
				}
			);

			return () => {
				cleanup();
				if (rafIdRef.current !== null) {
					cancelAnimationFrame(rafIdRef.current);
				}
				pendingEntriesRef.current = [];
			};
		}, [lookbackHours, prependLiveEntry]);

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

		// Fetch the graph aggregate for the current lookback. Cached
		// server-side keyed by (bucketCount, lookback, composite mtime+size
		// of every session history file). Decoupled from `loadPage` so the
		// graph refreshes independently of pagination.
		const refreshGraphData = useCallback(async () => {
			try {
				const data = await window.maestro.directorNotes.getGraphData(
					bucketCountForLookback(lookbackHours),
					lookbackHours
				);
				setGraphBuckets(data.buckets);
				setGraphRange({ start: data.earliestTimestamp, end: data.latestTimestamp });
			} catch (error) {
				logger.error('Failed to load unified graph data:', undefined, error);
				setGraphBuckets(undefined);
				setGraphRange(undefined);
			}
		}, [lookbackHours]);

		useEffect(() => {
			refreshGraphData();
		}, [refreshGraphData]);

		// Auto-focus the list after initial loading completes
		useEffect(() => {
			if (!isLoading) {
				listRef.current?.focus();
			}
		}, [isLoading]);

		// Lookback change — the hook reloads the entry list automatically
		// when its `loadPage` identity changes (loadPage is memoized on
		// `lookbackHours`). We just clear stats so the bar reflects the new
		// scope until the next response lands.
		const handleLookbackChange = useCallback((hours: number | null) => {
			setLookbackHours(hours);
			setHistoryStats(null);
		}, []);

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

		// Sync activeFilters when cue feature is toggled
		useEffect(() => {
			setActiveFilters((prev) => {
				if (maestroCueEnabled && !prev.has('CUE')) {
					return new Set([...prev, 'CUE']);
				}
				if (!maestroCueEnabled && prev.has('CUE')) {
					const next = new Set(prev);
					next.delete('CUE');
					return next;
				}
				return prev;
			});
		}, [maestroCueEnabled]);

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

		// Scroll handler: pagination + viewport indicator
		const scrollTargetRef = useRef<HTMLDivElement | null>(null);

		const handleScrollInner = useCallback(() => {
			const el = scrollTargetRef.current || listRef.current;

			// Pagination: load next older page when near bottom. The hook
			// guards against concurrent calls and no-ops when there's
			// nothing more to load.
			if (el && !isLoading) {
				const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_LOAD_THRESHOLD;
				if (nearBottom) {
					void loadMoreOlder();
				}
			}

			// Viewport indicator: track which entries are visible
			const visibleItems = virtualizer.getVirtualItems();
			if (visibleItems.length === 0) {
				setGraphViewportRange(undefined);
				return;
			}

			if (
				el &&
				el.scrollTop < 10 &&
				visibleItems[visibleItems.length - 1]?.index >= filteredEntries.length - 1
			) {
				setGraphViewportRange(undefined);
			} else {
				const firstIdx = visibleItems[0]?.index ?? 0;
				const lastIdx = visibleItems[visibleItems.length - 1]?.index ?? 0;
				const topEntry = filteredEntries[firstIdx];
				const bottomEntry = filteredEntries[lastIdx];
				if (topEntry && bottomEntry) {
					setGraphViewportRange({
						start: bottomEntry.timestamp,
						end: topEntry.timestamp,
					});
				}
			}
		}, [isLoading, loadMoreOlder, virtualizer, filteredEntries]);

		// Throttle to ~240fps for smooth indicator movement
		const throttledScrollHandler = useThrottledCallback(handleScrollInner, 4);

		const handleScroll = useCallback(
			(e: React.UIEvent<HTMLDivElement>) => {
				scrollTargetRef.current = e.currentTarget;
				throttledScrollHandler();
			},
			[throttledScrollHandler]
		);

		// Reset viewport indicator when filters or lookback change
		useEffect(() => {
			setGraphViewportRange(undefined);
		}, [activeFilters, searchQuery, lookbackHours]);

		/**
		 * Click-to-jump on the activity graph.
		 *
		 * Fast path: target bucket is in the currently-loaded window →
		 * scroll to it.
		 *
		 * Slow path: ask the server for the offset of the first entry at
		 * (or just before) the bucket's end, then `jumpToOffset` to load
		 * the single page anchored at that target. Memory stays bounded:
		 * we never fill in every page in between.
		 */
		const handleGraphBarClick = useCallback(
			async (bucketStart: number, bucketEnd: number) => {
				const findIdx = (list: UnifiedHistoryEntry[]) =>
					list.findIndex((e) => e.timestamp >= bucketStart && e.timestamp < bucketEnd);

				const idx = findIdx(filteredEntries);
				if (idx >= 0) {
					setSelectedIndex(idx);
					virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
					return;
				}

				try {
					const targetOffset = await window.maestro.directorNotes.getOffsetForTimestamp(
						bucketEnd - 1,
						{ lookbackDays: lookbackHoursToDays(lookbackHours), filter: null }
					);
					await jumpToOffset(targetOffset);
					// After the window slides, the virtualizer's bookkeeping
					// has new indices — let the next render flush before
					// scrolling. Scroll-to-top is the right default; the
					// target lives near it because we anchored the page.
					requestAnimationFrame(() => {
						virtualizer.scrollToIndex(0, { align: 'start', behavior: 'auto' });
					});
				} catch (error) {
					logger.error('Failed to jump to graph bucket:', undefined, error);
				}
			},
			[filteredEntries, lookbackHours, jumpToOffset, setSelectedIndex, virtualizer]
		);

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
					mutateEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e)));
					setDetailModalEntry((prev) =>
						prev && prev.id === entryId ? { ...prev, ...updates } : prev
					);
				}
				return success;
			},
			[entries, mutateEntries]
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
						visibleTypes={visibleTypes}
					/>
					<ActivityGraph
						entries={[]}
						theme={theme}
						lookbackHours={lookbackHours}
						onLookbackChange={handleLookbackChange}
						precomputedBuckets={graphBuckets}
						precomputedRange={graphRange}
						viewportRange={graphViewportRange}
						alwaysShowViewportLabel
						onBarClick={handleGraphBarClick}
					/>
					{/* Entry count badge — shows window position when jumped, total otherwise */}
					{!isLoading && totalEntries > 0 && (
						<span
							className="text-[10px] font-mono whitespace-nowrap flex-shrink-0 mt-1"
							style={{ color: theme.colors.textDim }}
						>
							{!isAtTop
								? `${startOffset + 1}–${startOffset + entries.length}/${totalEntries}`
								: entries.length < totalEntries
									? `${entries.length}/${totalEntries}`
									: `${totalEntries}`}
						</span>
					)}
					{/* Back-to-top affordance — only visible after a jump */}
					{!isAtTop && !isJumping && (
						<button
							onClick={() => void jumpToTop()}
							className="flex-shrink-0 p-1.5 rounded-full transition-colors hover:bg-white/10 mt-0.5"
							title="Back to most recent"
							style={{ color: theme.colors.accent }}
						>
							<ArrowUp className="w-3.5 h-3.5" />
						</button>
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
					{!isLoading && enrichedStats && enrichedStats.totalCount > 0 && (
						<HistoryStatsBar stats={enrichedStats} theme={theme} />
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

					{/* Loading more / jump-in-flight indicator */}
					{(isLoadingMore || isJumping) && (
						<div className="flex items-center justify-center py-4 gap-2">
							<Spinner size={14} color={theme.colors.accent} />
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{isJumping ? 'Jumping to selected period...' : 'Loading more...'}
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
