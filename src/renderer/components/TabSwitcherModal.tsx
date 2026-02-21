import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, Star, FileText } from 'lucide-react';
import type { AITab, FilePreviewTab, Theme, Shortcut, ToolType } from '../types';
import { fuzzyMatchWithScore } from '../utils/search';
import { useLayerStack } from '../contexts/LayerStackContext';
import { useListNavigation } from '../hooks';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getContextColor } from '../utils/theme';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { formatTokensCompact, formatRelativeTime, formatCost } from '../utils/formatters';
import { calculateContextDisplay } from '../utils/contextUsage';
import { getColorBlindExtensionColor } from '../constants/colorblindPalettes';

/** Named session from the store (not currently open) */
interface NamedSession {
	agentId: string;
	agentSessionId: string;
	projectPath: string;
	sessionName: string;
	starred?: boolean;
	lastActivityAt?: number;
}

/** Union type for items in the list */
type ListItem =
	| { type: 'open'; tab: AITab }
	| { type: 'file'; tab: FilePreviewTab }
	| { type: 'named'; session: NamedSession };

interface TabSwitcherModalProps {
	theme: Theme;
	tabs: AITab[];
	/** File preview tabs to include in "Open Tabs" view */
	fileTabs?: FilePreviewTab[];
	activeTabId: string;
	/** Currently active file tab ID (if a file tab is active) */
	activeFileTabId?: string | null;
	projectRoot: string; // The initial project directory (used for Claude session storage)
	agentId?: string;
	shortcut?: Shortcut;
	onTabSelect: (tabId: string) => void;
	/** Handler to select a file tab */
	onFileTabSelect?: (tabId: string) => void;
	onNamedSessionSelect: (
		agentSessionId: string,
		projectPath: string,
		sessionName: string,
		starred?: boolean
	) => void;
	onClose: () => void;
	/** Whether colorblind-friendly colors should be used for extension badges */
	colorBlindMode?: boolean;
}

// formatTokensCompact, formatRelativeTime, and formatCost imported from ../utils/formatters

/**
 * Get the last activity timestamp from a tab's logs
 */
function getTabLastActivity(tab: AITab): number | undefined {
	if (!tab.logs || tab.logs.length === 0) return undefined;
	// Get the most recent log entry timestamp
	return Math.max(...tab.logs.map((log) => log.timestamp));
}

/**
 * Get context usage percentage from usage stats.
 * Uses calculateContextDisplay() which handles accumulated multi-tool token overflow.
 */
function getContextPercentage(tab: AITab, agentId?: ToolType): number {
	if (!tab.usageStats) return 0;
	const { contextWindow } = tab.usageStats;
	if (!contextWindow || contextWindow === 0) return 0;
	return calculateContextDisplay(
		{
			inputTokens: tab.usageStats.inputTokens,
			outputTokens: tab.usageStats.outputTokens,
			cacheCreationInputTokens: tab.usageStats.cacheCreationInputTokens ?? 0,
			cacheReadInputTokens: tab.usageStats.cacheReadInputTokens ?? 0,
		},
		contextWindow,
		agentId
	).percentage;
}

/**
 * Get the display name for a tab.
 * Priority: name > first UUID octet > "New Session"
 */
function getTabDisplayName(tab: AITab): string {
	if (tab.name) {
		return tab.name;
	}
	if (tab.agentSessionId) {
		return tab.agentSessionId.split('-')[0].toUpperCase();
	}
	return 'New Session';
}

/**
 * Get the UUID pill display (first octet of session ID)
 */
function getUuidPill(agentSessionId: string | undefined | null): string | null {
	if (!agentSessionId) return null;
	return agentSessionId.split('-')[0].toUpperCase();
}

/**
 * Get color for file extension badge.
 * Returns a muted color based on file type for visual differentiation.
 * When colorBlindMode is enabled, uses Wong's colorblind-safe palette.
 * (Synchronized with TabBar.tsx for consistency)
 */
