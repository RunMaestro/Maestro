import React, {
	useState,
	useEffect,
	useRef,
	useCallback,
	useImperativeHandle,
	forwardRef,
	useMemo,
} from 'react';
import { HelpCircle } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Session, Theme, HistoryEntry, HistoryEntryType } from '../types';
import { HistoryDetailModal } from './HistoryDetailModal';
import { HistoryHelpModal } from './HistoryHelpModal';
import { useThrottledCallback, useListNavigation } from '../hooks';
import {
	ActivityGraph,
	HistoryEntryItem,
	HistoryFilterToggle,
	MAX_HISTORY_IN_MEMORY,
	ESTIMATED_ROW_HEIGHT,
	ESTIMATED_ROW_HEIGHT_SIMPLE,
} from './History';
import { useUIStore } from '../stores/uiStore';

interface HistoryPanelProps {
	session: Session;
	theme: Theme;
	onJumpToAgentSession?: (agentSessionId: string) => void;
	onResumeSession?: (agentSessionId: string) => void;
	onOpenSessionAsTab?: (agentSessionId: string) => void;
	onOpenAboutModal?: () => void; // For opening About/achievements panel from history entries
	// File linking props for history detail modal
	fileTree?: any[];
	onFileClick?: (path: string) => void;
}

export interface HistoryPanelHandle {
	focus: () => void;
	refreshHistory: () => void;
}

