/**
 * SecurityEventsPanel
 *
 * Displays recent LLM Guard security events in a scrollable list.
 * Features:
 * - Real-time event updates via IPC subscription
 * - Filter by event type (input_scan, output_scan, blocked, warning)
 * - Expandable rows to show finding details
 * - Virtualized list for performance
 * - Clear button with confirmation
 */

import React, {
	useState,
	useEffect,
	useCallback,
	useRef,
	memo,
	forwardRef,
	useImperativeHandle,
} from 'react';
import {
	Shield,
	ShieldAlert,
	ShieldCheck,
	ShieldX,
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	Trash2,
	RefreshCw,
	ArrowDownToLine,
	ArrowUpFromLine,
	Eye,
	X,
	Download,
	FileJson,
	FileSpreadsheet,
	FileText,
	Calendar,
	Filter,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Theme } from '../types';
import type {
	SecurityEvent,
	SecurityEventsPage,
	ExportFormat,
	ExportFilterOptions,
} from '../../main/preload/security';
import { ConfirmModal } from './ConfirmModal';
import { SanitizedContentDiff } from './SanitizedContentDiff';
import type { Finding } from './FindingDetails';

// Event type filter options
type EventTypeFilter = 'all' | 'input_scan' | 'output_scan' | 'blocked' | 'warning';

// Estimated row heights for virtualization
const ESTIMATED_ROW_HEIGHT_COLLAPSED = 72;
const ESTIMATED_ROW_HEIGHT_EXPANDED = 180;
// Additional height when diff view is shown
const ESTIMATED_ROW_HEIGHT_WITH_DIFF = 450;

/**
 * Reconstructs content representation from findings for diff visualization.
 * Since we don't store the full original/sanitized content (for security/privacy),
 * we create a representative view showing context around each finding.
 *
 * @param findings - Array of security findings with positions and replacements
 * @param totalLength - The total length of the original content
 * @returns Reconstructed original and sanitized content strings
 */
const reconstructContentFromFindings = (
	findings: Finding[],
	totalLength: number
): { original: string; sanitized: string } => {
	if (findings.length === 0) {
		return { original: '', sanitized: '' };
	}

	// Sort findings by start position
	const sorted = [...findings].sort((a, b) => a.start - b.start);

	// Build original content by placing findings at their positions with placeholder chars
	// We use dots to represent unknown content between findings
	const parts: string[] = [];
	const sanitizedParts: string[] = [];
	let lastEnd = 0;

	for (const finding of sorted) {
		// Add placeholder for gap (if there's content between findings)
		if (finding.start > lastEnd) {
			const gapSize = Math.min(finding.start - lastEnd, 20); // Cap gap representation
			const gap = gapSize > 10 ? '... ' : '';
			parts.push(gap);
			sanitizedParts.push(gap);
		}

		// Add the finding's original value
		parts.push(finding.value);

		// Add the replacement (or original if no replacement)
		sanitizedParts.push(finding.replacement || finding.value);

		lastEnd = finding.end;
	}

	// Add trailing placeholder if there's more content after the last finding
	if (lastEnd < totalLength) {
		const remaining = totalLength - lastEnd;
		if (remaining > 10) {
			parts.push(' ...');
			sanitizedParts.push(' ...');
		}
	}

	return {
		original: parts.join(''),
		sanitized: sanitizedParts.join(''),
	};
};

interface SecurityEventsPanelProps {
	theme: Theme;
	/** Callback when an event references a session - could be used to navigate */
	onJumpToSession?: (sessionId: string) => void;
}

export interface SecurityEventsPanelHandle {
	focus: () => void;
	refresh: () => void;
}

// Get icon for event type
const getEventIcon = (eventType: SecurityEvent['eventType']) => {
	switch (eventType) {
		case 'input_scan':
			return ArrowDownToLine;
		case 'output_scan':
			return ArrowUpFromLine;
		case 'blocked':
			return ShieldX;
		case 'warning':
			return ShieldAlert;
		default:
			return Shield;
	}
};