function getExtensionColor(
	extension: string,
	theme: Theme,
	colorBlindMode?: boolean
): { bg: string; text: string } {
	const isLightTheme = theme.mode === 'light';

	// Use colorblind-safe colors when enabled
	if (colorBlindMode) {
		const colorBlindColors = getColorBlindExtensionColor(extension, isLightTheme);
		if (colorBlindColors) {
			return colorBlindColors;
		}
		// Fall through to default for unknown extensions
		return { bg: theme.colors.border, text: theme.colors.textDim };
	}

	// Standard color scheme (dark theme only for backward compatibility)
	const ext = extension.toLowerCase();
	// TypeScript/JavaScript - blue tones
	if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
		return { bg: 'rgba(59, 130, 246, 0.3)', text: 'rgba(147, 197, 253, 0.9)' };
	}
	// Markdown/Docs - green tones
	if (['.md', '.mdx', '.txt', '.rst'].includes(ext)) {
		return { bg: 'rgba(34, 197, 94, 0.3)', text: 'rgba(134, 239, 172, 0.9)' };
	}
	// JSON/Config - yellow tones
	if (['.json', '.yaml', '.yml', '.toml', '.ini', '.env'].includes(ext)) {
		return { bg: 'rgba(234, 179, 8, 0.3)', text: 'rgba(253, 224, 71, 0.9)' };
	}
	// CSS/Styles - purple tones
	if (['.css', '.scss', '.sass', '.less', '.styl'].includes(ext)) {
		return { bg: 'rgba(168, 85, 247, 0.3)', text: 'rgba(216, 180, 254, 0.9)' };
	}
	// HTML/Templates - orange tones
	if (['.html', '.htm', '.xml', '.svg'].includes(ext)) {
		return { bg: 'rgba(249, 115, 22, 0.3)', text: 'rgba(253, 186, 116, 0.9)' };
	}
	// Default - use theme's dim colors
	return { bg: theme.colors.border, text: theme.colors.textDim };
}

/**
 * Circular progress gauge component
 */
function ContextGauge({
	percentage,
	theme,
	size = 36,
}: {
	percentage: number;
	theme: Theme;
	size?: number;
}) {
	const strokeWidth = 3;
	const radius = (size - strokeWidth) / 2;
	const circumference = 2 * Math.PI * radius;
	const strokeDashoffset = circumference - (percentage / 100) * circumference;
	const color = getContextColor(percentage, theme);

	return (
		<div
			className="relative flex items-center justify-center"
			style={{ width: size, height: size }}
		>
			<svg width={size} height={size} className="transform -rotate-90">
				{/* Background circle */}
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					stroke={theme.colors.border}
					strokeWidth={strokeWidth}
				/>
				{/* Progress circle */}
				<circle
					cx={size / 2}
					cy={size / 2}
					r={radius}
					fill="none"
					stroke={color}
					strokeWidth={strokeWidth}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={strokeDashoffset}
					style={{ transition: 'stroke-dashoffset 0.3s ease' }}
				/>
			</svg>
			{/* Percentage text in center */}
			<span className="absolute text-[9px] font-bold" style={{ color }}>
				{percentage}%
			</span>
		</div>
	);
}

type ViewMode = 'open' | 'all-named' | 'starred';

const EMPTY_FILE_TABS: FilePreviewTab[] = [];

/**
 * Tab Switcher Modal - Quick navigation between AI and file tabs with fuzzy search.
 * Shows context window consumption, cost, custom name, and UUID pill for AI tabs.
 * Shows filename, extension badge, and file icon for file tabs.
 * Supports switching between "Open Tabs", "All Named" sessions, and "Starred".
 */
