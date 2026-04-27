import React, {
	useState,
	useEffect,
	useRef,
	useCallback,
	useImperativeHandle,
	forwardRef,
	useMemo,
} from 'react';
import { HelpCircle, Search } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Session, Theme, HistoryEntry, HistoryEntryType } from '../types';
import type { FileNode } from '../types/fileTree';
import { HistoryDetailModal } from './HistoryDetailModal';
import { HistoryHelpModal } from './HistoryHelpModal';
import { useThrottledCallback, useListNavigation } from '../hooks';
import { useHistoryPagination } from '../hooks/history/useHistoryPagination';
import type { PaginatedPage } from '../hooks/history/useHistoryPagination';
import {
	ActivityGraph,
	HistoryEntryItem,
	HistoryFilterToggle,
	ESTIMATED_ROW_HEIGHT,
	ESTIMATED_ROW_HEIGHT_SIMPLE,
	LOOKBACK_OPTIONS,
} from './History';
import type { GraphBucket } from './History/ActivityGraph';
import { useUIStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { buildSharedHistoryContext } from '../utils/sessionHelpers';
import { logger } from '../utils/logger';

interface HistoryPanelProps {
	session: Session;
	theme: Theme;
	onJumpToAgentSession?: (agentSessionId: string) => void;
	onResumeSession?: (agentSessionId: string) => void;
	onOpenSessionAsTab?: (agentSessionId: string, projectPath?: string) => void;
	onOpenAboutModal?: () => void; // For opening About/achievements panel from history entries
	// File linking props for history detail modal
	fileTree?: FileNode[];
	onFileClick?: (path: string) => void;
}

export interface HistoryPanelHandle {
	focus: () => void;
	refreshHistory: () => void;
}

// Module-level storage for scroll positions (persists across session switches)
const scrollPositionCache = new Map<string, number>();

/** Page size for the entry list. Matches UnifiedHistoryTab. */
const PAGE_SIZE = 100;

/** Distance from bottom (px) at which to trigger loading the next page. */
const SCROLL_LOAD_THRESHOLD = 500;

/**
 * Resolve the bucket count for a given lookback selection. The bucket
 * counts come from `LOOKBACK_OPTIONS` so each window gets an appropriate
 * resolution (e.g. 24 buckets for "24 hours" and "All time", 28 for "1
 * week", etc.).
 */
function bucketCountForLookback(hours: number | null): number {
	const config = LOOKBACK_OPTIONS.find((o) => o.hours === hours);
	return config?.bucketCount ?? 24;
}

export const HistoryPanel = React.memo(
	forwardRef<HistoryPanelHandle, HistoryPanelProps>(function HistoryPanel(
		{
			session,
			theme,
			onJumpToAgentSession,
			onResumeSession,
			onOpenSessionAsTab,
			onOpenAboutModal,
			fileTree,
			onFileClick,
		},
		ref
	) {
		const maestroCueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue);
		const shortcuts = useSettingsStore((s) => s.shortcuts);
		const visibleTypes: HistoryEntryType[] = maestroCueEnabled
			? ['AUTO', 'USER', 'CUE']
			: ['AUTO', 'USER'];

		const [activeFilters, setActiveFilters] = useState<Set<HistoryEntryType>>(
			() => new Set(maestroCueEnabled ? ['AUTO', 'USER', 'CUE'] : ['AUTO', 'USER'])
		);
		const [detailModalEntry, setDetailModalEntry] = useState<HistoryEntry | null>(null);
		const [searchFilter, setSearchFilter] = useState('');
		const searchFilterOpen = useUIStore((s) => s.historySearchFilterOpen);
		const setSearchFilterOpen = useUIStore((s) => s.setHistorySearchFilterOpen);
		const [graphViewportRange, setGraphViewportRange] = useState<
			{ start: number; end: number } | undefined
		>(undefined);
		const [helpModalOpen, setHelpModalOpen] = useState(false);
		// Lookback selector — drives both the paginated entry list (server-side)
		// and the graph window. The graph data is server-cached per lookback,
		// so flipping between windows is cheap once each has been computed.
		const [graphLookbackHours, setGraphLookbackHours] = useState<number | null>(null);
		// Server-cached graph buckets for the current lookback.
		const [graphBuckets, setGraphBuckets] = useState<GraphBucket[] | undefined>(undefined);
		const [graphRange, setGraphRange] = useState<{ start: number; end: number } | undefined>(
			undefined
		);
		const graphRefreshScheduled = useRef(false);

		const listRef = useRef<HTMLDivElement>(null);
		const searchInputRef = useRef<HTMLInputElement>(null);
		const hasRestoredScroll = useRef<boolean>(false);

		// Reset search filter state when unmounting (e.g., tab switch) to prevent stale store state
		useEffect(() => {
			return () => setSearchFilterOpen(false);
		}, [setSearchFilterOpen]);

		// Page loader for the shared pagination hook. Memoized on
		// `(session.id, session.cwd, graphLookbackHours)` so any of those
		// changes resets the window via the hook's loader-identity reset.
		// Stable shared-context snapshot — only changes when the relevant
		// SSH bits or cwd change. Keeps `loadPage` identity stable across
		// unrelated session field updates so the pagination hook doesn't
		// reset on every render.
		const sharedContextSnapshot = useMemo(
			() => buildSharedHistoryContext(session),
			[
				session.id,
				session.cwd,
				session.sessionSshRemoteConfig?.enabled,
				session.sessionSshRemoteConfig?.remoteId,
				session.sessionSshRemoteConfig?.syncHistory,
			]
		);
		const loadPage = useCallback(
			async (offset: number, limit: number): Promise<PaginatedPage<HistoryEntry>> => {
				const result = await window.maestro.history.getAllPaginated({
					sessionId: session.id,
					sharedContext: sharedContextSnapshot,
					lookbackHours: graphLookbackHours,
					pagination: { offset, limit },
				});
				return {
					entries: result.entries as HistoryEntry[],
					hasMore: result.hasMore,
					total: result.total,
				};
			},
			[session.id, sharedContextSnapshot, graphLookbackHours]
		);

		const getEntryId = useCallback((entry: HistoryEntry) => entry.id, []);

		const {
			entries: historyEntries,
			totalCount,
			isLoading,
			isLoadingMore,
			isJumping,
			loadMoreOlder,
			jumpToOffset,
			jumpToTop,
			prependLiveEntry,
			mutateEntries,
		} = useHistoryPagination<HistoryEntry>({
			pageSize: PAGE_SIZE,
			loadPage,
			getEntryId,
		});

		// Fetch graph aggregate for the current lookback. Cached server-side
		// per (sessionId, bucketCount, lookback, source mtime+size).
		const refreshGraphData = useCallback(async () => {
			try {
				const data = await window.maestro.history.getGraphData(
					session.id,
					bucketCountForLookback(graphLookbackHours),
					graphLookbackHours,
					buildSharedHistoryContext(session)
				);
				setGraphBuckets(data.buckets);
				setGraphRange({ start: data.earliestTimestamp, end: data.latestTimestamp });
			} catch (error) {
				logger.error('Failed to load history graph data:', undefined, error);
				setGraphBuckets(undefined);
				setGraphRange(undefined);
			}
		}, [session.id, session, graphLookbackHours]);

		useEffect(() => {
			refreshGraphData();
		}, [refreshGraphData]);

		// Subscribe to real-time history entry additions. Entries are only
		// inserted when the loaded window is at the top — when jumped, they're
		// silently dropped (the next pagination call will pick them up).
		useEffect(() => {
			const cleanup = window.maestro.directorNotes.onHistoryEntryAdded((entry, sourceSessionId) => {
				if (sourceSessionId !== session.id) return;

				const inserted = prependLiveEntry(entry);

				// Coalesce graph refreshes — a burst of streamed entries
				// shouldn't trigger a refetch per entry. Only refresh when
				// the entry actually landed in view.
				if (inserted && !graphRefreshScheduled.current) {
					graphRefreshScheduled.current = true;
					requestAnimationFrame(() => {
						graphRefreshScheduled.current = false;
						refreshGraphData();
					});
				}
			});

			return cleanup;
		}, [session.id, refreshGraphData, prependLiveEntry]);

		// Load persisted graph lookback preference for this session
		useEffect(() => {
			const loadLookbackPreference = async () => {
				const settingsKey = `historyGraphLookback:${session.id}`;
				const saved = await window.maestro.settings.get(settingsKey);
				if (saved !== undefined) {
					// saved could be null (all time) or a number
					setGraphLookbackHours(saved as number | null);
				}
			};
			loadLookbackPreference();
		}, [session.id]);

		// Handler to update lookback hours and persist the preference
		const handleLookbackChange = useCallback(
			(hours: number | null) => {
				setGraphLookbackHours(hours);
				const settingsKey = `historyGraphLookback:${session.id}`;
				window.maestro.settings.set(settingsKey, hours);
			},
			[session.id]
		);

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

		// Toggle a filter
		const toggleFilter = (type: HistoryEntryType) => {
			setActiveFilters((prev) => {
				const newFilters = new Set(prev);
				if (newFilters.has(type)) {
					newFilters.delete(type);
				} else {
					newFilters.add(type);
				}
				return newFilters;
			});
		};

		// Client-side filters applied to the loaded window. Lookback is
		// now server-side (part of the page loader), so it doesn't appear
		// here — entries arriving from the IPC are already inside the
		// window. Type + search remain client-side over loaded pages.
		const allFilteredEntries = useMemo(() => {
			return historyEntries.filter((entry) => {
				if (!entry || !entry.type) return false;
				if (!activeFilters.has(entry.type)) return false;

				if (searchFilter) {
					const searchLower = searchFilter.toLowerCase();
					const summaryMatch = entry.summary?.toLowerCase().includes(searchLower);
					const responseMatch = entry.fullResponse?.toLowerCase().includes(searchLower);
					const sessionIdMatch = entry.agentSessionId?.toLowerCase().includes(searchLower);
					const sessionNameMatch = entry.sessionName?.toLowerCase().includes(searchLower);
					if (!summaryMatch && !responseMatch && !sessionIdMatch && !sessionNameMatch) return false;
				}

				return true;
			});
		}, [historyEntries, activeFilters, searchFilter]);

		// Note: With virtualization, we no longer need to slice entries
		// The virtualizer handles rendering only visible items efficiently
		// filteredEntries is kept as an alias for backwards compatibility with some handlers
		const filteredEntries = allFilteredEntries;

		// ============================================================================
		// Virtualization Setup (must be before handlers that use it)
		// ============================================================================

		// Estimate row height based on entry content
		const estimateSize = useCallback(
			(index: number) => {
				const entry = allFilteredEntries[index];
				if (!entry) return ESTIMATED_ROW_HEIGHT;
				// Entries with footer (elapsed time, cost, or achievement) are taller
				const hasFooter =
					entry.elapsedTimeMs !== undefined ||
					(entry.usageStats && entry.usageStats.totalCostUsd > 0) ||
					entry.achievementAction;
				return hasFooter ? ESTIMATED_ROW_HEIGHT : ESTIMATED_ROW_HEIGHT_SIMPLE;
			},
			[allFilteredEntries]
		);

		// Create virtualizer
		// Note: initialRect prevents flushSync during initial render by providing initial dimensions
		const virtualizer = useVirtualizer({
			count: allFilteredEntries.length,
			getScrollElement: () => listRef.current,
			estimateSize,
			overscan: 5, // Render 5 extra items above/below viewport
			gap: 12, // Space between items (equivalent to space-y-3)
			initialRect: { width: 300, height: 600 }, // Provide initial dimensions to avoid flushSync during render
		});

		// Get virtual items for rendering
		const virtualItems = virtualizer.getVirtualItems();

		// Handle Enter key selection - opens detail modal for selected entry
		const handleSelectByIndex = useCallback(
			(index: number) => {
				if (index >= 0 && index < allFilteredEntries.length) {
					setDetailModalEntry(allFilteredEntries[index]);
				}
			},
			[allFilteredEntries]
		);

		// Use list navigation hook for ArrowUp/ArrowDown/Enter handling
		// Note: initialIndex is -1 to support "no selection" state
		const {
			selectedIndex,
			setSelectedIndex,
			handleKeyDown: listNavHandleKeyDown,
		} = useListNavigation({
			listLength: allFilteredEntries.length,
			onSelect: handleSelectByIndex,
			initialIndex: -1,
		});

		// Expose focus and refreshHistory methods to parent. Refresh now
		// goes through the hook's `jumpToTop` since the entry list is
		// paginated — there's no full-table reload to preserve scroll for.
		useImperativeHandle(
			ref,
			() => ({
				focus: () => {
					listRef.current?.focus();
					if (selectedIndex < 0 && historyEntries.length > 0) {
						setSelectedIndex(0);
					}
				},
				refreshHistory: () => {
					void jumpToTop();
				},
			}),
			[selectedIndex, setSelectedIndex, historyEntries.length, jumpToTop]
		);

		/**
		 * Click-to-jump on the activity graph.
		 *
		 * Fast path: target bucket is in the loaded window → scroll to it.
		 *
		 * Slow path: ask the server for the offset of the first entry at
		 * (or just before) the bucket's end, then `jumpToOffset` to load
		 * a single page anchored at that target. No fill-in between —
		 * memory stays bounded.
		 */
		const handleGraphBarClickVirtualized = useCallback(
			async (bucketStart: number, bucketEnd: number) => {
				const findIdx = (list: HistoryEntry[]) =>
					list.findIndex((e) => e.timestamp >= bucketStart && e.timestamp < bucketEnd);

				const idx = findIdx(allFilteredEntries);
				if (idx >= 0) {
					setSelectedIndex(idx);
					virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
					return;
				}

				try {
					const targetOffset = await window.maestro.history.getOffsetForTimestamp(
						session.id,
						bucketEnd - 1,
						graphLookbackHours
					);
					await jumpToOffset(targetOffset);
					requestAnimationFrame(() => {
						virtualizer.scrollToIndex(0, { align: 'start', behavior: 'auto' });
					});
				} catch (error) {
					logger.error('Failed to jump to graph bucket:', undefined, error);
				}
			},
			[
				allFilteredEntries,
				session.id,
				graphLookbackHours,
				jumpToOffset,
				setSelectedIndex,
				virtualizer,
			]
		);

		// PERF: Store scroll target ref for throttled handler
		const scrollTargetRef = useRef<HTMLDivElement | null>(null);

		// Handle scroll: pagination + graph viewport indicator.
		// PERF: Inner handler contains the actual logic
		const handleScrollInner = useCallback(() => {
			const target = scrollTargetRef.current;
			if (!target) return;

			// Save scroll position to module-level cache (persists across session switches)
			scrollPositionCache.set(session.id, target.scrollTop);

			// Pagination: load next older page when near bottom. The hook
			// guards against concurrent calls and no-ops when there's
			// nothing more to load.
			if (!isLoading) {
				const nearBottom =
					target.scrollHeight - target.scrollTop - target.clientHeight < SCROLL_LOAD_THRESHOLD;
				if (nearBottom) {
					void loadMoreOlder();
				}
			}

			// Track which entries are visible to show a viewport indicator on the graph
			const visibleItems = virtualizer.getVirtualItems();
			if (visibleItems.length === 0) {
				setGraphViewportRange(undefined);
				return;
			}

			const firstVisibleIndex = visibleItems[0]?.index ?? 0;
			const lastVisibleIndex = visibleItems[visibleItems.length - 1]?.index ?? 0;
			const topEntry = allFilteredEntries[firstVisibleIndex];
			const bottomEntry = allFilteredEntries[lastVisibleIndex];

			if (target.scrollTop < 10 && lastVisibleIndex >= allFilteredEntries.length - 1) {
				// All entries visible — no indicator needed
				setGraphViewportRange(undefined);
			} else if (topEntry && bottomEntry) {
				// Entries are newest-first, so topEntry.timestamp > bottomEntry.timestamp
				setGraphViewportRange({
					start: bottomEntry.timestamp,
					end: topEntry.timestamp,
				});
			}
		}, [session.id, allFilteredEntries, virtualizer, isLoading, loadMoreOlder]);

		// PERF: Throttle scroll handler to 4ms (~240fps) for smooth scrollbar
		const throttledScrollHandler = useThrottledCallback(handleScrollInner, 4);

		// Wrapper to capture scroll target and call throttled handler
		const handleScroll = useCallback(
			(e: React.UIEvent<HTMLDivElement>) => {
				scrollTargetRef.current = e.currentTarget;
				throttledScrollHandler();
			},
			[throttledScrollHandler]
		);

		// Restore scroll position when loading completes (switching sessions or initial load)
		useEffect(() => {
			if (listRef.current && !isLoading && !hasRestoredScroll.current) {
				const savedPosition = scrollPositionCache.get(session.id);
				if (savedPosition !== undefined && savedPosition > 0) {
					// Use requestAnimationFrame to ensure DOM has rendered
					requestAnimationFrame(() => {
						if (listRef.current) {
							listRef.current.scrollTop = savedPosition;
						}
					});
				}
				hasRestoredScroll.current = true;
			}
		}, [isLoading, session.id]);

		// Reset the restore flag when session changes so we restore for the new session
		useEffect(() => {
			hasRestoredScroll.current = false;
		}, [session.id]);

		// Reset selected index and viewport indicator when filters or lookback change
		useEffect(() => {
			setSelectedIndex(-1);
			setGraphViewportRange(undefined); // Reset viewport indicator when filters change
			// Scroll to top when filters change
			if (listRef.current) {
				listRef.current.scrollTop = 0;
			}
		}, [activeFilters, searchFilter, graphLookbackHours, setSelectedIndex]);

		// Scroll selected item into view when selectedIndex changes (keyboard navigation)
		useEffect(() => {
			if (selectedIndex >= 0 && selectedIndex < allFilteredEntries.length) {
				virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
			}
		}, [selectedIndex, allFilteredEntries.length, virtualizer]);

		// Keyboard navigation handler - combines hook handler with custom Escape/Cmd+F logic
		const handleKeyDown = useCallback(
			(e: React.KeyboardEvent) => {
				// Open search filter with Cmd+F
				if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !searchFilterOpen) {
					e.preventDefault();
					setSearchFilterOpen(true);
					// Focus the search input after state update
					setTimeout(() => searchInputRef.current?.focus(), 0);
					return;
				}

				// Handle Escape to clear selection (when modal is not open)
				if (e.key === 'Escape' && !detailModalEntry) {
					setSelectedIndex(-1);
					return;
				}

				// Delegate ArrowUp/ArrowDown/Enter to the list navigation hook
				listNavHandleKeyDown(e);
			},
			[searchFilterOpen, detailModalEntry, setSelectedIndex, listNavHandleKeyDown]
		);

		// Open detail modal for an entry
		const openDetailModal = useCallback(
			(entry: HistoryEntry, index: number) => {
				setSelectedIndex(index);
				setDetailModalEntry(entry);
			},
			[setSelectedIndex]
		);

		// Close detail modal and restore focus
		const closeDetailModal = useCallback(() => {
			setDetailModalEntry(null);
			// Restore focus to the list
			listRef.current?.focus();
		}, []);

		// Delete a history entry
		// Pass sessionId for efficient lookup in per-session storage
		const handleDeleteEntry = useCallback(
			async (entryId: string) => {
				try {
					const success = await window.maestro.history.delete(entryId, session.id);
					if (success) {
						mutateEntries((prev) => prev.filter((entry) => entry.id !== entryId));
						setSelectedIndex(-1);
					}
				} catch (error) {
					logger.error('Failed to delete history entry:', undefined, error);
				}
			},
			[session.id, setSelectedIndex, mutateEntries]
		);

		return (
			<div className="flex flex-col h-full">
				{/* Filter Pills + Activity Graph + Help Button */}
				<div className="flex flex-col gap-2 mb-4 pt-2">
					{/* Search Filter — above buttons when open */}
					{searchFilterOpen && (
						<div>
							<input
								ref={searchInputRef}
								autoFocus
								type="text"
								placeholder="Filter history..."
								value={searchFilter}
								onChange={(e) => setSearchFilter(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape') {
										setSearchFilterOpen(false);
										setSearchFilter('');
										// Return focus to the list
										listRef.current?.focus();
									} else if (e.key === 'ArrowDown') {
										e.preventDefault();
										// Move focus to list and select first item
										listRef.current?.focus();
										if (filteredEntries.length > 0) {
											setSelectedIndex(0);
										}
									}
								}}
								className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
								style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
							/>
							{searchFilter && (
								<div
									className="text-[10px] mt-1 text-right"
									style={{ color: theme.colors.textDim }}
								>
									{allFilteredEntries.length} result{allFilteredEntries.length !== 1 ? 's' : ''}
								</div>
							)}
						</div>
					)}

					<div
						className={`flex items-start gap-3${visibleTypes.length > 2 ? ' justify-center' : ''}`}
					>
						{/* Search button — left of filter pills */}
						<button
							onClick={() => {
								if (searchFilterOpen) {
									searchInputRef.current?.focus();
								} else {
									setSearchFilterOpen(true);
									setTimeout(() => searchInputRef.current?.focus(), 0);
								}
							}}
							className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-white/10"
							style={{
								color: searchFilterOpen ? theme.colors.accent : theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							title={`Search History (${formatShortcutKeys(shortcuts.filterHistory?.keys ?? ['Meta', 'f'])})`}
						>
							<Search className="w-3.5 h-3.5" />
						</button>

						{/* Filter pills — centered when graph is on its own row */}
						<HistoryFilterToggle
							activeFilters={activeFilters}
							onToggleFilter={toggleFilter}
							theme={theme}
							visibleTypes={visibleTypes}
						/>

						{/* Activity graph inline when only 2 types (no CUE) */}
						{visibleTypes.length <= 2 && (
							<ActivityGraph
								entries={historyEntries}
								theme={theme}
								viewportRange={graphViewportRange}
								onBarClick={handleGraphBarClickVirtualized}
								lookbackHours={graphLookbackHours}
								onLookbackChange={handleLookbackChange}
							/>
						)}

						{/* Help button — right of filter pills */}
						<button
							onClick={() => setHelpModalOpen(true)}
							className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded transition-colors hover:bg-white/10"
							style={{
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							title="History panel help"
						>
							<HelpCircle className="w-3.5 h-3.5" />
						</button>
					</div>

					{/* Activity graph on its own row when 3 types (CUE enabled) */}
					{visibleTypes.length > 2 && (
						<ActivityGraph
							entries={historyEntries}
							theme={theme}
							viewportRange={graphViewportRange}
							onBarClick={handleGraphBarClickVirtualized}
							lookbackHours={graphLookbackHours}
							onLookbackChange={handleLookbackChange}
							precomputedBuckets={graphBuckets}
							precomputedRange={graphRange}
							alwaysShowViewportLabel
						/>
					)}
				</div>

				{/* History List - Virtualized */}
				<div
					ref={listRef}
					className="flex-1 overflow-y-auto outline-none scrollbar-thin"
					tabIndex={0}
					onKeyDown={handleKeyDown}
					onScroll={handleScroll}
				>
					{isLoading ? (
						<div className="text-center py-8 text-xs opacity-50">Loading history...</div>
					) : allFilteredEntries.length === 0 ? (
						<div className="text-center py-8 text-xs opacity-50">
							{totalCount === 0 ? (
								graphLookbackHours !== null ? (
									<>
										No entries in the last{' '}
										{graphLookbackHours <= 24
											? `${graphLookbackHours}h`
											: graphLookbackHours <= 168
												? `${Math.round(graphLookbackHours / 24)}d`
												: `${Math.round(graphLookbackHours / 720)}mo`}
										.
										<br />
										<button
											onClick={() => handleLookbackChange(null)}
											className="mt-2 underline hover:no-underline"
											style={{ color: theme.colors.accent }}
										>
											Show all time
										</button>
									</>
								) : (
									'No history yet. Run batch tasks or use /history to add entries.'
								)
							) : searchFilter ? (
								`No entries match "${searchFilter}" in the loaded window.`
							) : (
								'No entries match the selected filters in the loaded window.'
							)}
						</div>
					) : (
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								width: '100%',
								position: 'relative',
							}}
						>
							{virtualItems.map((virtualItem) => {
								const entry = allFilteredEntries[virtualItem.index];
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
											onOpenSessionAsTab={onOpenSessionAsTab}
											onOpenAboutModal={onOpenAboutModal}
										/>
									</div>
								);
							})}
						</div>
					)}

					{/* Loading-more / jump indicator */}
					{(isLoadingMore || isJumping) && (
						<div
							className="text-center py-3 text-[10px] opacity-60"
							style={{ color: theme.colors.textDim }}
						>
							{isJumping ? 'Jumping to selected period...' : 'Loading more...'}
						</div>
					)}
				</div>

				{/* Detail Modal */}
				{detailModalEntry && (
					<HistoryDetailModal
						theme={theme}
						entry={detailModalEntry}
						agentId={session.toolType}
						onClose={closeDetailModal}
						onJumpToAgentSession={onJumpToAgentSession}
						onResumeSession={onResumeSession}
						onDelete={handleDeleteEntry}
						onUpdate={async (entryId, updates) => {
							// Pass sessionId for efficient lookup in per-session storage
							const success = await window.maestro.history.update(entryId, updates, session.id);
							if (success) {
								mutateEntries((prev) =>
									prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e))
								);
								setDetailModalEntry((prev) => (prev ? { ...prev, ...updates } : null));
							}
							return success;
						}}
						// Navigation props - use allFilteredEntries (respects filters)
						filteredEntries={allFilteredEntries}
						currentIndex={selectedIndex}
						onNavigate={(entry, index) => {
							setSelectedIndex(index);
							setDetailModalEntry(entry);
							// With virtualization, scrolling is handled automatically via the selectedIndex effect
							virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
						}}
						// File linking props for markdown rendering
						fileTree={fileTree}
						cwd={session.cwd}
						projectRoot={session.projectRoot}
						onFileClick={onFileClick}
					/>
				)}

				{/* Help Modal */}
				{helpModalOpen && (
					<HistoryHelpModal theme={theme} onClose={() => setHelpModalOpen(false)} />
				)}
			</div>
		);
	})
);