// Get colors for event type
const getEventColors = (eventType: SecurityEvent['eventType'], theme: Theme) => {
	switch (eventType) {
		case 'blocked':
			return {
				bg: theme.colors.error + '20',
				text: theme.colors.error,
				border: theme.colors.error + '40',
			};
		case 'warning':
			return {
				bg: theme.colors.warning + '20',
				text: theme.colors.warning,
				border: theme.colors.warning + '40',
			};
		case 'input_scan':
			return {
				bg: theme.colors.accent + '20',
				text: theme.colors.accent,
				border: theme.colors.accent + '40',
			};
		case 'output_scan':
			return {
				bg: theme.colors.success + '20',
				text: theme.colors.success,
				border: theme.colors.success + '40',
			};
		default:
			return {
				bg: theme.colors.bgActivity,
				text: theme.colors.textDim,
				border: theme.colors.border,
			};
	}
};

// Format timestamp for display
const formatTime = (timestamp: number) => {
	const date = new Date(timestamp);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	if (isToday) {
		return date.toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	} else {
		return (
			date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
			' ' +
			date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
		);
	}
};

// Get action badge colors
const getActionColors = (action: SecurityEvent['action'], theme: Theme) => {
	switch (action) {
		case 'blocked':
			return { bg: theme.colors.error, text: '#ffffff' };
		case 'sanitized':
			return { bg: theme.colors.warning, text: '#000000' };
		case 'warned':
			return { bg: theme.colors.accent, text: '#ffffff' };
		case 'none':
		default:
			return { bg: theme.colors.bgActivity, text: theme.colors.textDim };
	}
};

// Individual event item component
interface SecurityEventItemProps {
	event: SecurityEvent;
	isExpanded: boolean;
	onToggleExpand: () => void;
	theme: Theme;
	onJumpToSession?: (sessionId: string) => void;
	showDiff: boolean;
	onToggleDiff: () => void;
}