// Module-level storage for scroll positions (persists across session switches)
const scrollPositionCache = new Map<string, number>();

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
		const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
		const [activeFilters, setActiveFilters] = useState<Set<HistoryEntryType>>(
			new Set(['AUTO', 'USER'])
		);
		const [isLoading, setIsLoading] = useState(true);
		const [detailModalEntry, setDetailModalEntry] = useState<HistoryEntry | null>(null);
		const [searchFilter, setSearchFilter] = useState('');
		const searchFilterOpen = useUIStore((s) => s.historySearchFilterOpen);
		const setSearchFilterOpen = useUIStore((s) => s.setHistorySearchFilterOpen);
		const [graphReferenceTime, setGraphReferenceTime] = useState<number | undefined>(undefined);
		const [helpModalOpen, setHelpModalOpen] = useState(false);
		const [graphLookbackHours, setGraphLookbackHours] = useState<number | null>(null); // default to "All time"

		const listRef = useRef<HTMLDivElement>(null);
		const searchInputRef = useRef<HTMLInputElement>(null);
		const hasRestoredScroll = useRef<boolean>(false);

		// Reset search filter state when unmounting (e.g., tab switch) to prevent stale store state
		useEffect(() => {
			return () => setSearchFilterOpen(false);
		}, [setSearchFilterOpen]);

		// Load history entries function - reusable for initial load and refresh
		// When isRefresh=true, preserve scroll position
		const loadHistory = useCallback(
			async (isRefresh = false) => {
				// Save current scroll position before loading
				const currentScrollTop = listRef.current?.scrollTop ?? 0;

				if (!isRefresh) {
					setIsLoading(true);
				}

				try {
					// Only show entries from this session or legacy entries without sessionId
					const entries = await window.maestro.history.getAll(session.cwd, session.id);
					// Ensure entries is an array, limit to MAX_HISTORY_IN_MEMORY
					const validEntries = Array.isArray(entries) ? entries : [];
					setHistoryEntries(validEntries.slice(0, MAX_HISTORY_IN_MEMORY));

					if (isRefresh) {
						// On refresh, restore scroll position
						// Use RAF to ensure DOM has updated before restoring scroll
						requestAnimationFrame(() => {
							if (listRef.current) {
								listRef.current.scrollTop = currentScrollTop;
							}
						});
					}
					// Note: With virtualization, display count is managed automatically
				} catch (error) {
					console.error('Failed to load history:', error);
					setHistoryEntries([]);
				} finally {
					if (!isRefresh) {
						setIsLoading(false);
					}
				}
			},
			[session.cwd, session.id]
		);

		// Load history entries on mount and when session changes
		useEffect(() => {
			loadHistory();
		}, [loadHistory]);

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

		// Filter entries based on active filters, search text, and lookback period
		const allFilteredEntries = useMemo(() => {
			// Compute lookback cutoff once (null = all time, no cutoff)
			const cutoffTime =
				graphLookbackHours !== null ? Date.now() - graphLookbackHours * 60 * 60 * 1000 : 0;

			return historyEntries.filter((entry) => {
				if (!entry || !entry.type) return false;
				if (!activeFilters.has(entry.type)) return false;

				// Apply lookback time filter
				if (cutoffTime > 0 && entry.timestamp < cutoffTime) return false;

				// Apply text search filter
				if (searchFilter) {
					const searchLower = searchFilter.toLowerCase();
					const summaryMatch = entry.summary?.toLowerCase().includes(searchLower);
					const responseMatch = entry.fullResponse?.toLowerCase().includes(searchLower);
					// Search by session ID (full ID or short octet form)
					const sessionIdMatch = entry.agentSessionId?.toLowerCase().includes(searchLower);
					const sessionNameMatch = entry.sessionName?.toLowerCase().includes(searchLower);
					if (!summaryMatch && !responseMatch && !sessionIdMatch && !sessionNameMatch) return false;
				}

				return true;
			});
		}, [historyEntries, activeFilters, searchFilter, graphLookbackHours]);

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

		// Expose focus and refreshHistory methods to parent
		// Note: Must be after useListNavigation since it uses selectedIndex/setSelectedIndex
		useImperativeHandle(
			ref,
			() => ({
				focus: () => {
					listRef.current?.focus();
					// Select first item if none selected
					if (selectedIndex < 0 && historyEntries.length > 0) {
						setSelectedIndex(0);
					}
				},
				refreshHistory: () => {
					// Pass true to indicate this is a refresh, not initial load
					// This preserves scroll position
					loadHistory(true);
				},
			}),
			[selectedIndex, setSelectedIndex, historyEntries.length, loadHistory]
		);

		// Update graph bar click handler to use virtualizer for scrolling
		const handleGraphBarClickVirtualized = useCallback(
			(bucketStart: number, bucketEnd: number) => {
				// Find entries within this time bucket (entries are sorted newest first)
				const entriesInBucket = historyEntries.filter(
					(entry) => entry.timestamp >= bucketStart && entry.timestamp < bucketEnd
				);

				if (entriesInBucket.length === 0) return;

				// Get the most recent entry in the bucket (first one since sorted by timestamp desc)
				const targetEntry = entriesInBucket[0];

				// Find its index in the filtered list
				const indexInAllFiltered = allFilteredEntries.findIndex((e) => e.id === targetEntry.id);

				if (indexInAllFiltered === -1) {
					// Entry exists but is filtered out - try finding any entry from the bucket
					const anyMatch = allFilteredEntries.findIndex(
						(e) => e.timestamp >= bucketStart && e.timestamp < bucketEnd
					);
					if (anyMatch === -1) return;

					setSelectedIndex(anyMatch);
					virtualizer.scrollToIndex(anyMatch, { align: 'center', behavior: 'smooth' });
				} else {
					setSelectedIndex(indexInAllFiltered);
					virtualizer.scrollToIndex(indexInAllFiltered, { align: 'center', behavior: 'smooth' });
				}
			},
			[historyEntries, allFilteredEntries, setSelectedIndex, virtualizer]
		);

		// PERF: Store scroll target ref for throttled handler
		const scrollTargetRef = useRef<HTMLDivElement | null>(null);

		// Handle scroll to update graph reference time
		// PERF: Inner handler contains the actual logic
		// Note: With virtualization, we no longer need to load more entries on scroll
		const handleScrollInner = useCallback(() => {
			const target = scrollTargetRef.current;
			if (!target) return;

			// Save scroll position to module-level cache (persists across session switches)
			scrollPositionCache.set(session.id, target.scrollTop);

			// Find the topmost visible entry to update the graph's reference time
			// This creates the "sliding window" effect as you scroll through history
			// With virtualization, we use the virtualizer's visible range
			const visibleItems = virtualizer.getVirtualItems();
			const firstVisibleIndex = visibleItems[0]?.index ?? 0;
			const topmostVisibleEntry = allFilteredEntries[firstVisibleIndex];

			// Update the graph reference time to the topmost visible entry's timestamp
			// If at the very top (no scrolling), use undefined to show "now"
			if (target.scrollTop < 10) {
				setGraphReferenceTime(undefined);
			} else if (topmostVisibleEntry) {
				setGraphReferenceTime(topmostVisibleEntry.timestamp);
			}
		}, [session.id, allFilteredEntries, virtualizer]);

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

		// Reset selected index and graph reference time when filters or lookback change
		useEffect(() => {
			setSelectedIndex(-1);
			setGraphReferenceTime(undefined); // Reset to "now" when filters change
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
						// Remove from local state
						setHistoryEntries((prev) => prev.filter((entry) => entry.id !== entryId));
						// Reset selection if needed
						setSelectedIndex(-1);
					}
				} catch (error) {
					console.error('Failed to delete history entry:', error);
				}
			},
			[session.id, setSelectedIndex]
		);

		return (
			<div className="flex flex-col h-full">
				{/* Filter Pills + Activity Graph + Help Button */}
				<div className="flex items-start gap-3 mb-4 pt-2">
					{/* Left-justified filter pills */}
					<HistoryFilterToggle
						activeFilters={activeFilters}
						onToggleFilter={toggleFilter}
						theme={theme}
					/>

					{/* Activity graph — lookback period also filters the entry list */}
					<ActivityGraph
						entries={historyEntries}
						theme={theme}
						referenceTime={graphReferenceTime}
						onBarClick={handleGraphBarClickVirtualized}
						lookbackHours={graphLookbackHours}
						onLookbackChange={handleLookbackChange}
					/>

					{/* Help button */}
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

				{/* Search Filter */}
				{searchFilterOpen && (
					<div className="mb-3">
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
							<div className="text-[10px] mt-1 text-right" style={{ color: theme.colors.textDim }}>
								{allFilteredEntries.length} result{allFilteredEntries.length !== 1 ? 's' : ''}
							</div>
						)}
					</div>
				)}

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
							{historyEntries.length === 0
								? 'No history yet. Run batch tasks or use /history to add entries.'
								: searchFilter
									? `No entries match "${searchFilter}"`
									: graphLookbackHours !== null ? (
										<>
											No entries in the last {graphLookbackHours <= 24 ? `${graphLookbackHours}h` : graphLookbackHours <= 168 ? `${Math.round(graphLookbackHours / 24)}d` : `${Math.round(graphLookbackHours / 720)}mo`}.
											<br />
											<button
												onClick={() => handleLookbackChange(null)}
												className="mt-2 underline hover:no-underline"
												style={{ color: theme.colors.accent }}
											>
												Show all time ({historyEntries.length} entries)
											</button>
										</>
									) : 'No entries match the selected filters.'}
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
				</div>

				{/* Detail Modal */}
				{detailModalEntry && (
					<HistoryDetailModal
						theme={theme}
						entry={detailModalEntry}
						onClose={closeDetailModal}
						onJumpToAgentSession={onJumpToAgentSession}
						onResumeSession={onResumeSession}
						onDelete={handleDeleteEntry}
						onUpdate={async (entryId, updates) => {
							// Pass sessionId for efficient lookup in per-session storage
							const success = await window.maestro.history.update(entryId, updates, session.id);
							if (success) {
								// Update local state
								setHistoryEntries((prev) =>
									prev.map((e) => (e.id === entryId ? { ...e, ...updates } : e))
								);
								// Update the modal entry state
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
