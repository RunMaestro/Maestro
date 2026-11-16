import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, X, Trash2, Download, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Theme } from '../types';
import { blendColors, readableTextOn, transparentize } from '../../shared/colorContrast';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { useDebouncedValue, useThrottledCallback } from '../hooks';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { usePhoneLayout } from '../hooks/ui/useViewportBreakpoint';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { safeClipboardWrite } from '../utils/clipboard';
import { ConfirmModal } from './ConfirmModal';
import { EscCloseButton } from './ui/EscCloseButton';
import { useSettingsStore } from '../stores/settingsStore';
import { logger } from '../utils/logger';
import { fileTimestampSlug } from '../../shared/formatters';
import {
	isFileLogSource,
	LOG_SOURCE_IDS,
	LOG_SOURCES,
	type FileLogSourceId,
	type LogSourceId,
} from '../../shared/logSources';
import { useLogFileSources } from '../hooks/utils/useLogFileSources';
import { downloadBlobToClient } from '../utils/clientDownload';
import {
	buildSystemLogKeys,
	buildSystemLogTimeline,
	systemLogEntryMatches,
} from '../utils/systemLogView';
import { LogViewerEntryRow, type LogLevelColor, type SystemLogEntry } from './LogViewerEntryRow';

/** How long typing pauses before the list is filtered again. */
const SEARCH_DEBOUNCE_MS = 120;
/** A card's height before it is measured: one line of message, no details. */
const ESTIMATED_ROW_HEIGHT = 86;

/** One entry as text, the same for Export and Copy. */
function formatLogEntryText(log: SystemLogEntry): string {
	const timestamp = new Date(log.timestamp).toISOString();
	const contextStr = log.context ? `[${log.context}]` : '';
	const dataStr = log.data ? `\n${JSON.stringify(log.data, null, 2)}` : '';
	return `[${timestamp}] [${log.level.toUpperCase()}] ${contextStr} ${log.message}${dataStr}`;
}

interface LogViewerProps {
	theme: Theme;
	onClose: () => void;
	/** A source to make sure is on (Settings > Models > Open log passes `model-server`). */
	initialSource?: LogSourceId;
	logLevel?: string; // Current log level setting (debug, info, warn, error)
	savedSelectedLevels?: string[]; // Persisted filter selections
	onSelectedLevelsChange?: (levels: string[]) => void; // Callback to persist filter changes
	onShortcutUsed?: (shortcutId: string) => void; // Keyboard mastery tracking
	onSessionClick?: (sessionId: string, tabId?: string) => void; // Navigate to agent/tab when clicking agent pill
}

// Log level priority for determining which levels are enabled
const LOG_LEVEL_PRIORITY: Record<string, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

type LogLevel = SystemLogEntry['level'];

/**
 * Level colors are DERIVED from the active theme instead of living in a second
 * palette beside it. `warn` and `error` were already byte-identical to
 * `theme.colors.warning` / `theme.colors.error`, so the literals only bought a
 * copy that stops tracking the theme the moment the user picks a different one.
 * The three levels with no semantic slot of their own (toast, autorun, cue) are
 * mixed out of the slots that do exist, which keeps them distinguishable from
 * each other in every theme rather than pinning one purple, one orange, and one
 * teal onto a palette that may contain none of the three.
 */
function buildLogLevelColors(theme: Theme): Record<LogLevel, LogLevelColor> {
	const { colors } = theme;
	const fills: Record<LogLevel, string> = {
		debug: colors.textDim,
		info: colors.accent,
		warn: colors.warning,
		error: colors.error,
		// A notification reads as accent everywhere else in the app; lifting it
		// toward textMain keeps it in the accent family but apart from `info`.
		toast: blendColors(colors.accent, colors.textMain, 0.35),
		// Between warning and error: in flight, not yet a problem.
		autorun: blendColors(colors.warning, colors.error, 0.35),
		cue: colors.success,
	};

	const entries = Object.entries(fills) as [LogLevel, string][];
	return Object.fromEntries(
		entries.map(([level, fg]) => {
			const bg = transparentize(fg, colors.bgActivity, 0.15);
			return [level, { fg, bg, text: readableTextOn(fg, [bg]) }];
		})
	) as Record<LogLevel, LogLevelColor>;
}