const SecurityEventItem = memo(function SecurityEventItem({
	event,
	isExpanded,
	onToggleExpand,
	theme,
	onJumpToSession,
	showDiff,
	onToggleDiff,
}: SecurityEventItemProps) {
	const colors = getEventColors(event.eventType, theme);
	const actionColors = getActionColors(event.action, theme);
	const Icon = getEventIcon(event.eventType);

	// Check if this event has any sanitization changes (findings with replacements)
	const hasSanitizationChanges = event.findings.some((f) => f.replacement);

	// Reconstruct content from findings for diff view
	const reconstructedContent = hasSanitizationChanges
		? reconstructContentFromFindings(event.findings as Finding[], event.originalLength)
		: null;

	return (
		<div
			className="p-3 rounded border transition-colors cursor-pointer hover:bg-white/5"
			style={{
				borderColor: colors.border,
				backgroundColor: isExpanded ? colors.bg : 'transparent',
			}}
			onClick={onToggleExpand}
		>
			{/* Header Row */}
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0 flex-1">
					{/* Expand/Collapse Icon */}
					<button
						className="flex-shrink-0 p-0.5 rounded hover:bg-white/10"
						onClick={(e) => {
							e.stopPropagation();
							onToggleExpand();
						}}
					>
						{isExpanded ? (
							<ChevronDown className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						) : (
							<ChevronRight className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						)}
					</button>

					{/* Event Type Pill */}
					<span
						className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase flex-shrink-0"
						style={{
							backgroundColor: colors.bg,
							color: colors.text,
							border: `1px solid ${colors.border}`,
						}}
					>
						<Icon className="w-2.5 h-2.5" />
						{event.eventType.replace('_', ' ')}
					</span>

					{/* Action Badge */}
					{event.action !== 'none' && (
						<span
							className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase flex-shrink-0"
							style={{
								backgroundColor: actionColors.bg,
								color: actionColors.text,
							}}
						>
							{event.action}
						</span>
					)}

					{/* Finding Count */}
					<span
						className="text-xs font-medium flex-shrink-0"
						style={{ color: theme.colors.textMain }}
					>
						{event.findings.length} finding{event.findings.length !== 1 ? 's' : ''}
					</span>
				</div>

				{/* Timestamp */}
				<span className="text-[10px] flex-shrink-0" style={{ color: theme.colors.textDim }}>
					{formatTime(event.timestamp)}
				</span>
			</div>

			{/* Session ID Row */}
			<div className="flex items-center gap-2 mt-2">
				<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
					Session:
				</span>
				<button
					onClick={(e) => {
						e.stopPropagation();
						onJumpToSession?.(event.sessionId);
					}}
					className="text-[10px] font-mono uppercase hover:underline"
					style={{ color: theme.colors.accent }}
					title={event.sessionId}
				>
					{event.sessionId.split('-')[0]}
				</button>
				{event.tabId && (
					<>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							/ Tab:
						</span>
						<span
							className="text-[10px] font-mono uppercase"
							style={{ color: theme.colors.textMain }}
						>
							{event.tabId.split('-')[0]}
						</span>
					</>
				)}
			</div>

			{/* Expanded Details */}
			{isExpanded && event.findings.length > 0 && (
				<div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: theme.colors.border }}>
					{/* Show Changes button for sanitized content */}
					{hasSanitizationChanges && (
						<div className="flex items-center justify-between mb-2">
							<button
								onClick={(e) => {
									e.stopPropagation();
									onToggleDiff();
								}}
								className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium transition-colors hover:bg-white/10"
								style={{
									backgroundColor: showDiff ? theme.colors.accent + '20' : 'transparent',
									color: showDiff ? theme.colors.accent : theme.colors.textDim,
									border: `1px solid ${showDiff ? theme.colors.accent : theme.colors.border}`,
								}}
								title={showDiff ? 'Hide diff view' : 'Show visual diff of changes'}
							>
								{showDiff ? (
									<>
										<X className="w-3 h-3" />
										<span>Hide Changes</span>
									</>
								) : (
									<>
										<Eye className="w-3 h-3" />
										<span>Show Changes</span>
									</>
								)}
							</button>
							{/* Size change indicator (inline when button shown) */}
							{event.originalLength !== event.sanitizedLength && (
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									{event.originalLength} → {event.sanitizedLength} chars (
									{event.sanitizedLength < event.originalLength ? '-' : '+'}
									{Math.abs(event.originalLength - event.sanitizedLength)})
								</span>
							)}
						</div>
					)}

					{/* Diff View */}
					{showDiff && reconstructedContent && (
						<div className="mb-3">
							<SanitizedContentDiff
								theme={theme}
								originalContent={reconstructedContent.original}
								sanitizedContent={reconstructedContent.sanitized}
								findings={event.findings as Finding[]}
								viewMode="inline"
								compact={true}
								maxHeight={200}
								onClose={onToggleDiff}
							/>
						</div>
					)}

					{/* Individual findings list */}
					{event.findings.map((finding, idx) => (
						<div
							key={idx}
							className="p-2 rounded text-xs"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							<div className="flex items-center justify-between gap-2 mb-1">
								<span className="font-bold uppercase" style={{ color: colors.text }}>
									{finding.type.replace(/_/g, ' ')}
								</span>
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Confidence: {(finding.confidence * 100).toFixed(0)}%
								</span>
							</div>
							<div className="font-mono text-[11px]" style={{ color: theme.colors.textMain }}>
								{finding.replacement ? (
									<>
										<span style={{ color: theme.colors.error, textDecoration: 'line-through' }}>
											{finding.value}
										</span>
										<span style={{ color: theme.colors.textDim }}> → </span>
										<span style={{ color: theme.colors.success }}>{finding.replacement}</span>
									</>
								) : (
									<span>"{finding.value}"</span>
								)}
							</div>
							<div className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
								Position: {finding.start}–{finding.end}
							</div>
						</div>
					))}

					{/* Size change indicator (standalone when no button shown) */}
					{!hasSanitizationChanges && event.originalLength !== event.sanitizedLength && (
						<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
							Content size: {event.originalLength} → {event.sanitizedLength} chars (
							{event.sanitizedLength < event.originalLength ? '-' : '+'}
							{Math.abs(event.originalLength - event.sanitizedLength)})
						</div>
					)}
				</div>
			)}
		</div>
	);
});

