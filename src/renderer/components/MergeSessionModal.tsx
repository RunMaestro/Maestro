/**
 * MergeSessionModal - Modal for merging current context into another session
 *
 * Allows users to select a target session/tab to merge the current context into.
 * The flow is: 1) Select target session, 2) Select target tab within that session.
 *
 * Supports two modes:
 * - Paste ID: Paste a session or tab ID directly
 * - Open Tabs: Fuzzy search across all open tabs in all agents
 *
 * Features:
 * - Real-time token estimation for merged context
 * - AI-powered context cleaning option
 * - Keyboard navigation with arrow keys, Enter, Tab
 */

import React, { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { Search, ChevronRight, ChevronDown, GitMerge, Clipboard, Check, X } from 'lucide-react';
import type { Theme, Session, AITab } from '../types';
import type { MergeResult } from '../types/contextMerge';
import { fuzzyMatchWithScore } from '../utils/search';
import { useLayerStack } from '../contexts/LayerStackContext';
import { useListNavigation } from '../hooks';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { formatTokensCompact } from '../utils/formatters';
import { ScreenReaderAnnouncement, useAnnouncement } from './Wizard/ScreenReaderAnnouncement';

/**
 * View modes for the modal
 */
type ViewMode = 'paste' | 'search';

/**
 * Merge options that can be configured by the user
 */
export interface MergeOptions {
	/** Create a new session instead of merging into current */
	createNewSession: boolean;
	/** Use AI to groom/deduplicate context before merging */
	groomContext: boolean;
	/** Preserve original timestamps in merged logs */
	preserveTimestamps: boolean;
}

/**
 * Item in the session/tab list (for navigation and selection)
 */
interface SessionListItem {
	type: 'session' | 'tab';
	sessionId: string;
	tabId?: string;
	sessionName: string;
	tabName?: string;
	agentSessionId?: string;
	estimatedTokens: number;
	lastActivity?: number;
}

export interface MergeSessionModalProps {
	theme: Theme;
	isOpen: boolean;
	/** The session containing the source context */
	sourceSession: Session;
	/** The specific tab ID within the source session */
	sourceTabId: string;
	/** All available sessions to merge with */
	allSessions: Session[];
	/** Callback when modal is closed */
	onClose: () => void;
	/** Callback when merge is initiated */
	onMerge: (
		targetSessionId: string,
		targetTabId: string | undefined,
		options: MergeOptions
	) => Promise<MergeResult>;
}

/**
 * Estimate token count from log entries
 * Uses a simple heuristic: ~4 characters per token (average for English text)
 */
function estimateTokens(logs: { text: string }[]): number {
	const totalChars = logs.reduce((sum, log) => sum + (log.text?.length || 0), 0);
	return Math.round(totalChars / 4);
}

/**
 * Animated token display component that highlights when value changes
 */
const AnimatedTokenCount = memo(
	({
		tokens,
		accentColor,
		textColor,
		prefix = '~',
	}: {
		tokens: number;
		accentColor: string;
		textColor: string;
		prefix?: string;
	}) => {
		const [animating, setAnimating] = useState(false);
		const prevTokensRef = useRef(tokens);

		useEffect(() => {
			if (prevTokensRef.current !== tokens && prevTokensRef.current !== 0) {
				setAnimating(true);
				const timer = setTimeout(() => setAnimating(false), 400);
				prevTokensRef.current = tokens;
				return () => clearTimeout(timer);
			}
			prevTokensRef.current = tokens;
		}, [tokens]);

		return (
			<span
				className={animating ? 'animate-token-update' : ''}
				style={
					{
						color: textColor,
						'--token-highlight': accentColor,
						display: 'inline-block',
					} as React.CSSProperties
				}
			>
				{prefix}
				{formatTokensCompact(tokens)} tokens
			</span>
		);
	}
);

/**
 * Get display name for a session
 */
function getSessionDisplayName(session: Session): string {
	return session.name || session.projectRoot.split('/').pop() || 'Unnamed Session';
}

/**
 * Get display name for a tab
 */
function getTabDisplayName(tab: AITab): string {
	if (tab.name) return tab.name;
	if (tab.agentSessionId) {
		return tab.agentSessionId.split('-')[0].toUpperCase();
	}
	return 'New Tab';
}

/**
 * MergeSessionModal Component
 */
export function MergeSessionModal({
	theme,
	isOpen,
	sourceSession,
	sourceTabId,
	allSessions,
	onClose,
	onMerge,
}: MergeSessionModalProps) {
	// View mode state
	const [viewMode, setViewMode] = useState<ViewMode>('search');

	// Search state
	const [searchQuery, setSearchQuery] = useState('');

	// Paste ID state
	const [pastedId, setPastedId] = useState('');
	const [pastedIdValid, setPastedIdValid] = useState<boolean | null>(null);
	const [pastedIdMatch, setPastedIdMatch] = useState<SessionListItem | null>(null);

	// Expanded sessions in tree view
	const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

	// Merge options
	const [options, setOptions] = useState<MergeOptions>({
		createNewSession: false,
		groomContext: true,
		preserveTimestamps: true,
	});

	// Selected target for merge
	const [selectedTarget, setSelectedTarget] = useState<SessionListItem | null>(null);

	// Merge state
	const [isMerging, setIsMerging] = useState(false);

	// Screen reader announcements
	const { announce, announcementProps } = useAnnouncement();

	// Refs
	const inputRef = useRef<HTMLInputElement>(null);
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const selectedItemRef = useRef<HTMLButtonElement>(null);

	// Keep onClose ref up to date
	useEffect(() => {
		onCloseRef.current = onClose;
	});

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

	// Register layer on mount
	useEffect(() => {
		if (!isOpen) return;

		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.MERGE_SESSION,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Merge Session Contexts',
			onEscape: () => onCloseRef.current(),
		});

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [isOpen, registerLayer, unregisterLayer]);

	// Update handler when onClose changes
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => onCloseRef.current());
		}
	}, [updateLayerHandler]);

	// Focus input on mount
	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => inputRef.current?.focus(), 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen]);

	// Get source tab info
	const sourceTab = useMemo(() => {
		return sourceSession.aiTabs.find((t) => t.id === sourceTabId);
	}, [sourceSession, sourceTabId]);

	const sourceTokens = useMemo(() => {
		if (!sourceTab) return 0;
		return estimateTokens(sourceTab.logs);
	}, [sourceTab]);

	// Build flat list of sessions and tabs for navigation
	const allItems = useMemo((): SessionListItem[] => {
		const items: SessionListItem[] = [];

		// Build a map of session IDs to names for parent lookups
		const sessionNameMap = new Map<string, string>();
		for (const session of allSessions) {
			sessionNameMap.set(session.id, getSessionDisplayName(session));
		}

		for (const session of allSessions) {
			// Add session tabs (if it has tabs)
			if (session.aiTabs.length > 0) {
				// Build display name - prefix worktree children with parent name
				let displayName = getSessionDisplayName(session);
				if (session.parentSessionId) {
					const parentName = sessionNameMap.get(session.parentSessionId);
					if (parentName) {
						displayName = `${parentName}: ${displayName}`;
					}
				}

				for (const tab of session.aiTabs) {
					// Skip the source tab itself (but allow other tabs in same session)
					if (session.id === sourceSession.id && tab.id === sourceTabId) continue;

					items.push({
						type: 'tab',
						sessionId: session.id,
						tabId: tab.id,
						sessionName: displayName,
						tabName: getTabDisplayName(tab),
						agentSessionId: tab.agentSessionId || undefined,
						estimatedTokens: estimateTokens(tab.logs),
						lastActivity:
							tab.logs.length > 0 ? Math.max(...tab.logs.map((l) => l.timestamp)) : tab.createdAt,
					});
				}
			}
		}

		// Sort alphabetically by session name, then by tab name
		items.sort((a, b) => {
			const sessionCompare = a.sessionName.localeCompare(b.sessionName);
			if (sessionCompare !== 0) return sessionCompare;
			return (a.tabName || '').localeCompare(b.tabName || '');
		});

		return items;
	}, [allSessions, sourceSession.id, sourceTabId]);

	// Filter items based on search query
	const filteredItems = useMemo((): SessionListItem[] => {
		if (!searchQuery.trim()) {
			return allItems;
		}

		const query = searchQuery.trim();
		return allItems
			.map((item) => {
				const searchText = `${item.sessionName} ${item.tabName || ''} ${item.agentSessionId || ''}`;
				const result = fuzzyMatchWithScore(searchText, query);
				return { item, score: result.score };
			})
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.item);
	}, [allItems, searchQuery]);

	// Group filtered items by session for tree display
	const groupedItems = useMemo(() => {
		const groups: Map<string, SessionListItem[]> = new Map();

		for (const item of filteredItems) {
			const existing = groups.get(item.sessionId);
			if (existing) {
				existing.push(item);
			} else {
				groups.set(item.sessionId, [item]);
			}
		}

		return groups;
	}, [filteredItems]);

	// Validate pasted ID
	useEffect(() => {
		if (!pastedId.trim()) {
			setPastedIdValid(null);
			setPastedIdMatch(null);
			return;
		}

		const trimmedId = pastedId.trim();

		// Search for matching session or tab
		const match = allItems.find(
			(item) =>
				item.tabId === trimmedId ||
				item.agentSessionId === trimmedId ||
				item.sessionId === trimmedId
		);

		if (match) {
			setPastedIdValid(true);
			setPastedIdMatch(match);
		} else {
			setPastedIdValid(false);
			setPastedIdMatch(null);
		}
	}, [pastedId, allItems]);

	// Handle item selection
	const handleSelectItem = useCallback((item: SessionListItem) => {
		setSelectedTarget(item);
	}, []);

	// Handle selection by index (for keyboard navigation)
	const handleSelectByIndex = useCallback(
		(index: number) => {
			const item = filteredItems[index];
			if (item) {
				handleSelectItem(item);
			}
		},
		[filteredItems, handleSelectItem]
	);

	// List navigation hook
	const {
		selectedIndex,
		handleKeyDown: listKeyDown,
		setSelectedIndex,
	} = useListNavigation({
		listLength: filteredItems.length,
		onSelect: handleSelectByIndex,
		enableNumberHotkeys: false,
	});

	// Scroll selected item into view
	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
	}, [selectedIndex]);

	// Reset selection when filter changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [searchQuery, viewMode, setSelectedIndex]);

	// Announce search results to screen readers
	useEffect(() => {
		if (viewMode === 'search' && isOpen) {
			const sessionCount = groupedItems.size;
			const tabCount = filteredItems.length;
			if (searchQuery) {
				announce(
					`Found ${tabCount} tab${tabCount !== 1 ? 's' : ''} across ${sessionCount} session${sessionCount !== 1 ? 's' : ''}`
				);
			} else if (tabCount > 0) {
				announce(
					`${tabCount} tab${tabCount !== 1 ? 's' : ''} available across ${sessionCount} session${sessionCount !== 1 ? 's' : ''}`
				);
			}
		}
	}, [viewMode, filteredItems.length, groupedItems.size, searchQuery, isOpen, announce]);

	// Announce target selection
	useEffect(() => {
		if (selectedTarget) {
			announce(
				`Selected: ${selectedTarget.sessionName} - ${selectedTarget.tabName}, approximately ${formatTokensCompact(selectedTarget.estimatedTokens)} tokens`
			);
		}
	}, [selectedTarget, announce]);

	// Announce merge status
	useEffect(() => {
		if (isMerging) {
			announce('Merging contexts, please wait...', 'assertive');
		}
	}, [isMerging, announce]);

	// Toggle session expansion
	const toggleSession = useCallback((sessionId: string) => {
		setExpandedSessions((prev) => {
			const next = new Set(prev);
			if (next.has(sessionId)) {
				next.delete(sessionId);
			} else {
				next.add(sessionId);
			}
			return next;
		});
	}, []);

	// Handle merge action
	const handleMerge = useCallback(async () => {
		const target = viewMode === 'paste' ? pastedIdMatch : selectedTarget;
		if (!target) return;

		setIsMerging(true);
		try {
			await onMerge(target.sessionId, target.tabId, options);
			onClose();
		} catch (error) {
			console.error('Merge failed:', error);
		} finally {
			setIsMerging(false);
		}
	}, [viewMode, pastedIdMatch, selectedTarget, options, onMerge, onClose]);

	// Handle key down
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Tab to switch view modes
			if (e.key === 'Tab' && !e.shiftKey) {
				e.preventDefault();
				const modes: ViewMode[] = ['paste', 'search'];
				const currentIndex = modes.indexOf(viewMode);
				setViewMode(modes[(currentIndex + 1) % modes.length]);
				return;
			}

			// Shift+Tab to switch view modes backwards
			if (e.key === 'Tab' && e.shiftKey) {
				e.preventDefault();
				const modes: ViewMode[] = ['paste', 'search'];
				const currentIndex = modes.indexOf(viewMode);
				setViewMode(modes[(currentIndex - 1 + modes.length) % modes.length]);
				return;
			}

			// Cmd+V to switch to paste mode
			if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
				setViewMode('paste');
				return;
			}

			// Arrow left/right to expand/collapse in search mode
			if (viewMode === 'search') {
				if (e.key === 'ArrowRight' && filteredItems[selectedIndex]) {
					e.preventDefault();
					setExpandedSessions((prev) => new Set([...prev, filteredItems[selectedIndex].sessionId]));
					return;
				}
				if (e.key === 'ArrowLeft' && filteredItems[selectedIndex]) {
					e.preventDefault();
					setExpandedSessions((prev) => {
						const next = new Set(prev);
						next.delete(filteredItems[selectedIndex].sessionId);
						return next;
					});
					return;
				}
			}

			// Space to toggle selection
			if (e.key === ' ' && viewMode === 'search' && filteredItems[selectedIndex]) {
				e.preventDefault();
				handleSelectItem(filteredItems[selectedIndex]);
				return;
			}

			// Enter to confirm merge
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				if (viewMode === 'paste' && pastedIdValid && pastedIdMatch) {
					handleMerge();
				} else if (viewMode === 'search' && selectedTarget) {
					handleMerge();
				} else if (filteredItems[selectedIndex]) {
					handleSelectItem(filteredItems[selectedIndex]);
				}
				return;
			}

			// Delegate to list navigation
			listKeyDown(e);
		},
		[
			viewMode,
			filteredItems,
			selectedIndex,
			selectedTarget,
			pastedIdValid,
			pastedIdMatch,
			handleMerge,
			handleSelectItem,
			listKeyDown,
		]
	);

	// Calculate estimated merged size
	const estimatedMergedTokens = useMemo(() => {
		const target = viewMode === 'paste' ? pastedIdMatch : selectedTarget;
		if (!target) return sourceTokens;
		return sourceTokens + target.estimatedTokens;
	}, [viewMode, pastedIdMatch, selectedTarget, sourceTokens]);

	// Estimate tokens after grooming (rough 25-30% reduction)
	const estimatedGroomedTokens = useMemo(() => {
		if (!options.groomContext) return estimatedMergedTokens;
		return Math.round(estimatedMergedTokens * 0.73);
	}, [estimatedMergedTokens, options.groomContext]);

	// Determine if merge is possible
	const canMerge = useMemo(() => {
		if (isMerging) return false;
		if (viewMode === 'paste') return pastedIdValid && pastedIdMatch !== null;
		return selectedTarget !== null;
	}, [viewMode, pastedIdValid, pastedIdMatch, selectedTarget, isMerging]);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-start justify-center pt-16 z-[9999] animate-in"
			role="dialog"
			aria-modal="true"
			aria-labelledby="merge-modal-title"
			aria-describedby="merge-modal-description"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			{/* Screen reader announcements */}
			<ScreenReaderAnnouncement {...announcementProps} />

			<div
				className="w-[600px] rounded-xl shadow-2xl border outline-none flex flex-col animate-slide-up"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					maxHeight: 'calc(100vh - 128px)',
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div
					className="p-4 border-b flex items-center justify-between shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<GitMerge
							className="w-5 h-5"
							style={{ color: theme.colors.accent }}
							aria-hidden="true"
						/>
						<h2
							id="merge-modal-title"
							className="text-sm font-bold"
							style={{ color: theme.colors.textMain }}
						>
							Merge "{sourceTab ? getTabDisplayName(sourceTab) : 'Context'}" Into
						</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="p-1 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
						aria-label="Close merge dialog"
					>
						<X className="w-4 h-4" aria-hidden="true" />
					</button>
				</div>

				{/* Description for screen readers */}
				<p id="merge-modal-description" className="sr-only">
					Select a session and tab to merge your current context into. Use Tab to switch between
					Paste ID and Open Tabs modes. Use arrow keys to navigate the list.
				</p>

				{/* View Mode Tabs */}
				<div
					className="px-4 pt-3 pb-2 border-b flex gap-1"
					style={{ borderColor: theme.colors.border }}
					role="tablist"
					aria-label="Selection mode"
				>
					{[
						{ mode: 'paste' as ViewMode, label: 'Paste ID', icon: Clipboard },
						{ mode: 'search' as ViewMode, label: 'Open Tabs', icon: Search },
					].map(({ mode, label, icon: Icon }) => (
						<button
							key={mode}
							role="tab"
							aria-selected={viewMode === mode}
							aria-controls={`merge-tabpanel-${mode}`}
							onClick={() => setViewMode(mode)}
							className="px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors"
							style={{
								backgroundColor: viewMode === mode ? theme.colors.accent : 'transparent',
								color: viewMode === mode ? theme.colors.accentForeground : theme.colors.textDim,
							}}
						>
							<Icon className="w-3.5 h-3.5" aria-hidden="true" />
							{label}
						</button>
					))}
				</div>

				{/* Content Area */}
				<div className="flex-1 overflow-hidden flex flex-col min-h-0">
					{/* Paste ID View */}
					{viewMode === 'paste' && (
						<div
							id="merge-tabpanel-paste"
							role="tabpanel"
							aria-labelledby="merge-tab-paste"
							className="p-4 space-y-3"
						>
							<div className="relative">
								<label htmlFor="paste-id-input" className="sr-only">
									Session or tab ID
								</label>
								<input
									id="paste-id-input"
									ref={inputRef}
									type="text"
									placeholder="Paste session or tab ID..."
									value={pastedId}
									onChange={(e) => setPastedId(e.target.value)}
									aria-invalid={pastedIdValid === false}
									aria-describedby={pastedIdValid === false ? 'paste-id-error' : undefined}
									className="w-full px-3 py-2 rounded-lg border text-sm outline-none transition-colors"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor:
											pastedIdValid === false
												? theme.colors.error
												: pastedIdValid === true
													? theme.colors.success
													: theme.colors.border,
										color: theme.colors.textMain,
									}}
								/>
								{pastedIdValid !== null && (
									<div className="absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true">
										{pastedIdValid ? (
											<Check className="w-4 h-4" style={{ color: theme.colors.success }} />
										) : (
											<X className="w-4 h-4" style={{ color: theme.colors.error }} />
										)}
									</div>
								)}
							</div>

							{/* Match Preview */}
							{pastedIdMatch && (
								<div
									className="p-3 rounded-lg border"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.success,
									}}
									role="status"
									aria-live="polite"
								>
									<div className="flex items-center gap-2">
										<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
											{pastedIdMatch.sessionName}
										</div>
										{pastedIdMatch.tabName && (
											<>
												<ChevronRight
													className="w-3 h-3"
													style={{ color: theme.colors.textDim }}
													aria-hidden="true"
												/>
												<div className="text-sm" style={{ color: theme.colors.textDim }}>
													{pastedIdMatch.tabName}
												</div>
											</>
										)}
									</div>
									<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
										~{formatTokensCompact(pastedIdMatch.estimatedTokens)} tokens
									</div>
								</div>
							)}

							{pastedIdValid === false && pastedId.trim() && (
								<div
									id="paste-id-error"
									className="text-xs"
									style={{ color: theme.colors.error }}
									role="alert"
								>
									No matching session or tab found for this ID
								</div>
							)}
						</div>
					)}

					{/* Search Sessions View */}
					{viewMode === 'search' && (
						<div
							id="merge-tabpanel-search"
							role="tabpanel"
							aria-labelledby="merge-tab-search"
							className="flex flex-col min-h-0"
						>
							{/* Search Input */}
							<div className="p-4 pb-2">
								<div className="relative">
									<Search
										className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
										style={{ color: theme.colors.textDim }}
										aria-hidden="true"
									/>
									<label htmlFor="search-sessions-input" className="sr-only">
										Search sessions and tabs
									</label>
									<input
										id="search-sessions-input"
										ref={inputRef}
										type="text"
										placeholder="Search open tabs across all agents..."
										value={searchQuery}
										onChange={(e) => setSearchQuery(e.target.value)}
										aria-controls="session-list"
										className="w-full pl-9 pr-3 py-2 rounded-lg border text-sm outline-none"
										style={{
											backgroundColor: theme.colors.bgMain,
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
										}}
									/>
								</div>
							</div>

							{/* Session/Tab List */}
							<div
								id="session-list"
								ref={scrollContainerRef}
								className="flex-1 overflow-y-auto px-2 pb-2"
								role="listbox"
								aria-label="Available sessions and tabs"
							>
								{filteredItems.length === 0 ? (
									<div
										className="p-4 text-center text-sm"
										style={{ color: theme.colors.textDim }}
										role="status"
									>
										{searchQuery ? 'No matching sessions found' : 'No other sessions available'}
									</div>
								) : (
									Array.from(groupedItems.entries()).map(([sessionId, items]) => {
										const isExpanded = expandedSessions.has(sessionId) || searchQuery.trim() !== '';
										const sessionName = items[0].sessionName;

										return (
											<div
												key={sessionId}
												className="mb-1"
												role="group"
												aria-label={`Session: ${sessionName}`}
											>
												{/* Session Header */}
												<button
													onClick={() => toggleSession(sessionId)}
													className="w-full px-2 py-1.5 flex items-center gap-2 rounded hover:bg-white/5 transition-colors"
													aria-expanded={isExpanded}
													aria-controls={`session-tabs-${sessionId}`}
												>
													{isExpanded ? (
														<ChevronDown
															className="w-3.5 h-3.5"
															style={{ color: theme.colors.textDim }}
															aria-hidden="true"
														/>
													) : (
														<ChevronRight
															className="w-3.5 h-3.5"
															style={{ color: theme.colors.textDim }}
															aria-hidden="true"
														/>
													)}
													<span
														className="text-sm font-medium truncate"
														style={{ color: theme.colors.textMain }}
													>
														{sessionName}
													</span>
													<span className="text-xs ml-auto" style={{ color: theme.colors.textDim }}>
														{items.length} tab{items.length !== 1 ? 's' : ''}
													</span>
												</button>

												{/* Tabs */}
												{isExpanded && (
													<div
														id={`session-tabs-${sessionId}`}
														className="ml-4 border-l pl-2"
														style={{ borderColor: theme.colors.border }}
														role="group"
													>
														{items.map((item, _itemIndex) => {
															const flatIndex = filteredItems.indexOf(item);
															const isSelected = flatIndex === selectedIndex;
															const isTarget = selectedTarget?.tabId === item.tabId;

															return (
																<button
																	key={item.tabId}
																	ref={isSelected ? selectedItemRef : undefined}
																	onClick={() => handleSelectItem(item)}
																	role="option"
																	aria-selected={isTarget}
																	className={`w-full px-2 py-2 flex items-center gap-2 rounded text-left transition-all duration-150 ${isTarget ? 'animate-highlight-pulse' : ''}`}
																	style={
																		{
																			backgroundColor: isTarget
																				? theme.colors.accent
																				: isSelected
																					? `${theme.colors.accent}40`
																					: 'transparent',
																			color: isTarget
																				? theme.colors.accentForeground
																				: theme.colors.textMain,
																			'--pulse-color': `${theme.colors.accent}40`,
																		} as React.CSSProperties
																	}
																>
																	<div className="flex-1 min-w-0">
																		<div className="flex items-center gap-2">
																			{isTarget && (
																				<Check
																					className="w-3.5 h-3.5 shrink-0 animate-check-pop"
																					aria-hidden="true"
																				/>
																			)}
																			<span className="text-sm truncate">{item.tabName}</span>
																			{item.agentSessionId && (
																				<span
																					className="text-[10px] px-1 py-0.5 rounded font-mono"
																					style={{
																						backgroundColor: isTarget
																							? 'rgba(255,255,255,0.2)'
																							: theme.colors.bgActivity,
																						color: isTarget
																							? theme.colors.accentForeground
																							: theme.colors.textDim,
																					}}
																					aria-label={`Session ID: ${item.agentSessionId}`}
																				>
																					{item.agentSessionId.split('-')[0].toUpperCase()}
																				</span>
																			)}
																		</div>
																	</div>
																	<span
																		className="text-xs shrink-0"
																		style={{
																			color: isTarget
																				? theme.colors.accentForeground
																				: theme.colors.textDim,
																		}}
																		aria-label={`approximately ${formatTokensCompact(item.estimatedTokens)} tokens`}
																	>
																		~{formatTokensCompact(item.estimatedTokens)}
																	</span>
																</button>
															);
														})}
													</div>
												)}
											</div>
										);
									})
								)}
							</div>
						</div>
					)}
				</div>

				{/* Merge Preview & Options */}
				<div
					className="p-4 border-t space-y-3"
					style={{ borderColor: theme.colors.border }}
					role="region"
					aria-label="Merge preview and options"
				>
					{/* Token Preview */}
					<div
						className="p-3 rounded-lg text-xs space-y-1"
						style={{ backgroundColor: theme.colors.bgMain }}
						role="status"
						aria-live="polite"
						aria-label="Token estimate"
					>
						<div className="flex justify-between">
							<span style={{ color: theme.colors.textDim }}>
								Source: {sourceTab?.name || getTabDisplayName(sourceTab!)}
							</span>
							<span style={{ color: theme.colors.textMain }}>
								~{formatTokensCompact(sourceTokens)} tokens
							</span>
						</div>

						{(selectedTarget || (viewMode === 'paste' && pastedIdMatch)) && (
							<>
								<div className="flex justify-between">
									<span style={{ color: theme.colors.textDim }}>
										Target: {(viewMode === 'paste' ? pastedIdMatch : selectedTarget)?.tabName}
									</span>
									<span style={{ color: theme.colors.textMain }}>
										~
										{formatTokensCompact(
											(viewMode === 'paste' ? pastedIdMatch : selectedTarget)?.estimatedTokens || 0
										)}{' '}
										tokens
									</span>
								</div>

								<div
									className="border-t pt-1 mt-1 flex justify-between"
									style={{ borderColor: theme.colors.border }}
								>
									<span style={{ color: theme.colors.textMain }} className="font-medium">
										Estimated merged size:
									</span>
									<AnimatedTokenCount
										tokens={estimatedMergedTokens}
										accentColor={theme.colors.accent}
										textColor={theme.colors.textMain}
									/>
								</div>

								{options.groomContext && (
									<div className="flex justify-between">
										<span style={{ color: theme.colors.success }}>After cleaning:</span>
										<span style={{ color: theme.colors.success }}>
											~{formatTokensCompact(estimatedGroomedTokens)} tokens (estimated)
										</span>
									</div>
								)}
							</>
						)}
					</div>

					{/* Options */}
					<fieldset className="space-y-2">
						<legend className="sr-only">Merge options</legend>
						<label
							className="flex items-center gap-2 cursor-pointer"
							style={{ color: theme.colors.textMain }}
						>
							<input
								type="checkbox"
								checked={options.groomContext}
								onChange={(e) =>
									setOptions((prev) => ({ ...prev, groomContext: e.target.checked }))
								}
								className="rounded"
								aria-describedby="groom-context-desc"
							/>
							<span className="text-xs" id="groom-context-desc">
								Clean context (remove duplicates, reduce size)
							</span>
						</label>
					</fieldset>
				</div>

				{/* Footer */}
				<div
					className="p-4 border-t flex justify-end gap-2"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded text-sm border hover:bg-white/5 transition-colors"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleMerge}
						disabled={!canMerge}
						className="px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						{isMerging ? 'Merging...' : 'Merge Into'}
					</button>
				</div>
			</div>
		</div>
	);
}

export default MergeSessionModal;