export function TabSwitcherModal({
	theme,
	tabs,
	fileTabs = EMPTY_FILE_TABS,
	activeTabId,
	activeFileTabId,
	projectRoot,
	agentId = 'claude-code',
	shortcut,
	onTabSelect,
	onFileTabSelect,
	onNamedSessionSelect,
	onClose,
	colorBlindMode,
}: TabSwitcherModalProps) {
	const [search, setSearch] = useState('');
	const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
	const [viewMode, setViewMode] = useState<ViewMode>('open');
	const [namedSessions, setNamedSessions] = useState<NamedSession[]>([]);
	const [namedSessionsLoaded, setNamedSessionsLoaded] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const selectedItemRef = useRef<HTMLButtonElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);

	const handleSearchChange = useCallback((value: string) => {
		setSearch(value);
		setSelectedIndex(0);
		setFirstVisibleIndex(0);
	}, []);

	const handleViewModeChange = useCallback((mode: ViewMode) => {
		setViewMode(mode);
		setSelectedIndex(0);
		setFirstVisibleIndex(0);
	}, []);

	// Keep onClose ref up to date
	useEffect(() => {
		onCloseRef.current = onClose;
	});

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

	// Register layer on mount
	useEffect(() => {
		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.TAB_SWITCHER,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Tab Switcher',
			onEscape: () => onCloseRef.current(),
		});

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update handler when onClose changes
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => {
				onCloseRef.current();
			});
		}
	}, [updateLayerHandler]);

	// Focus input on mount
	useEffect(() => {
		const timer = setTimeout(() => inputRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	// On mount: sync any named tabs to the origins store, then load named sessions
	// This ensures tabs that were named before persistence was added get saved
	useEffect(() => {
		const syncAndLoad = async () => {
			// First, sync any named open tabs to the store
			const namedTabs = tabs.filter((t) => t.name && t.agentSessionId);
			const effectiveAgentId = agentId || 'claude-code';
			await Promise.all(
				namedTabs.map((tab) => {
					if (effectiveAgentId === 'claude-code') {
						return window.maestro.claude
							.updateSessionName(projectRoot, tab.agentSessionId!, tab.name!)
							.catch((err) => console.warn('[TabSwitcher] Failed to sync tab name:', err));
					} else {
						return window.maestro.agentSessions
							.setSessionName(effectiveAgentId, projectRoot, tab.agentSessionId!, tab.name!)
							.catch((err) => console.warn('[TabSwitcher] Failed to sync tab name:', err));
					}
				})
			);
			// Then load all named sessions (including the ones we just synced)
			const sessions = await window.maestro.agentSessions.getAllNamedSessions();
			setNamedSessions(sessions.filter((session) => session.agentId === effectiveAgentId));
			setNamedSessionsLoaded(true);
		};

		if (!namedSessionsLoaded) {
			syncAndLoad();
		}
	}, [namedSessionsLoaded, tabs, projectRoot, agentId]);

	// Track scroll position to determine which items are visible
	const handleScroll = () => {
		if (scrollContainerRef.current) {
			const scrollTop = scrollContainerRef.current.scrollTop;
			const itemHeight = 52; // Approximate height of each item (py-3 = 12px top + 12px bottom + content)
			const visibleIndex = Math.floor(scrollTop / itemHeight);
			setFirstVisibleIndex(visibleIndex);
		}
	};

	// Get set of open tab claude session IDs for quick lookup
	const openTabSessionIds = useMemo(() => {
		return new Set(tabs.map((t) => t.agentSessionId).filter(Boolean));
	}, [tabs]);

	// Build the list items based on view mode
	const listItems: ListItem[] = useMemo(() => {
		if (viewMode === 'open') {
			// Open tabs mode - show all currently open tabs (AI and file tabs)
			const items: ListItem[] = [];

			// Add AI tabs
			for (const tab of tabs) {
				items.push({ type: 'open' as const, tab });
			}

			// Add file tabs
			for (const tab of fileTabs) {
				items.push({ type: 'file' as const, tab });
			}

			// Sort alphabetically by display name
			items.sort((a, b) => {
				const nameA =
					a.type === 'open'
						? getTabDisplayName(a.tab).toLowerCase()
						: a.type === 'file'
							? a.tab.name.toLowerCase()
							: '';
				const nameB =
					b.type === 'open'
						? getTabDisplayName(b.tab).toLowerCase()
						: b.type === 'file'
							? b.tab.name.toLowerCase()
							: '';
				return nameA.localeCompare(nameB);
			});

			return items;
		} else if (viewMode === 'starred') {
			// Starred mode - show all starred sessions (open or closed) for the current project
			const items: ListItem[] = [];

			// Add starred open tabs (no agentSessionId requirement - tabs can be starred before session starts)
			for (const tab of tabs) {
				if (tab.starred) {
					items.push({ type: 'open' as const, tab });
				}
			}

			// Add starred closed sessions from the same project (not currently open)
			for (const session of namedSessions) {
				if (
					session.starred &&
					session.projectPath === projectRoot &&
					!openTabSessionIds.has(session.agentSessionId)
				) {
					items.push({ type: 'named' as const, session });
				}
			}

			// Sort by display name
			items.sort((a, b) => {
				const nameA =
					a.type === 'open'
						? getTabDisplayName(a.tab).toLowerCase()
						: a.type === 'named'
							? a.session.sessionName.toLowerCase()
							: '';
				const nameB =
					b.type === 'open'
						? getTabDisplayName(b.tab).toLowerCase()
						: b.type === 'named'
							? b.session.sessionName.toLowerCase()
							: '';
				return nameA.localeCompare(nameB);
			});

			return items;
		} else {
			// All Named mode - show only sessions that have been given a custom name
			// For open tabs, use the 'open' type so we get usage stats; for closed ones use 'named'
			const items: ListItem[] = [];

			// Add open tabs that have a custom name (not just UUID-based display names)
			for (const tab of tabs) {
				if (tab.agentSessionId && tab.name) {
					items.push({ type: 'open' as const, tab });
				}
			}

			// Add closed named sessions from the SAME PROJECT (not currently open)
			// Only include sessions with actual custom names (not UUID-based names)
			for (const session of namedSessions) {
				if (session.projectPath === projectRoot && !openTabSessionIds.has(session.agentSessionId)) {
					// Skip sessions where the name is just the UUID or first octet of the UUID
					const firstOctet = session.agentSessionId.split('-')[0].toUpperCase();
					const isUuidBasedName =
						session.sessionName === session.agentSessionId ||
						session.sessionName.toUpperCase() === firstOctet;
					if (!isUuidBasedName) {
						items.push({ type: 'named' as const, session });
					}
				}
			}

			// Sort all by display name (uses name > UUID octet > "New Session" fallback)
			items.sort((a, b) => {
				const nameA =
					a.type === 'open'
						? getTabDisplayName(a.tab).toLowerCase()
						: a.type === 'named'
							? a.session.sessionName.toLowerCase()
							: '';
				const nameB =
					b.type === 'open'
						? getTabDisplayName(b.tab).toLowerCase()
						: b.type === 'named'
							? b.session.sessionName.toLowerCase()
							: '';
				return nameA.localeCompare(nameB);
			});

			return items;
		}
	}, [viewMode, tabs, fileTabs, namedSessions, openTabSessionIds, projectRoot]);

	// Filter items based on search query
	const filteredItems = useMemo(() => {
		if (!search.trim()) {
			return listItems;
		}

		// Fuzzy search
		const results = listItems.map((item) => {
			let displayName: string;
			let searchableId: string;

			if (item.type === 'open') {
				displayName = getTabDisplayName(item.tab);
				searchableId = item.tab.agentSessionId || '';
			} else if (item.type === 'file') {
				// For file tabs, search by name and extension
				displayName = item.tab.name;
				searchableId = item.tab.extension + ' ' + item.tab.path;
			} else {
				displayName = item.session.sessionName;
				searchableId = item.session.agentSessionId;
			}

			const nameResult = fuzzyMatchWithScore(displayName, search);
			const idResult = fuzzyMatchWithScore(searchableId, search);

			const bestScore = Math.max(nameResult.score, idResult.score);
			const matches = nameResult.matches || idResult.matches;

			return { item, score: bestScore, matches };
		});

		return results
			.filter((r) => r.matches)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.item);
	}, [listItems, search]);

	// Helper to select an item by index
	const handleSelectByIndex = useCallback(
		(index: number) => {
			const item = filteredItems[index];
			if (item) {
				if (item.type === 'open') {
					onTabSelect(item.tab.id);
				} else if (item.type === 'file') {
					onFileTabSelect?.(item.tab.id);
				} else {
					onNamedSessionSelect(
						item.session.agentSessionId,
						item.session.projectPath,
						item.session.sessionName,
						item.session.starred
					);
				}
				onClose();
			}
		},
		[filteredItems, onTabSelect, onFileTabSelect, onNamedSessionSelect, onClose]
	);

	// Use the list navigation hook for keyboard navigation
	const {
		selectedIndex,
		setSelectedIndex,
		handleKeyDown: listKeyDown,
	} = useListNavigation({
		listLength: filteredItems.length,
		onSelect: handleSelectByIndex,
		enableNumberHotkeys: true,
		firstVisibleIndex,
	});

	// Scroll selected item into view
	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [selectedIndex]);

	const toggleViewMode = useCallback((reverse = false) => {
		setSelectedIndex(0);
		setFirstVisibleIndex(0);
		setViewMode((prev) => {
			if (reverse) {
				if (prev === 'open') return 'starred';
				if (prev === 'starred') return 'all-named';
				return 'open';
			} else {
				if (prev === 'open') return 'all-named';
				if (prev === 'all-named') return 'starred';
				return 'open';
			}
		});
	}, []);

	// Keyboard handler: Tab for view mode, delegate rest to list navigation
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Tab') {
				e.preventDefault();
				toggleViewMode(e.shiftKey);
				return;
			}
			// Stop propagation on Enter to prevent parent handlers
			if (e.key === 'Enter') {
				e.stopPropagation();
			}
			listKeyDown(e);
		},
		[listKeyDown, toggleViewMode]
	);

	return (
		<div className="fixed inset-0 modal-overlay flex items-start justify-center pt-16 z-[9999] animate-in fade-in duration-100">
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Tab Switcher"
				tabIndex={-1}
				className="w-[600px] rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[700px] outline-none"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				{/* Search Header */}
				<div
					className="p-4 border-b flex items-center gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					<Search className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					<input
						ref={inputRef}
						className="flex-1 bg-transparent outline-none text-lg placeholder-opacity-50"
						placeholder={
							viewMode === 'open'
								? 'Search open tabs...'
								: viewMode === 'starred'
									? 'Search starred sessions...'
									: 'Search named sessions...'
							}
							style={{ color: theme.colors.textMain }}
							value={search}
							onChange={(e) => handleSearchChange(e.target.value)}
							onKeyDown={handleKeyDown}
						/>
					<div className="flex items-center gap-2">
						{shortcut && (
							<span
								className="text-xs font-mono opacity-60"
								style={{ color: theme.colors.textDim }}
							>
								{formatShortcutKeys(shortcut.keys)}
							</span>
						)}
						<div
							className="px-2 py-0.5 rounded text-xs font-bold"
							style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
						>
							ESC
						</div>
					</div>
				</div>

				{/* Mode Toggle Pills */}
				<div
					className="px-4 py-2 flex items-center gap-2 border-b"
					style={{ borderColor: theme.colors.border }}
				>
						<button
							onClick={() => handleViewModeChange('open')}
							className="px-3 py-1 rounded-full text-xs font-medium transition-colors"
						style={{
							backgroundColor: viewMode === 'open' ? theme.colors.accent : theme.colors.bgMain,
							color: viewMode === 'open' ? theme.colors.accentForeground : theme.colors.textDim,
						}}
					>
						Open Tabs ({tabs.length + fileTabs.length})
					</button>
						<button
							onClick={() => handleViewModeChange('all-named')}
							className="px-3 py-1 rounded-full text-xs font-medium transition-colors"
						style={{
							backgroundColor: viewMode === 'all-named' ? theme.colors.accent : theme.colors.bgMain,
							color:
								viewMode === 'all-named' ? theme.colors.accentForeground : theme.colors.textDim,
						}}
					>
						All Named (
						{tabs.filter((t) => t.agentSessionId && t.name).length +
							namedSessions.filter((s) => {
								if (s.projectPath !== projectRoot || openTabSessionIds.has(s.agentSessionId))
									return false;
								const firstOctet = s.agentSessionId.split('-')[0].toUpperCase();
								return (
									s.sessionName !== s.agentSessionId && s.sessionName.toUpperCase() !== firstOctet
								);
							}).length}
						)
					</button>
						<button
							onClick={() => handleViewModeChange('starred')}
							className="px-3 py-1 rounded-full text-xs font-medium transition-colors flex items-center gap-1"
						style={{
							backgroundColor: viewMode === 'starred' ? theme.colors.accent : theme.colors.bgMain,
							color: viewMode === 'starred' ? theme.colors.accentForeground : theme.colors.textDim,
						}}
					>
						<Star
							className="w-3 h-3"
							style={{ fill: viewMode === 'starred' ? 'currentColor' : 'none' }}
						/>
						Starred (
						{tabs.filter((t) => t.starred).length +
							namedSessions.filter(
								(s) =>
									s.starred &&
									s.projectPath === projectRoot &&
									!openTabSessionIds.has(s.agentSessionId)
							).length}
						)
					</button>
					<span className="text-[10px] opacity-50 ml-auto" style={{ color: theme.colors.textDim }}>
						Tab / ⇧Tab to switch
					</span>
				</div>

				{/* Item List */}
				<div
					ref={scrollContainerRef}
					onScroll={handleScroll}
					className="overflow-y-auto py-2 scrollbar-thin flex-1"
				>
					{filteredItems.map((item, i) => {
						const isSelected = i === selectedIndex;

						// Calculate dynamic number badge
						const maxFirstIndex = Math.max(0, filteredItems.length - 10);
						const effectiveFirstIndex = Math.min(firstVisibleIndex, maxFirstIndex);
						const distanceFromFirstVisible = i - effectiveFirstIndex;
						const showNumber = distanceFromFirstVisible >= 0 && distanceFromFirstVisible < 10;
						const numberBadge = distanceFromFirstVisible === 9 ? 0 : distanceFromFirstVisible + 1;

						if (item.type === 'open') {
							const { tab } = item;
							const isActive = tab.id === activeTabId;
							const displayName = getTabDisplayName(tab);
							const uuidPill = getUuidPill(tab.agentSessionId);
							const contextPct = getContextPercentage(tab, agentId as ToolType);
							const cost = tab.usageStats?.totalCostUsd || 0;

							return (
								<button
									key={tab.id}
									ref={isSelected ? selectedItemRef : null}
									onClick={() => handleSelectByIndex(i)}
									className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-opacity-10"
									style={{
										backgroundColor: isSelected ? theme.colors.accent : 'transparent',
										color: isSelected ? theme.colors.accentForeground : theme.colors.textMain,
									}}
								>
									{/* Number Badge */}
									{showNumber ? (
										<div
											className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-xs font-bold"
											style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
										>
											{numberBadge}
										</div>
									) : (
										<div className="flex-shrink-0 w-5 h-5" />
									)}

									{/* Busy/Active Indicator */}
									<div className="flex-shrink-0 w-2 h-2">
										{tab.state === 'busy' ? (
											<div
												className="w-2 h-2 rounded-full animate-pulse"
												style={{ backgroundColor: theme.colors.warning }}
											/>
										) : isActive ? (
											<div
												className="w-2 h-2 rounded-full"
												style={{ backgroundColor: theme.colors.success }}
											/>
										) : null}
									</div>

									{/* Tab Info */}
									<div className="flex flex-col flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span className="font-medium truncate">{displayName}</span>
											{tab.name && uuidPill && (
												<span
													className="text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0"
													style={{
														backgroundColor: isSelected
															? 'rgba(255,255,255,0.2)'
															: theme.colors.bgMain,
														color: isSelected
															? theme.colors.accentForeground
															: theme.colors.textDim,
													}}
												>
													{uuidPill}
												</span>
											)}
											{tab.starred && <span style={{ color: theme.colors.warning }}>★</span>}
										</div>
										<div className="flex items-center gap-3 text-[10px] opacity-60">
											{tab.usageStats && (
												<>
													<span>
														{formatTokensCompact(
															tab.usageStats.inputTokens + tab.usageStats.outputTokens
														)}{' '}
														tokens
													</span>
													<span>{formatCost(cost)}</span>
												</>
											)}
											{(() => {
												const lastActivity = getTabLastActivity(tab);
												return lastActivity ? (
													<span>{formatRelativeTime(lastActivity)}</span>
												) : null;
											})()}
										</div>
									</div>

									{/* Context Gauge - only show when context window is configured */}
									{(tab.usageStats?.contextWindow ?? 0) > 0 && (
										<div className="flex-shrink-0">
											<ContextGauge percentage={contextPct} theme={theme} />
										</div>
									)}
								</button>
							);
						} else if (item.type === 'file') {
							// File preview tab
							const { tab } = item;
							const isActive = tab.id === activeFileTabId;
							const extColors = getExtensionColor(tab.extension, theme, colorBlindMode);
							const hasUnsavedEdits = !!tab.editContent;

							return (
								<button
									key={tab.id}
									ref={isSelected ? selectedItemRef : null}
									onClick={() => handleSelectByIndex(i)}
									className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-opacity-10"
									style={{
										backgroundColor: isSelected ? theme.colors.accent : 'transparent',
										color: isSelected ? theme.colors.accentForeground : theme.colors.textMain,
									}}
								>
									{/* Number Badge */}
									{showNumber ? (
										<div
											className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-xs font-bold"
											style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
										>
											{numberBadge}
										</div>
									) : (
										<div className="flex-shrink-0 w-5 h-5" />
									)}

									{/* File Icon - shows active indicator or file icon */}
									<div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
										{isActive ? (
											<div
												className="w-2 h-2 rounded-full"
												style={{ backgroundColor: theme.colors.success }}
											/>
										) : (
											<FileText className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										)}
									</div>

									{/* File Info */}
									<div className="flex flex-col flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span className="font-medium truncate">{tab.name}</span>
											{/* Extension badge - uppercase without leading dot */}
											<span
												className="text-[9px] px-1 py-0.5 rounded font-semibold uppercase flex-shrink-0"
												style={{
													backgroundColor: isSelected ? 'rgba(255,255,255,0.2)' : extColors.bg,
													color: isSelected ? theme.colors.accentForeground : extColors.text,
												}}
											>
												{tab.extension.replace(/^\./, '').toUpperCase()}
											</span>
											{/* Unsaved indicator */}
											{hasUnsavedEdits && (
												<span
													className="text-[10px] opacity-80"
													style={{ color: theme.colors.warning }}
												>
													●
												</span>
											)}
										</div>
										{/* File path (truncated) */}
										<div className="flex items-center gap-3 text-[10px] opacity-60 truncate">
											<span className="truncate">{tab.path}</span>
										</div>
									</div>

									{/* File indicator instead of gauge */}
									<div
										className="flex-shrink-0 text-[10px] px-2 py-1 rounded"
										style={{
											backgroundColor: isSelected ? 'rgba(255,255,255,0.2)' : theme.colors.bgMain,
											color: isSelected ? theme.colors.accentForeground : theme.colors.textDim,
										}}
									>
										File
									</div>
								</button>
							);
						} else {
							// Named session (not open)
							const { session } = item;
							const uuidPill = getUuidPill(session.agentSessionId);

							return (
								<button
									key={session.agentSessionId}
									ref={isSelected ? selectedItemRef : null}
									onClick={() => handleSelectByIndex(i)}
									className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-opacity-10"
									style={{
										backgroundColor: isSelected ? theme.colors.accent : 'transparent',
										color: isSelected ? theme.colors.accentForeground : theme.colors.textMain,
									}}
								>
									{/* Number Badge */}
									{showNumber ? (
										<div
											className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-xs font-bold"
											style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
										>
											{numberBadge}
										</div>
									) : (
										<div className="flex-shrink-0 w-5 h-5" />
									)}

									{/* Empty indicator space (no active/busy state for closed sessions) */}
									<div className="flex-shrink-0 w-2 h-2" />

									{/* Session Info */}
									<div className="flex flex-col flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span className="font-medium truncate">{session.sessionName}</span>
											{uuidPill && (
												<span
													className="text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0"
													style={{
														backgroundColor: isSelected
															? 'rgba(255,255,255,0.2)'
															: theme.colors.bgMain,
														color: isSelected
															? theme.colors.accentForeground
															: theme.colors.textDim,
													}}
												>
													{uuidPill}
												</span>
											)}
											{session.starred && <span style={{ color: theme.colors.warning }}>★</span>}
										</div>
										<div className="flex items-center gap-3 text-[10px] opacity-60">
											{session.lastActivityAt && (
												<span>{formatRelativeTime(session.lastActivityAt)}</span>
											)}
										</div>
									</div>

									{/* Closed indicator instead of gauge */}
									<div
										className="flex-shrink-0 text-[10px] px-2 py-1 rounded"
										style={{
											backgroundColor: isSelected ? 'rgba(255,255,255,0.2)' : theme.colors.bgMain,
											color: isSelected ? theme.colors.accentForeground : theme.colors.textDim,
										}}
									>
										Closed
									</div>
								</button>
							);
						}
					})}

					{filteredItems.length === 0 && (
						<div
							className="px-4 py-4 text-center opacity-50 text-sm"
							style={{ color: theme.colors.textDim }}
						>
							{viewMode === 'open'
								? 'No open tabs'
								: viewMode === 'starred'
									? 'No starred sessions'
									: 'No named sessions found'}
						</div>
					)}
				</div>

				{/* Footer with stats */}
				<div
					className="px-4 py-2 border-t text-xs flex items-center justify-between"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<span>
						{filteredItems.length}{' '}
						{viewMode === 'open' ? 'tabs' : viewMode === 'starred' ? 'starred' : 'sessions'}
					</span>
					<span>{`↑↓ navigate • Enter select • ${formatShortcutKeys(['Meta'])}1-9 quick select`}</span>
				</div>
			</div>
		</div>
	);
}
