import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Theme, HistoryEntry, HistoryEntryType } from '../../types';
import type { FileNode } from '../../types/fileTree';
import {
	ActivityGraph,
	HistoryEntryItem,
	HistoryFilterToggle,
	ESTIMATED_ROW_HEIGHT,
	ESTIMATED_ROW_HEIGHT_SIMPLE,
} from '../History';
import { HistoryDetailModal } from '../HistoryDetailModal';
import { useSettings, useListNavigation } from '../../hooks';

interface UnifiedHistoryEntry extends HistoryEntry {
	agentName?: string;
	sourceSessionId: string;
}

interface UnifiedHistoryTabProps {
	theme: Theme;
	fileTree?: FileNode[];
	onFileClick?: (path: string) => void;
}

export function UnifiedHistoryTab({
	theme,
	fileTree,
	onFileClick,
}: UnifiedHistoryTabProps) {
	const { directorNotesSettings } = useSettings();
	const [entries, setEntries] = useState<UnifiedHistoryEntry[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [activeFilters, setActiveFilters] = useState<Set<HistoryEntryType>>(new Set(['AUTO', 'USER']));
	const [lookbackDays, setLookbackDays] = useState(directorNotesSettings.defaultLookbackDays);
	const [detailModalEntry, setDetailModalEntry] = useState<HistoryEntry | null>(null);
	const [searchFilter, setSearchFilter] = useState('');

	const listRef = useRef<HTMLDivElement>(null);

	// Load unified history
	const loadHistory = useCallback(async () => {
		setIsLoading(true);
		try {
			const result = await window.maestro.directorNotes.getUnifiedHistory({
				lookbackDays,
				filter: null, // Get all, filter client-side
			});
			setEntries(result as UnifiedHistoryEntry[]);
		} catch (error) {
			console.error('Failed to load unified history:', error);
			setEntries([]);
		} finally {
			setIsLoading(false);
		}
	}, [lookbackDays]);

	useEffect(() => {
		loadHistory();
	}, [loadHistory]);

	// Auto-focus the list after loading completes for keyboard navigation
	useEffect(() => {
		if (!isLoading) {
			listRef.current?.focus();
		}
	}, [isLoading]);

	// Filter entries
	const filteredEntries = useMemo(() => {
		return entries.filter(entry => {
			if (!activeFilters.has(entry.type)) return false;
			if (searchFilter) {
				const search = searchFilter.toLowerCase();
				if (!entry.summary?.toLowerCase().includes(search) &&
						!entry.agentName?.toLowerCase().includes(search)) {
					return false;
				}
			}
			return true;
		});
	}, [entries, activeFilters, searchFilter]);

	// Toggle filter
	const toggleFilter = useCallback((type: HistoryEntryType) => {
		setActiveFilters(prev => {
			const next = new Set(prev);
			if (next.has(type)) next.delete(type);
			else next.add(type);
			return next;
		});
	}, []);

	// Virtualization
	const estimateSize = useCallback((index: number) => {
		const entry = filteredEntries[index];
		if (!entry) return ESTIMATED_ROW_HEIGHT;
		const hasFooter = entry.elapsedTimeMs !== undefined ||
			(entry.usageStats && entry.usageStats.totalCostUsd > 0);
		return hasFooter ? ESTIMATED_ROW_HEIGHT : ESTIMATED_ROW_HEIGHT_SIMPLE;
	}, [filteredEntries]);

	const virtualizer = useVirtualizer({
		count: filteredEntries.length,
		getScrollElement: () => listRef.current,
		estimateSize,
		overscan: 5,
		gap: 12,
		initialRect: { width: 300, height: 600 },
	});

	// List navigation
	const { selectedIndex, setSelectedIndex, handleKeyDown: listNavKeyDown } = useListNavigation({
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

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			// Search not yet implemented for unified history
			return;
		}
		listNavKeyDown(e);
	}, [listNavKeyDown]);

	const openDetailModal = useCallback((entry: HistoryEntry, index: number) => {
		setSelectedIndex(index);
		setDetailModalEntry(entry);
	}, [setSelectedIndex]);

	const closeDetailModal = useCallback(() => {
		setDetailModalEntry(null);
		listRef.current?.focus();
	}, []);

	// Convert lookbackDays to lookbackHours for ActivityGraph compatibility
	const lookbackHours = lookbackDays * 24;

	// Suppress unused variable warning for searchFilter setter
	void setSearchFilter;

	return (
		<div className="flex flex-col h-full p-4">
			{/* Header: Filters + Activity Graph */}
			<div className="flex items-start gap-3 mb-4">
				<HistoryFilterToggle
					activeFilters={activeFilters}
					onToggleFilter={toggleFilter}
					theme={theme}
				/>
				<ActivityGraph
					entries={entries}
					theme={theme}
					lookbackHours={lookbackHours}
					onLookbackChange={(hours) => setLookbackDays(hours ? Math.ceil(hours / 24) : 90)}
					onBarClick={(start, end) => {
						// Find first entry in range and select it
						const idx = filteredEntries.findIndex(e => e.timestamp >= start && e.timestamp < end);
						if (idx >= 0) {
							setSelectedIndex(idx);
							virtualizer.scrollToIndex(idx, { align: 'center', behavior: 'smooth' });
						}
					}}
				/>
			</div>

			{/* Entry list */}
			<div
				ref={listRef}
				className="flex-1 overflow-y-auto outline-none scrollbar-thin"
				tabIndex={0}
				onKeyDown={handleKeyDown}
			>
				{isLoading ? (
					<div className="text-center py-8 text-xs opacity-50">Loading history...</div>
				) : filteredEntries.length === 0 ? (
					<div className="text-center py-8 text-xs opacity-50">
						No history entries found for the selected time period.
					</div>
				) : (
					<div
						style={{
							height: `${virtualizer.getTotalSize()}px`,
							width: '100%',
							position: 'relative',
						}}
					>
						{virtualizer.getVirtualItems().map(virtualItem => {
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
										// Show agent name prominently for unified view
										showAgentName
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