export const SecurityEventsPanel = memo(
	forwardRef<SecurityEventsPanelHandle, SecurityEventsPanelProps>(function SecurityEventsPanel(
		{ theme, onJumpToSession },
		ref
	) {
		const [events, setEvents] = useState<SecurityEvent[]>([]);
		const [isLoading, setIsLoading] = useState(true);
		const [activeFilter, setActiveFilter] = useState<EventTypeFilter>('all');
		const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
		const [showDiffEventIds, setShowDiffEventIds] = useState<Set<string>>(new Set());
		const [showClearConfirm, setShowClearConfirm] = useState(false);
		const [showExportModal, setShowExportModal] = useState(false);
		const [isExporting, setIsExporting] = useState(false);
		const [stats, setStats] = useState<{
			bufferSize: number;
			totalLogged: number;
			maxSize: number;
		} | null>(null);

		// Export filter state
		const [exportFormat, setExportFormat] = useState<ExportFormat>('json');
		const [exportDateRange, setExportDateRange] = useState<'all' | '7d' | '30d' | 'custom'>('all');
		const [exportStartDate, setExportStartDate] = useState('');
		const [exportEndDate, setExportEndDate] = useState('');
		const [exportEventTypes, setExportEventTypes] = useState<Set<string>>(new Set());
		const [exportMinConfidence, setExportMinConfidence] = useState(0);

		const listRef = useRef<HTMLDivElement>(null);

		// Load events from backend
		const loadEvents = useCallback(async () => {
			setIsLoading(true);
			try {
				const result: SecurityEventsPage = await window.maestro.security.getEvents(100, 0);
				setEvents(result.events);
				const statsResult = await window.maestro.security.getStats();
				setStats(statsResult);
			} catch (error) {
				console.error('Failed to load security events:', error);
				setEvents([]);
			} finally {
				setIsLoading(false);
			}
		}, []);

		// Initial load
		useEffect(() => {
			loadEvents();
		}, [loadEvents]);

		// Subscribe to real-time events
		useEffect(() => {
			const unsubscribe = window.maestro.security.onSecurityEvent((eventData) => {
				// When we receive a real-time event, refresh the full list
				// (the event data is simplified, so we need to fetch the full event)
				loadEvents();
			});

			return unsubscribe;
		}, [loadEvents]);

		// Filter events
		const filteredEvents = events.filter((event) => {
			if (activeFilter === 'all') return true;
			return event.eventType === activeFilter;
		});

		// Toggle event expansion
		const toggleExpand = useCallback((eventId: string) => {
			setExpandedEventIds((prev) => {
				const newSet = new Set(prev);
				if (newSet.has(eventId)) {
					newSet.delete(eventId);
					// Also hide diff when collapsing
					setShowDiffEventIds((diffSet) => {
						const newDiffSet = new Set(diffSet);
						newDiffSet.delete(eventId);
						return newDiffSet;
					});
				} else {
					newSet.add(eventId);
				}
				return newSet;
			});
		}, []);

		// Toggle diff view for an event
		const toggleDiff = useCallback((eventId: string) => {
			setShowDiffEventIds((prev) => {
				const newSet = new Set(prev);
				if (newSet.has(eventId)) {
					newSet.delete(eventId);
				} else {
					newSet.add(eventId);
				}
				return newSet;
			});
		}, []);

		// Clear events
		const handleClearEvents = useCallback(async () => {
			try {
				await window.maestro.security.clearAllEvents();
				setEvents([]);
				setExpandedEventIds(new Set());
				setShowClearConfirm(false);
				const statsResult = await window.maestro.security.getStats();
				setStats(statsResult);
			} catch (error) {
				console.error('Failed to clear security events:', error);
			}
		}, []);

		// Export events
		const handleExport = useCallback(async () => {
			setIsExporting(true);
			try {
				// Build filter options
				const filters: ExportFilterOptions = {};

				// Date range filter
				if (exportDateRange === '7d') {
					filters.startDate = Date.now() - 7 * 24 * 60 * 60 * 1000;
				} else if (exportDateRange === '30d') {
					filters.startDate = Date.now() - 30 * 24 * 60 * 60 * 1000;
				} else if (exportDateRange === 'custom') {
					if (exportStartDate) {
						filters.startDate = new Date(exportStartDate).getTime();
					}
					if (exportEndDate) {
						filters.endDate = new Date(exportEndDate).setHours(23, 59, 59, 999);
					}
				}

				// Event type filter
				if (exportEventTypes.size > 0) {
					filters.eventTypes = [...exportEventTypes] as ExportFilterOptions['eventTypes'];
				}

				// Confidence filter
				if (exportMinConfidence > 0) {
					filters.minConfidence = exportMinConfidence / 100;
				}

				// Get export content
				const content = await window.maestro.security.exportEvents(exportFormat, filters);

				// Determine file extension and MIME type
				const extensions: Record<ExportFormat, string> = {
					json: 'json',
					csv: 'csv',
					html: 'html',
				};
				const mimeTypes: Record<ExportFormat, string> = {
					json: 'application/json',
					csv: 'text/csv',
					html: 'text/html',
				};

				// Create blob and download
				const blob = new Blob([content], { type: `${mimeTypes[exportFormat]};charset=utf-8` });
				const url = URL.createObjectURL(blob);
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
				const filename = `llm-guard-audit-${timestamp}.${extensions[exportFormat]}`;

				const link = document.createElement('a');
				link.href = url;
				link.download = filename;
				document.body.appendChild(link);
				link.click();
				document.body.removeChild(link);
				URL.revokeObjectURL(url);

				setShowExportModal(false);
			} catch (error) {
				console.error('Failed to export security events:', error);
			} finally {
				setIsExporting(false);
			}
		}, [
			exportFormat,
			exportDateRange,
			exportStartDate,
			exportEndDate,
			exportEventTypes,
			exportMinConfidence,
		]);

		// Toggle event type filter for export
		const toggleExportEventType = useCallback((eventType: string) => {
			setExportEventTypes((prev) => {
				const newSet = new Set(prev);
				if (newSet.has(eventType)) {
					newSet.delete(eventType);
				} else {
					newSet.add(eventType);
				}
				return newSet;
			});
		}, []);

		// Expose methods to parent
		useImperativeHandle(
			ref,
			() => ({
				focus: () => listRef.current?.focus(),
				refresh: loadEvents,
			}),
			[loadEvents]
		);

		// Virtualizer setup
		const estimateSize = useCallback(
			(index: number) => {
				const event = filteredEvents[index];
				if (!event) return ESTIMATED_ROW_HEIGHT_COLLAPSED;
				if (!expandedEventIds.has(event.id)) return ESTIMATED_ROW_HEIGHT_COLLAPSED;
				// If diff is shown, use larger height
				if (showDiffEventIds.has(event.id)) return ESTIMATED_ROW_HEIGHT_WITH_DIFF;
				return ESTIMATED_ROW_HEIGHT_EXPANDED;
			},
			[filteredEvents, expandedEventIds, showDiffEventIds]
		);

		const virtualizer = useVirtualizer({
			count: filteredEvents.length,
			getScrollElement: () => listRef.current,
			estimateSize,
			overscan: 5,
			gap: 8,
			initialRect: { width: 300, height: 600 },
		});

		const virtualItems = virtualizer.getVirtualItems();

		// Filter button component
		const FilterButton = ({
			filter,
			label,
			count,
		}: {
			filter: EventTypeFilter;
			label: string;
			count: number;
		}) => (
			<button
				onClick={() => setActiveFilter(filter)}
				className="px-2 py-1 rounded text-[10px] font-bold transition-colors"
				style={{
					backgroundColor: activeFilter === filter ? theme.colors.accent : theme.colors.bgActivity,
					color: activeFilter === filter ? '#ffffff' : theme.colors.textDim,
					border: `1px solid ${activeFilter === filter ? theme.colors.accent : theme.colors.border}`,
				}}
			>
				{label}
				{count > 0 && <span className="ml-1 opacity-70">({count})</span>}
			</button>
		);

		// Count events by type
		const countByType = {
			all: events.length,
			input_scan: events.filter((e) => e.eventType === 'input_scan').length,
			output_scan: events.filter((e) => e.eventType === 'output_scan').length,
			blocked: events.filter((e) => e.eventType === 'blocked').length,
			warning: events.filter((e) => e.eventType === 'warning').length,
		};

		return (
			<div className="flex flex-col h-full">
				{/* Header */}
				<div className="flex items-center justify-between gap-2 mb-3 pt-2">
					<div className="flex items-center gap-2">
						<ShieldCheck className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<span className="text-xs font-bold uppercase" style={{ color: theme.colors.textMain }}>
							Security Events
						</span>
						{stats && (
							<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
								({stats.bufferSize}/{stats.maxSize})
							</span>
						)}
					</div>
					<div className="flex items-center gap-1">
						<button
							onClick={() => setShowExportModal(true)}
							disabled={events.length === 0}
							className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
							title="Export audit log"
						>
							<Download className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
						</button>
						<button
							onClick={loadEvents}
							className="p-1.5 rounded hover:bg-white/10 transition-colors"
							title="Refresh events"
						>
							<RefreshCw
								className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`}
								style={{ color: theme.colors.textDim }}
							/>
						</button>
						<button
							onClick={() => setShowClearConfirm(true)}
							disabled={events.length === 0}
							className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
							title="Clear all events"
						>
							<Trash2 className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />
						</button>
					</div>
				</div>

				{/* Filter Pills */}
				<div className="flex flex-wrap gap-1 mb-3">
					<FilterButton filter="all" label="All" count={countByType.all} />
					<FilterButton filter="input_scan" label="Input" count={countByType.input_scan} />
					<FilterButton filter="output_scan" label="Output" count={countByType.output_scan} />
					<FilterButton filter="blocked" label="Blocked" count={countByType.blocked} />
					<FilterButton filter="warning" label="Warning" count={countByType.warning} />
				</div>

				{/* Events List */}
				<div
					ref={listRef}
					className="flex-1 overflow-y-auto outline-none scrollbar-thin"
					tabIndex={0}
				>
					{isLoading ? (
						<div className="text-center py-8 text-xs opacity-50">Loading security events...</div>
					) : filteredEvents.length === 0 ? (
						<div className="text-center py-8">
							<Shield className="w-8 h-8 mx-auto mb-2 opacity-30" />
							<div className="text-xs opacity-50">
								{events.length === 0
									? 'No security events yet. Events will appear here when LLM Guard detects sensitive content.'
									: `No ${activeFilter.replace('_', ' ')} events found.`}
							</div>
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
								const event = filteredEvents[virtualItem.index];
								if (!event) return null;

								return (
									<div
										key={event.id}
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
										<SecurityEventItem
											event={event}
											isExpanded={expandedEventIds.has(event.id)}
											onToggleExpand={() => toggleExpand(event.id)}
											theme={theme}
											onJumpToSession={onJumpToSession}
											showDiff={showDiffEventIds.has(event.id)}
											onToggleDiff={() => toggleDiff(event.id)}
										/>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* Clear Confirmation Modal */}
				{showClearConfirm && (
					<ConfirmModal
						theme={theme}
						title="Clear Security Events"
						message="This will permanently delete all security events from memory and the log file. This action cannot be undone."
						headerIcon={<Trash2 className="w-4 h-4" style={{ color: theme.colors.error }} />}
						icon={<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.warning }} />}
						confirmLabel="Clear All Events"
						destructive
						onConfirm={handleClearEvents}
						onClose={() => setShowClearConfirm(false)}
					/>
				)}

				{/* Export Modal */}
				{showExportModal && (
					<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
						<div
							className="rounded-lg shadow-xl w-[440px] max-h-[80vh] overflow-y-auto"
							style={{ backgroundColor: theme.colors.bgSidebar }}
						>
							{/* Modal Header */}
							<div
								className="flex items-center justify-between p-4 border-b"
								style={{ borderColor: theme.colors.border }}
							>
								<div className="flex items-center gap-2">
									<Download className="w-4 h-4" style={{ color: theme.colors.accent }} />
									<h3 className="font-semibold" style={{ color: theme.colors.textMain }}>
										Export Audit Log
									</h3>
								</div>
								<button
									onClick={() => setShowExportModal(false)}
									className="p-1 rounded hover:bg-white/10"
								>
									<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
								</button>
							</div>

							{/* Modal Body */}
							<div className="p-4 space-y-4">
								{/* Export Format */}
								<div>
									<label
										className="block text-xs font-semibold mb-2 uppercase"
										style={{ color: theme.colors.textDim }}
									>
										Export Format
									</label>
									<div className="flex gap-2">
										{[
											{
												value: 'json' as ExportFormat,
												label: 'JSON',
												icon: FileJson,
												desc: 'Full detail',
											},
											{
												value: 'csv' as ExportFormat,
												label: 'CSV',
												icon: FileSpreadsheet,
												desc: 'For spreadsheets',
											},
											{
												value: 'html' as ExportFormat,
												label: 'HTML',
												icon: FileText,
												desc: 'Formatted report',
											},
										].map(({ value, label, icon: Icon, desc }) => (
											<button
												key={value}
												onClick={() => setExportFormat(value)}
												className="flex-1 flex flex-col items-center gap-1 p-3 rounded border transition-colors"
												style={{
													borderColor:
														exportFormat === value ? theme.colors.accent : theme.colors.border,
													backgroundColor:
														exportFormat === value ? theme.colors.accent + '20' : 'transparent',
												}}
											>
												<Icon
													className="w-5 h-5"
													style={{
														color:
															exportFormat === value ? theme.colors.accent : theme.colors.textDim,
													}}
												/>
												<span
													className="text-xs font-semibold"
													style={{
														color:
															exportFormat === value ? theme.colors.textMain : theme.colors.textDim,
													}}
												>
													{label}
												</span>
												<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
													{desc}
												</span>
											</button>
										))}
									</div>
								</div>

								{/* Date Range Filter */}
								<div>
									<label
										className="block text-xs font-semibold mb-2 uppercase"
										style={{ color: theme.colors.textDim }}
									>
										<Calendar className="w-3 h-3 inline mr-1" />
										Date Range
									</label>
									<div className="flex gap-2 flex-wrap">
										{[
											{ value: 'all' as const, label: 'All Time' },
											{ value: '7d' as const, label: 'Last 7 Days' },
											{ value: '30d' as const, label: 'Last 30 Days' },
											{ value: 'custom' as const, label: 'Custom' },
										].map(({ value, label }) => (
											<button
												key={value}
												onClick={() => setExportDateRange(value)}
												className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
												style={{
													backgroundColor:
														exportDateRange === value
															? theme.colors.accent
															: theme.colors.bgActivity,
													color: exportDateRange === value ? '#ffffff' : theme.colors.textDim,
												}}
											>
												{label}
											</button>
										))}
									</div>
									{exportDateRange === 'custom' && (
										<div className="flex gap-2 mt-2">
											<input
												type="date"
												value={exportStartDate}
												onChange={(e) => setExportStartDate(e.target.value)}
												className="flex-1 px-2 py-1.5 rounded text-xs"
												style={{
													backgroundColor: theme.colors.bgActivity,
													color: theme.colors.textMain,
													border: `1px solid ${theme.colors.border}`,
												}}
												placeholder="Start date"
											/>
											<input
												type="date"
												value={exportEndDate}
												onChange={(e) => setExportEndDate(e.target.value)}
												className="flex-1 px-2 py-1.5 rounded text-xs"
												style={{
													backgroundColor: theme.colors.bgActivity,
													color: theme.colors.textMain,
													border: `1px solid ${theme.colors.border}`,
												}}
												placeholder="End date"
											/>
										</div>
									)}
								</div>

								{/* Event Type Filter */}
								<div>
									<label
										className="block text-xs font-semibold mb-2 uppercase"
										style={{ color: theme.colors.textDim }}
									>
										<Filter className="w-3 h-3 inline mr-1" />
										Event Types
									</label>
									<div className="flex gap-2 flex-wrap">
										{[
											{ value: 'input_scan', label: 'Input', color: theme.colors.accent },
											{ value: 'output_scan', label: 'Output', color: theme.colors.success },
											{ value: 'blocked', label: 'Blocked', color: theme.colors.error },
											{ value: 'warning', label: 'Warning', color: theme.colors.warning },
											{
												value: 'inter_agent_scan',
												label: 'Inter-Agent',
												color: theme.colors.accent,
											},
										].map(({ value, label, color }) => (
											<button
												key={value}
												onClick={() => toggleExportEventType(value)}
												className="px-2 py-1 rounded text-[10px] font-bold uppercase transition-colors"
												style={{
													backgroundColor: exportEventTypes.has(value)
														? color + '30'
														: theme.colors.bgActivity,
													color: exportEventTypes.has(value) ? color : theme.colors.textDim,
													border: `1px solid ${exportEventTypes.has(value) ? color : theme.colors.border}`,
												}}
											>
												{label}
											</button>
										))}
									</div>
									<p className="text-[10px] mt-1" style={{ color: theme.colors.textDim }}>
										{exportEventTypes.size === 0
											? 'All event types will be included'
											: `${exportEventTypes.size} type(s) selected`}
									</p>
								</div>

								{/* Minimum Confidence Filter */}
								<div>
									<label
										className="block text-xs font-semibold mb-2 uppercase"
										style={{ color: theme.colors.textDim }}
									>
										Minimum Confidence: {exportMinConfidence}%
									</label>
									<input
										type="range"
										min="0"
										max="100"
										step="5"
										value={exportMinConfidence}
										onChange={(e) => setExportMinConfidence(parseInt(e.target.value))}
										className="w-full"
										style={{
											accentColor: theme.colors.accent,
										}}
									/>
									<div
										className="flex justify-between text-[10px]"
										style={{ color: theme.colors.textDim }}
									>
										<span>0% (All)</span>
										<span>50%</span>
										<span>100%</span>
									</div>
								</div>
							</div>

							{/* Modal Footer */}
							<div
								className="flex items-center justify-end gap-2 p-4 border-t"
								style={{ borderColor: theme.colors.border }}
							>
								<button
									onClick={() => setShowExportModal(false)}
									className="px-4 py-2 rounded text-xs font-medium transition-colors hover:bg-white/10"
									style={{ color: theme.colors.textDim }}
								>
									Cancel
								</button>
								<button
									onClick={handleExport}
									disabled={isExporting}
									className="flex items-center gap-2 px-4 py-2 rounded text-xs font-semibold transition-colors disabled:opacity-50"
									style={{
										backgroundColor: theme.colors.accent,
										color: '#ffffff',
									}}
								>
									{isExporting ? (
										<>
											<RefreshCw className="w-3.5 h-3.5 animate-spin" />
											Exporting...
										</>
									) : (
										<>
											<Download className="w-3.5 h-3.5" />
											Export
										</>
									)}
								</button>
							</div>
						</div>
					</div>
				)}
			</div>
		);
	})
);