export function LogViewer({
	theme,
	onClose,
	initialSource,
	logLevel = 'info',
	savedSelectedLevels,
	onSelectedLevelsChange,
	onShortcutUsed,
	onSessionClick,
}: LogViewerProps) {
	// Maestro's own entries, newest first.
	const [logs, setLogs] = useState<SystemLogEntry[]>([]);
	const [searchOpen, setSearchOpen] = useState(false);
	// Phone: a shorter title, no entry count, and a search button, since the
	// only way into search was Cmd+F and a phone has no keyboard to press it on.
	const phone = usePhoneLayout();
	const [searchQuery, setSearchQuery] = useState('');

	// Which logs are shown. Every source starts on, and their entries are
	// interleaved by time; a pill turns its source off (never the last one).
	const [sources, setSources] = useState<ReadonlySet<LogSourceId>>(() => new Set(LOG_SOURCE_IDS));
	// A deep link (`maestro-cli open logs --tab model-server`, a second Open log)
	// turns its source back on if it was off, in place.
	useEffect(() => {
		if (!initialSource) return;
		setSources((prev) => (prev.has(initialSource) ? prev : new Set([...prev, initialSource])));
	}, [initialSource]);
	const toggleSource = useCallback((id: LogSourceId) => {
		setSources((prev) => {
			if (prev.has(id) && prev.size === 1) return prev;
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);
	const fileSources = useMemo(
		() =>
			LOG_SOURCE_IDS.filter((id): id is FileLogSourceId => isFileLogSource(id) && sources.has(id)),
		[sources]
	);
	const fileLogs = useLogFileSources(fileSources);
	const showMaestro = sources.has('maestro');

	// Every shown source's entries, newest first. File lines are reversed into
	// that order before the stable sort, so lines with the same time keep theirs.
	const mergedLogs = useMemo<SystemLogEntry[]>(() => {
		const fileEntries = fileLogs.entries.slice().reverse();
		if (fileEntries.length === 0) return showMaestro ? logs : [];
		const merged: SystemLogEntry[] = showMaestro ? [...logs, ...fileEntries] : fileEntries;
		return merged.sort((a, b) => b.timestamp - a.timestamp);
	}, [logs, fileLogs.entries, showMaestro]);
	const truncatedSources = fileSources.filter((id) => fileLogs.reads[id]?.truncated);
	const failedSources = fileSources.filter((id) => fileLogs.errors[id]);

	// Determine which log levels are enabled based on current log level setting
	// Levels with priority >= current level are enabled
	const enabledLevels = new Set<'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun' | 'cue'>(
		(['debug', 'info', 'warn', 'error'] as const).filter(
			(level) => LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[logLevel]
		)
	);
	// Toast is always enabled (it's a special notification level)
	enabledLevels.add('toast');
	// Auto Run is always enabled (workflow tracking cannot be turned off)
	enabledLevels.add('autorun');
	// Cue is always enabled (event-driven automation tracking)
	enabledLevels.add('cue');
	// The CUE pill is drawn only while Maestro Cue is on: with the feature off
	// the engine logs nothing, so the pill would name a disabled feature.
	const maestroCueEnabled = useSettingsStore((s) => s.encoreFeatures?.maestroCue === true);

	// Initialize selectedLevels from saved settings if available
	const [selectedLevels, setSelectedLevelsState] = useState<
		Set<'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun' | 'cue'>
	>(() => {
		if (savedSelectedLevels && savedSelectedLevels.length > 0) {
			return new Set(
				savedSelectedLevels as ('debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun' | 'cue')[]
			);
		}
		return new Set(['debug', 'info', 'warn', 'error', 'toast', 'autorun', 'cue']);
	});

	// Wrapper to persist changes when selectedLevels changes
	const setSelectedLevels = useCallback(
		(
			updater:
				| Set<'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun' | 'cue'>
				| ((
						prev: Set<'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun' | 'cue'>
				  ) => Set<'debug' | 'info' | 'warn' | 'error' | 'toast' | 'autorun' | 'cue'>)
		) => {
			setSelectedLevelsState((prev) => {
				const newSet = typeof updater === 'function' ? updater(prev) : updater;
				// Persist to settings
				if (onSelectedLevelsChange) {
					onSelectedLevelsChange(Array.from(newSet));
				}
				return newSet;
			});
		},
		[onSelectedLevelsChange]
	);
	// Keyed by entry, not position: a new line at the top must not move the
	// expanded or copied state onto the card below it.
	const [expandedData, setExpandedData] = useState<ReadonlySet<string>>(new Set());
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	const [showClearConfirm, setShowClearConfirm] = useState(false);
	const [viewportPercent, setViewportPercent] = useState<number | null>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const scrollTargetRef = useRef<HTMLDivElement | null>(null);

	// Store onClose in ref to avoid re-registering layer when callback identity changes
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const toggleDataExpanded = useCallback((entryKey: string) => {
		setExpandedData((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(entryKey)) {
				newSet.delete(entryKey);
			} else {
				newSet.add(entryKey);
			}
			return newSet;
		});
	}, []);

	// Track the max log buffer for trimming real-time updates
	const [maxLogBuffer, setMaxLogBuffer] = useState(1000);

	// Load logs on mount and subscribe to new logs
	useEffect(() => {
		// Get max buffer setting first, then load logs
		window.maestro.logger.getMaxLogBuffer().then((max) => {
			setMaxLogBuffer(max || 1000);
			loadLogs();
		});

		// Subscribe to new log entries
		const unsubscribe = window.maestro.logger.onNewLog((newLog: SystemLogEntry) => {
			setLogs((prevLogs) => {
				// Add new log at the beginning (newest first)
				const updated = [newLog, ...prevLogs];
				// Trim to max buffer size (main process also trims, but keep UI in sync)
				return updated.slice(0, maxLogBuffer);
			});
		});

		return () => {
			unsubscribe();
		};
	}, [maxLogBuffer]);

	// Filtering waits for a pause in typing, so each keystroke does not walk the
	// whole buffer. Clearing the query applies at once.
	const debouncedQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);
	const activeQuery = searchQuery.trim() === '' ? '' : debouncedQuery.trim().toLowerCase();

	const filteredLogs = useMemo(
		() =>
			mergedLogs.filter(
				(log) => selectedLevels.has(log.level) && systemLogEntryMatches(log, activeQuery)
			),
		[mergedLogs, activeQuery, selectedLevels]
	);
	const entryKeys = useMemo(() => buildSystemLogKeys(filteredLogs), [filteredLogs]);

	// Keys of every shown entry that has details to expand
	const expandableKeys = useMemo(
		() => entryKeys.filter((_, index) => !!filteredLogs[index].data),
		[entryKeys, filteredLogs]
	);
	const expandAll = () => setExpandedData(new Set(expandableKeys));
	const collapseAll = () => setExpandedData(new Set());
	const allExpanded =
		expandableKeys.length > 0 && expandableKeys.every((key) => expandedData.has(key));
	const allCollapsed = expandedData.size === 0;

	// Register layer on mount
	// Note: Using 'modal' type because LogViewer blocks all shortcuts (like the original modalOpen check)
	useModalLayer(
		MODAL_PRIORITIES.LOG_VIEWER,
		'System Log Viewer',
		() => {
			if (searchOpen) {
				setSearchOpen(false);
				setSearchQuery('');
				containerRef.current?.focus();
			} else {
				onCloseRef.current();
			}
		},
		{ focusTrap: 'lenient' }
	);

	// Auto-focus container on mount for keyboard navigation
	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	// Tick every 5s so relative timestamps ("10s ago", "5m ago") stay fresh
	// without recomputing every render. 5s is finer than the smallest displayed
	// unit (seconds), so the label can't drift by more than that interval.
	const [relativeTick, setRelativeTick] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setRelativeTick((t) => t + 1), 5000);
		return () => window.clearInterval(id);
	}, []);

	// Focus search input when opened
	useEffect(() => {
		if (searchOpen) {
			searchInputRef.current?.focus();
		}
	}, [searchOpen]);

	const loadLogs = async () => {
		try {
			// Get the configured max log buffer size, default to 1000 if not set
			const maxBuffer = (await window.maestro.logger.getMaxLogBuffer()) || 1000;
			const systemLogs = await window.maestro.logger.getLogs({ limit: maxBuffer });
			// Reverse to show newest first
			setLogs(systemLogs.reverse());
		} catch (error) {
			logger.error('Failed to load logs:', undefined, error);
		}
	};

	const handleClearLogs = async () => {
		try {
			await window.maestro.logger.clearLogs();
			setLogs([]);
		} catch (error) {
			logger.error('Failed to clear logs:', undefined, error);
		}
	};

	const handleExportLogs = () => {
		const logsText = filteredLogs.map(formatLogEntryText).join('\n\n');
		downloadBlobToClient(
			new Blob([logsText], { type: 'text/plain' }),
			`maestro-logs-${fileTimestampSlug()}.txt`
		);
	};

	const handleCopyEntry = useCallback(async (log: SystemLogEntry, entryKey: string) => {
		const ok = await safeClipboardWrite(formatLogEntryText(log));
		if (ok) {
			setCopiedKey(entryKey);
			setTimeout(() => setCopiedKey((current) => (current === entryKey ? null : current)), 2000);
		}
	}, []);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Open search with Cmd+F
		if (
			e.key === 'f' &&
			(e.metaKey || e.ctrlKey) &&
			!searchOpen &&
			document.activeElement !== searchInputRef.current
		) {
			e.preventDefault();
			setSearchOpen(true);
			onShortcutUsed?.('searchLogs');
		}
		// Jump to top/bottom with Cmd+Up/Down
		else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp' && !searchOpen) {
			e.preventDefault();
			containerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
		} else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown' && !searchOpen) {
			e.preventDefault();
			containerRef.current?.scrollTo({
				top: containerRef.current.scrollHeight,
				behavior: 'smooth',
			});
		}
		// Page up/down with Opt+Up/Down
		else if (e.altKey && e.key === 'ArrowUp' && !searchOpen) {
			e.preventDefault();
			const container = containerRef.current;
			if (container) {
				container.scrollBy({ top: -container.clientHeight * 0.8, behavior: 'smooth' });
			}
		} else if (e.altKey && e.key === 'ArrowDown' && !searchOpen) {
			e.preventDefault();
			const container = containerRef.current;
			if (container) {
				container.scrollBy({ top: container.clientHeight * 0.8, behavior: 'smooth' });
			}
		}
		// Scroll with plain arrow keys (only when search is not open)
		else if (e.key === 'ArrowUp' && !searchOpen) {
			e.preventDefault();
			containerRef.current?.scrollBy({ top: -100, behavior: 'smooth' });
		} else if (e.key === 'ArrowDown' && !searchOpen) {
			e.preventDefault();
			containerRef.current?.scrollBy({ top: 100, behavior: 'smooth' });
		}
	};

	// Track scroll position for the viewport indicator on the timeline bar
	const handleScrollInner = useCallback(() => {
		const target = scrollTargetRef.current;
		if (!target) return;
		const maxScroll = target.scrollHeight - target.clientHeight;
		if (maxScroll <= 0) {
			setViewportPercent(null);
			return;
		}
		const percent = (target.scrollTop / maxScroll) * 100;
		// Hide indicator when fully at top or bottom
		if (target.scrollTop < 10) {
			setViewportPercent(null);
		} else {
			setViewportPercent(Math.max(0, Math.min(100, percent)));
		}
	}, []);

	const throttledScrollHandler = useThrottledCallback(handleScrollInner, 16);

	const handleScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			scrollTargetRef.current = e.currentTarget;
			throttledScrollHandler();
		},
		[throttledScrollHandler]
	);

	// The timeline strip, in the order the list draws its entries.
	const timelineSegments = useMemo(
		() => buildSystemLogTimeline(filteredLogs, entryKeys),
		[filteredLogs, entryKeys]
	);

	// Only the cards on screen are in the DOM. The buffer holds thousands of
	// entries once a file source is interleaved, and drawing them all made
	// filtering and scrolling slow.
	const virtualizer = useVirtualizer({
		count: filteredLogs.length,
		getScrollElement: () => containerRef.current,
		estimateSize: () => ESTIMATED_ROW_HEIGHT,
		// The measurement cache follows the entry, not its slot, so a new line at
		// the top does not hand its height to every card below it.
		getItemKey: (index) => entryKeys[index] ?? index,
		overscan: 8,
	});

	const levelColors = useMemo(() => buildLogLevelColors(theme), [theme]);
	const getLevelColor = (level: string) =>
		levelColors[level as LogLevel]?.fg ?? theme.colors.textDim;
	/** Label for a chip filled with `fill`, so a pale warning keeps a dark label. */
	const onFillTextColor = (fill: string) => readableTextOn(theme.colors.accentForeground, [fill]);

	return (
		<div
			className="flex flex-col h-full"
			onKeyDown={handleKeyDown}
			role="dialog"
			aria-modal="true"
			aria-label="System Log Viewer"
			tabIndex={-1}
		>
			{/* Header */}
			<div
				className="px-4 border-b flex items-center justify-between sticky top-0 z-10 h-16 shrink-0"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-3 min-w-0">
					<h2
						className={`font-bold whitespace-nowrap truncate ${phone ? 'text-base' : 'text-lg'}`}
						style={{ color: theme.colors.textMain }}
					>
						{phone ? 'System Logs' : 'Maestro System Logs'}
					</h2>
					{!phone && (
						<span
							className="text-xs opacity-50 whitespace-nowrap"
							style={{ color: theme.colors.textDim }}
						>
							{`${filteredLogs.length} ${filteredLogs.length === 1 ? 'entry' : 'entries'}`}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<button
						onClick={() => setSearchOpen(true)}
						className="p-2 rounded row-hover transition-all"
						style={{ color: searchOpen ? theme.colors.accent : theme.colors.textDim }}
						title={`Search logs (${formatShortcutKeys(['Meta', 'f'])})`}
						aria-label="Search logs"
						disabled={searchOpen}
					>
						<Search className="w-4 h-4" />
					</button>
					{/* Expand/Collapse All buttons */}
					{expandableKeys.length > 0 && (
						<>
							<button
								onClick={expandAll}
								className="p-2 rounded row-hover transition-all"
								style={{ color: allExpanded ? theme.colors.accent : theme.colors.textDim }}
								title="Expand all"
								disabled={allExpanded}
							>
								<ChevronsUpDown className="w-4 h-4" />
							</button>
							<button
								onClick={collapseAll}
								className="p-2 rounded row-hover transition-all"
								style={{ color: allCollapsed ? theme.colors.textDim : theme.colors.accent }}
								title="Collapse all"
								disabled={allCollapsed}
							>
								<ChevronsDownUp className="w-4 h-4" />
							</button>
							<div className="w-px h-4 mx-1" style={{ backgroundColor: theme.colors.border }} />
						</>
					)}
					<button
						onClick={handleExportLogs}
						className="p-2 rounded row-hover transition-all"
						style={{ color: theme.colors.textDim }}
						title="Export logs"
					>
						<Download className="w-4 h-4" />
					</button>
					{/* Clears Maestro's own log; a supervised process's file is never truncated from here. */}
					{showMaestro && (
						<button
							onClick={() => setShowClearConfirm(true)}
							className="p-2 rounded row-hover transition-all"
							style={{ color: theme.colors.textDim }}
							title="Clear logs"
						>
							<Trash2 className="w-4 h-4" />
						</button>
					)}
					<button
						onClick={onClose}
						className="p-2 rounded row-hover transition-all"
						style={{ color: theme.colors.textDim }}
						title="Close log viewer"
					>
						<X className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Level Filters */}
			<div
				className="px-4 py-2 border-b flex items-center gap-2 overflow-x-auto no-scrollbar"
				style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
			>
				<span
					className="text-xs font-bold opacity-70 uppercase mr-2 shrink-0"
					style={{ color: theme.colors.textDim }}
				>
					Source:
				</span>
				{LOG_SOURCES.map((entry) => {
					const isSelected = sources.has(entry.id);
					const isLast = isSelected && sources.size === 1;
					const path = isFileLogSource(entry.id) ? fileLogs.reads[entry.id]?.path : undefined;
					return (
						<button
							key={entry.id}
							onClick={() => toggleSource(entry.id)}
							className="px-3 py-1 rounded text-xs font-bold transition-all shrink-0 whitespace-nowrap uppercase"
							style={{
								backgroundColor: isSelected ? theme.colors.accent : 'transparent',
								color: isSelected ? onFillTextColor(theme.colors.accent) : theme.colors.textDim,
								border: `1px solid ${isSelected ? theme.colors.accent : theme.colors.border}`,
							}}
							title={[entry.description, path, isLast ? 'At least one source stays on.' : undefined]
								.filter(Boolean)
								.join('\n')}
							aria-pressed={isSelected}
							data-testid={`log-source-${entry.id}`}
						>
							{entry.label}
						</button>
					);
				})}
				<div className="w-px h-4 mx-2 shrink-0" style={{ backgroundColor: theme.colors.border }} />
				<span
					className="text-xs font-bold opacity-70 uppercase mr-2 shrink-0"
					style={{ color: theme.colors.textDim }}
				>
					Filter:
				</span>
				{/* All button - toggles only enabled levels on/off */}
				<button
					onClick={() => {
						// Only toggle enabled levels
						const enabledLevelArray = Array.from(enabledLevels);
						// Check if all enabled levels are currently selected
						const allEnabledSelected = enabledLevelArray.every((level) =>
							selectedLevels.has(level)
						);
						if (allEnabledSelected) {
							// Turn off all enabled levels
							setSelectedLevels((prev) => {
								const newSet = new Set(prev);
								enabledLevelArray.forEach((level) => newSet.delete(level));
								return newSet;
							});
						} else {
							// Turn on all enabled levels
							setSelectedLevels((prev) => {
								const newSet = new Set(prev);
								enabledLevelArray.forEach((level) => newSet.add(level));
								return newSet;
							});
						}
					}}
					className="px-3 py-1 rounded text-xs font-bold transition-all shrink-0 whitespace-nowrap"
					style={{
						// ALL is highlighted when all enabled levels are selected
						backgroundColor: Array.from(enabledLevels).every((level) => selectedLevels.has(level))
							? theme.colors.accent
							: 'transparent',
						color: Array.from(enabledLevels).every((level) => selectedLevels.has(level))
							? onFillTextColor(theme.colors.accent)
							: theme.colors.textDim,
						border: `1px solid ${Array.from(enabledLevels).every((level) => selectedLevels.has(level)) ? theme.colors.accent : theme.colors.border}`,
					}}
				>
					ALL
				</button>
				{/* Individual level toggle buttons */}
				{(['debug', 'info', 'warn', 'error', 'toast', 'autorun', 'cue'] as const).map((level) => {
					if (level === 'cue' && !maestroCueEnabled) return null;
					const isSelected = selectedLevels.has(level);
					const isEnabled = enabledLevels.has(level);
					return (
						<button
							key={level}
							disabled={!isEnabled}
							onClick={() => {
								if (!isEnabled) return; // Safety check
								setSelectedLevels((prev) => {
									const newSet = new Set(prev);
									if (newSet.has(level)) {
										newSet.delete(level);
									} else {
										newSet.add(level);
									}
									return newSet;
								});
							}}
							className="px-3 py-1 rounded text-xs font-bold transition-all shrink-0 whitespace-nowrap"
							style={{
								backgroundColor: isEnabled && isSelected ? getLevelColor(level) : 'transparent',
								color:
									isEnabled && isSelected
										? onFillTextColor(getLevelColor(level))
										: theme.colors.textDim,
								border: `1px solid ${isEnabled && isSelected ? getLevelColor(level) : theme.colors.border}`,
								opacity: isEnabled ? 1 : 0.3,
								cursor: isEnabled ? 'pointer' : 'not-allowed',
							}}
							title={
								isEnabled
									? undefined
									: `${level} level is disabled (current log level: ${logLevel})`
							}
						>
							{level.toUpperCase()}
						</button>
					);
				})}
			</div>

			{/* Visual Log History Timeline */}
			<div className="sticky top-0 z-10 pt-2 px-4" style={{ backgroundColor: theme.colors.bgMain }}>
				<div className="flex h-2 w-full mb-2 rounded-sm overflow-hidden relative">
					{/* Viewport position indicator */}
					{viewportPercent !== null && (
						<div
							className="absolute top-0 bottom-0 pointer-events-none z-20"
							style={{
								left: `${viewportPercent}%`,
								width: '2px',
								backgroundColor: theme.colors.error,
								transition: 'left 0.15s ease-out',
							}}
						/>
					)}
					{timelineSegments.map((segment) => (
						<div
							key={segment.key}
							className="hover:opacity-70 cursor-pointer"
							style={{
								flex: `${segment.count} 1 0`,
								backgroundColor: getLevelColor(segment.level),
								minWidth: '1px',
							}}
							title={segment.title}
							onClick={() => virtualizer.scrollToIndex(segment.startIndex, { align: 'start' })}
						/>
					))}
				</div>
			</div>

			{/* Search Bar */}
			{searchOpen && (
				<div
					className="px-4 py-2 border-b flex items-center gap-3"
					style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
				>
					<Search className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					<input
						ref={searchInputRef}
						type="text"
						className="flex-1 bg-transparent outline-none text-sm"
						placeholder="Search logs..."
						style={{ color: theme.colors.textMain }}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
					/>
					<EscCloseButton
						theme={theme}
						label="Close search (Esc)"
						onClose={() => {
							setSearchOpen(false);
							setSearchQuery('');
						}}
					/>
				</div>
			)}

			{/* A source that could not be read; above the list so the virtual rows
			    keep the scroll container's own coordinates. */}
			{failedSources.length > 0 && (
				<div className="px-4 pt-2 space-y-1" style={{ backgroundColor: theme.colors.bgMain }}>
					{failedSources.map((id) => (
						<div
							key={`error-${id}`}
							className="text-xs"
							style={{ color: theme.colors.error }}
							data-testid={`log-source-error-${id}`}
						>
							The {id} log could not be read: {fileLogs.errors[id]}
						</div>
					))}
				</div>
			)}

			{/* Logs Container */}
			<div
				ref={containerRef}
				onScroll={handleScroll}
				className="flex-1 overflow-y-auto p-4 outline-none scrollbar-thin"
				tabIndex={-1}
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				{filteredLogs.length === 0 ? (
					<div className="text-center py-12 opacity-50" style={{ color: theme.colors.textDim }}>
						{mergedLogs.length === 0 ? 'No logs yet' : 'No logs match your filter'}
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
							const log = filteredLogs[virtualItem.index];
							const entryKey = entryKeys[virtualItem.index];
							if (!log || entryKey === undefined) return null;
							return (
								<div
									key={entryKey}
									data-index={virtualItem.index}
									ref={virtualizer.measureElement}
									className="pb-2"
									style={{
										position: 'absolute',
										top: 0,
										left: 0,
										width: '100%',
										transform: `translateY(${virtualItem.start}px)`,
									}}
								>
									<LogViewerEntryRow
										log={log}
										entryKey={entryKey}
										theme={theme}
										levelColor={levelColors[log.level]}
										cueColor={levelColors.cue.fg}
										expanded={expandedData.has(entryKey)}
										copied={copiedKey === entryKey}
										relativeTick={relativeTick}
										onToggleExpanded={toggleDataExpanded}
										onCopy={handleCopyEntry}
										onSessionClick={onSessionClick}
									/>
								</div>
							);
						})}
					</div>
				)}
				{/* The list runs newest first, so the cut-off older part is at the bottom. */}
				{truncatedSources.map((id) => (
					<div
						key={`truncated-${id}`}
						className="text-xs text-center opacity-60"
						style={{ color: theme.colors.textDim }}
						data-testid={`log-source-truncated-${id}`}
					>
						Older {id} lines are not shown.
					</div>
				))}
			</div>

			{/* Footer hint */}
			{!searchOpen && (
				<div
					className="px-4 py-2 border-t flex items-center justify-center text-xs opacity-50"
					data-shortcut-hint=""
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					Press{' '}
					<kbd
						className="px-1.5 py-0.5 rounded mx-1 font-bold"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						{formatShortcutKeys(['Meta', 'f'])}
					</kbd>{' '}
					to search
				</div>
			)}

			{/* Clear Logs Confirmation Modal */}
			{showClearConfirm && (
				<ConfirmModal
					theme={theme}
					message="Are you sure you want to clear all Maestro system logs? This action cannot be undone."
					onConfirm={handleClearLogs}
					onClose={() => setShowClearConfirm(false)}
				/>
			)}
		</div>
	);
}
