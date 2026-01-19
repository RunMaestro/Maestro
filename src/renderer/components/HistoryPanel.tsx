import React, {
	useState,
	useEffect,
	useRef,
	useCallback,
	useImperativeHandle,
	forwardRef,
	useMemo,
	memo,
} from 'react';
import { Bot, User, ExternalLink, Check, X, Clock, HelpCircle, Award } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Session, Theme, HistoryEntry, HistoryEntryType } from '../types';
import { HistoryDetailModal } from './HistoryDetailModal';
import { HistoryHelpModal } from './HistoryHelpModal';
import { useThrottledCallback, useListNavigation } from '../hooks';
import { formatElapsedTime } from '../utils/formatters';
import { stripMarkdown } from '../utils/textProcessing';

// Double checkmark SVG component for validated entries
const DoubleCheck = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
	<svg
		className={className}
		style={style}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2.5"
		strokeLinecap="round"
		strokeLinejoin="round"
	>
		<polyline points="15 6 6 17 1 12" />
		<polyline points="23 6 14 17 11 14" />
	</svg>
);

// Lookback period options for the activity graph
type LookbackPeriod = {
	label: string;
	hours: number | null; // null = all time
	bucketCount: number;
};

const LOOKBACK_OPTIONS: LookbackPeriod[] = [
	{ label: '24 hours', hours: 24, bucketCount: 24 },
	{ label: '72 hours', hours: 72, bucketCount: 24 },
	{ label: '1 week', hours: 168, bucketCount: 28 },
	{ label: '2 weeks', hours: 336, bucketCount: 28 },
	{ label: '1 month', hours: 720, bucketCount: 30 },
	{ label: '6 months', hours: 4320, bucketCount: 24 },
	{ label: '1 year', hours: 8760, bucketCount: 24 },
	{ label: 'All time', hours: null, bucketCount: 24 },
];

// Activity bar graph component with configurable lookback window
interface ActivityGraphProps {
	entries: HistoryEntry[];
	theme: Theme;
	referenceTime?: number; // The "end" of the window (defaults to now)
	onBarClick?: (bucketStartTime: number, bucketEndTime: number) => void;
	lookbackHours: number | null; // null = all time
	onLookbackChange: (hours: number | null) => void;
}

const ActivityGraph: React.FC<ActivityGraphProps> = ({
	entries,
	theme,
	referenceTime,
	onBarClick,
	lookbackHours,
	onLookbackChange,
}) => {
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const graphRef = useRef<HTMLDivElement>(null);

	// Get the current lookback config
	const lookbackConfig = useMemo(
		() => LOOKBACK_OPTIONS.find((o) => o.hours === lookbackHours) || LOOKBACK_OPTIONS[0],
		[lookbackHours]
	);

	// Use referenceTime as the end of our window, or current time if not provided
	const endTime = referenceTime || Date.now();

	// Calculate time range based on lookback setting
	const { startTime, msPerBucket, bucketCount } = useMemo(() => {
		if (lookbackHours === null) {
			// All time: find earliest entry
			const earliest =
				entries.length > 0
					? Math.min(...entries.map((e) => e.timestamp))
					: endTime - 24 * 60 * 60 * 1000;
			const totalMs = endTime - earliest;
			const count = lookbackConfig.bucketCount;
			return {
				startTime: earliest,
				msPerBucket: totalMs / count,
				bucketCount: count,
			};
		} else {
			const totalMs = lookbackHours * 60 * 60 * 1000;
			return {
				startTime: endTime - totalMs,
				msPerBucket: totalMs / lookbackConfig.bucketCount,
				bucketCount: lookbackConfig.bucketCount,
			};
		}
	}, [entries, endTime, lookbackHours, lookbackConfig.bucketCount]);

	// Group entries into buckets
	const bucketData = useMemo(() => {
		const buckets: { auto: number; user: number }[] = Array.from({ length: bucketCount }, () => ({
			auto: 0,
			user: 0,
		}));

		entries.forEach((entry) => {
			if (entry.timestamp >= startTime && entry.timestamp <= endTime) {
				const bucketIndex = Math.min(
					bucketCount - 1,
					Math.floor((entry.timestamp - startTime) / msPerBucket)
				);
				if (bucketIndex >= 0 && bucketIndex < bucketCount) {
					if (entry.type === 'AUTO') {
						buckets[bucketIndex].auto++;
					} else if (entry.type === 'USER') {
						buckets[bucketIndex].user++;
					}
				}
			}
		});

		return buckets;
	}, [entries, startTime, endTime, msPerBucket, bucketCount]);

	// Find max value for scaling
	const maxValue = useMemo(() => {
		return Math.max(1, ...bucketData.map((h) => h.auto + h.user));
	}, [bucketData]);

	// Total counts for summary tooltip
	const totalAuto = useMemo(() => bucketData.reduce((sum, h) => sum + h.auto, 0), [bucketData]);
	const totalUser = useMemo(() => bucketData.reduce((sum, h) => sum + h.user, 0), [bucketData]);

	// Get time range label for tooltip
	const getTimeRangeLabel = (index: number) => {
		const bucketStart = new Date(startTime + index * msPerBucket);
		const bucketEnd = new Date(startTime + (index + 1) * msPerBucket);

		// Format based on lookback period
		if (lookbackHours !== null && lookbackHours <= 72) {
			// For short periods, show time of day
			const formatHour = (date: Date) => {
				const hour = date.getHours();
				const ampm = hour >= 12 ? 'PM' : 'AM';
				const hour12 = hour % 12 || 12;
				return `${hour12}${ampm}`;
			};
			return `${formatHour(bucketStart)} - ${formatHour(bucketEnd)}`;
		} else {
			// For longer periods, show dates
			const formatDate = (date: Date) => {
				return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
			};
			if (formatDate(bucketStart) === formatDate(bucketEnd)) {
				return formatDate(bucketStart);
			}
			return `${formatDate(bucketStart)} - ${formatDate(bucketEnd)}`;
		}
	};

	// Get bucket time range as timestamps for click handling
	const getBucketTimeRange = (index: number): { start: number; end: number } => {
		return {
			start: startTime + index * msPerBucket,
			end: startTime + (index + 1) * msPerBucket,
		};
	};

	// Handle bar click
	const handleBarClick = (index: number) => {
		const total = bucketData[index].auto + bucketData[index].user;
		if (total > 0 && onBarClick) {
			const { start, end } = getBucketTimeRange(index);
			onBarClick(start, end);
		}
	};

	// Handle right-click context menu
	const handleContextMenu = (e: React.MouseEvent) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY });
	};

	// Close context menu when clicking elsewhere
	useEffect(() => {
		const handleClick = () => setContextMenu(null);
		if (contextMenu) {
			document.addEventListener('click', handleClick);
			return () => document.removeEventListener('click', handleClick);
		}
	}, [contextMenu]);

	// Format the reference time for display (shows what time point we're viewing)
	const formatReferenceTime = () => {
		const now = Date.now();
		const diffMs = now - endTime;
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMins / 60);

		if (diffMins < 1) return 'Now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		return new Date(endTime).toLocaleDateString([], { month: 'short', day: 'numeric' });
	};

	// Check if we're viewing historical data (not "now")
	const isHistorical = referenceTime && Date.now() - referenceTime > 60000;

	// Generate labels for the x-axis
	const getAxisLabels = () => {
		if (lookbackHours === null) {
			// All time - show start and end dates
			return [
				{
					label: new Date(startTime).toLocaleDateString([], { month: 'short', day: 'numeric' }),
					index: 0,
				},
				{ label: 'Now', index: bucketCount - 1 },
			];
		} else if (lookbackHours <= 24) {
			return [
				{ label: `${lookbackHours}h`, index: 0 },
				{ label: `${Math.floor((lookbackHours * 2) / 3)}h`, index: Math.floor(bucketCount / 3) },
				{ label: `${Math.floor(lookbackHours / 3)}h`, index: Math.floor((bucketCount * 2) / 3) },
				{ label: '0h', index: bucketCount - 1 },
			];
		} else if (lookbackHours <= 168) {
			// Up to 1 week - show days
			const days = Math.floor(lookbackHours / 24);
			return [
				{ label: `${days}d`, index: 0 },
				{ label: `${Math.floor(days / 2)}d`, index: Math.floor(bucketCount / 2) },
				{ label: 'Now', index: bucketCount - 1 },
			];
		} else {
			// Longer periods - show start/end
			const startLabel = new Date(startTime).toLocaleDateString([], {
				month: 'short',
				day: 'numeric',
			});
			return [
				{ label: startLabel, index: 0 },
				{ label: 'Now', index: bucketCount - 1 },
			];
		}
	};

	const axisLabels = getAxisLabels();

	return (
		<div
			ref={graphRef}
			className="flex-1 min-w-0 flex flex-col relative mt-0.5"
			title={
				hoveredIndex === null
					? `${isHistorical ? `Viewing: ${formatReferenceTime()} • ` : ''}${lookbackConfig.label}: ${totalAuto} auto, ${totalUser} user (right-click to change)`
					: undefined
			}
			onContextMenu={handleContextMenu}
		>
			{/* Context menu for lookback options */}
			{contextMenu && (
				<div
					className="fixed z-50 py-1 rounded border shadow-lg"
					style={{
						left: contextMenu.x,
						top: contextMenu.y,
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						minWidth: '120px',
					}}
				>
					<div
						className="px-3 py-1 text-[10px] font-bold uppercase"
						style={{ color: theme.colors.textDim }}
					>
						Lookback Period
					</div>
					{LOOKBACK_OPTIONS.map((option) => (
						<button
							key={option.label}
							className="w-full px-3 py-1.5 text-left text-xs hover:bg-white/10 transition-colors flex items-center justify-between"
							style={{
								color: option.hours === lookbackHours ? theme.colors.accent : theme.colors.textMain,
							}}
							onClick={() => {
								onLookbackChange(option.hours);
								setContextMenu(null);
							}}
						>
							{option.label}
							{option.hours === lookbackHours && (
								<Check className="w-3 h-3" style={{ color: theme.colors.accent }} />
							)}
						</button>
					))}
				</div>
			)}

			{/* Hover tooltip - positioned below the graph */}
			{hoveredIndex !== null && (
				<div
					className="absolute top-full mt-1 px-2 py-1.5 rounded text-[10px] font-mono whitespace-nowrap z-20 pointer-events-none"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
						color: theme.colors.textMain,
						left: `${(hoveredIndex / (bucketCount - 1)) * 100}%`,
						transform:
							hoveredIndex < bucketCount * 0.17
								? 'translateX(0)'
								: hoveredIndex > bucketCount * 0.83
									? 'translateX(-100%)'
									: 'translateX(-50%)',
					}}
				>
					<div className="font-bold mb-1" style={{ color: theme.colors.textMain }}>
						{getTimeRangeLabel(hoveredIndex)}
						{isHistorical && (
							<span className="ml-2 font-normal" style={{ color: theme.colors.accent }}>
								{formatReferenceTime()}
							</span>
						)}
					</div>
					<div className="flex flex-col gap-0.5">
						<div className="flex items-center justify-between gap-3">
							<span style={{ color: theme.colors.warning }}>Auto</span>
							<span className="font-bold" style={{ color: theme.colors.warning }}>
								{bucketData[hoveredIndex].auto}
							</span>
						</div>
						<div className="flex items-center justify-between gap-3">
							<span style={{ color: theme.colors.accent }}>User</span>
							<span className="font-bold" style={{ color: theme.colors.accent }}>
								{bucketData[hoveredIndex].user}
							</span>
						</div>
					</div>
				</div>
			)}

			{/* Graph container with border */}
			<div
				className="flex items-end gap-px h-6 rounded border px-1 pt-1"
				style={{ borderColor: theme.colors.border }}
			>
				{bucketData.map((bucket, index) => {
					const total = bucket.auto + bucket.user;
					const heightPercent = total > 0 ? (total / maxValue) * 100 : 0;
					const autoPercent = total > 0 ? (bucket.auto / total) * 100 : 0;
					const userPercent = total > 0 ? (bucket.user / total) * 100 : 0;
					const isHovered = hoveredIndex === index;

					return (
						<div
							key={index}
							className="flex-1 min-w-0 flex flex-col justify-end rounded-t-sm overflow-visible cursor-pointer"
							style={{
								height: '100%',
								opacity: total > 0 ? 1 : 0.15,
								transform: isHovered ? 'scaleX(1.5)' : 'scaleX(1)',
								zIndex: isHovered ? 10 : 1,
								transition: 'transform 0.1s ease-out',
								cursor: total > 0 ? 'pointer' : 'default',
							}}
							onMouseEnter={() => setHoveredIndex(index)}
							onMouseLeave={() => setHoveredIndex(null)}
							onClick={() => handleBarClick(index)}
						>
							<div
								className="w-full rounded-t-sm overflow-hidden flex flex-col justify-end"
								style={{
									height: `${Math.max(heightPercent, total > 0 ? 15 : 8)}%`,
									minHeight: total > 0 ? '3px' : '1px',
								}}
							>
								{/* Auto portion (bottom) - warning color */}
								{bucket.auto > 0 && (
									<div
										style={{
											height: `${autoPercent}%`,
											backgroundColor: theme.colors.warning,
											minHeight: '1px',
										}}
									/>
								)}
								{/* User portion (top) - accent color */}
								{bucket.user > 0 && (
									<div
										style={{
											height: `${userPercent}%`,
											backgroundColor: theme.colors.accent,
											minHeight: '1px',
										}}
									/>
								)}
								{/* Empty bar placeholder */}
								{total === 0 && (
									<div
										style={{
											height: '100%',
											backgroundColor: theme.colors.border,
										}}
									/>
								)}
							</div>
						</div>
					);
				})}
			</div>
			{/* Axis labels below */}
			<div className="relative h-3 mt-0.5">
				{axisLabels.map(({ label, index }) => (
					<span
						key={`${label}-${index}`}
						className="absolute text-[8px] font-mono"
						style={{
							color: theme.colors.textDim,
							left:
								index === 0
									? '0'
									: index === bucketCount - 1
										? 'auto'
										: `${(index / (bucketCount - 1)) * 100}%`,
							right: index === bucketCount - 1 ? '0' : 'auto',
							transform: index > 0 && index < bucketCount - 1 ? 'translateX(-50%)' : 'none',
						}}
					>
						{label}
					</span>
				))}
			</div>
		</div>
	);
};

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

// Constants for history pagination
const MAX_HISTORY_IN_MEMORY = 500; // Maximum entries to keep in memory
// Note: With virtualization, display count is managed by the virtualizer
const _INITIAL_DISPLAY_COUNT = 50; // Kept for reference, prefixed to satisfy linter

// Estimated row heights for virtualization
// Entry breakdown: p-3 (24px padding) + header (~24px) + mb-2 (8px) + summary (~48px for 3 lines)
// Footer adds: mt-2 pt-2 border-t (~20px)
const ESTIMATED_ROW_HEIGHT = 124; // Height for entry with footer
const ESTIMATED_ROW_HEIGHT_SIMPLE = 104; // Height for entry without footer

// Module-level storage for scroll positions (persists across session switches)
const scrollPositionCache = new Map<string, number>();

// ============================================================================
// HistoryEntryItem - Memoized component for individual history entries
// ============================================================================

interface HistoryEntryItemProps {
	entry: HistoryEntry;
	index: number;
	isSelected: boolean;
	theme: Theme;
	onOpenDetailModal: (entry: HistoryEntry, index: number) => void;
	onOpenSessionAsTab?: (agentSessionId: string) => void;
	onOpenAboutModal?: () => void;
}

const HistoryEntryItem = memo(function HistoryEntryItem({
	entry,
	index,
	isSelected,
	theme,
	onOpenDetailModal,
	onOpenSessionAsTab,
	onOpenAboutModal,
}: HistoryEntryItemProps) {
	// Get pill color based on type
	const getPillColor = (type: HistoryEntryType) => {
		switch (type) {
			case 'AUTO':
				return {
					bg: theme.colors.warning + '20',
					text: theme.colors.warning,
					border: theme.colors.warning + '40',
				};
			case 'USER':
				return {
					bg: theme.colors.accent + '20',
					text: theme.colors.accent,
					border: theme.colors.accent + '40',
				};
			default:
				return {
					bg: theme.colors.bgActivity,
					text: theme.colors.textDim,
					border: theme.colors.border,
				};
		}
	};

	// Get icon for entry type
	const getEntryIcon = (type: HistoryEntryType) => {
		switch (type) {
			case 'AUTO':
				return Bot;
			case 'USER':
				return User;
			default:
				return Bot;
		}
	};

	// Format timestamp
	const formatTime = (timestamp: number) => {
		const date = new Date(timestamp);
		const now = new Date();
		const isToday = date.toDateString() === now.toDateString();

		if (isToday) {
			return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		} else {
			return (
				date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
				' ' +
				date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			);
		}
	};

	const colors = getPillColor(entry.type);
	const Icon = getEntryIcon(entry.type);

	return (
		<div
			onClick={() => onOpenDetailModal(entry, index)}
			className="p-3 rounded border transition-colors cursor-pointer hover:bg-white/5"
			style={{
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				backgroundColor: isSelected ? theme.colors.accent + '10' : 'transparent',
				outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
				outlineOffset: '1px',
			}}
		>
			{/* Header Row */}
			<div className="flex items-center justify-between mb-2">
				<div className="flex items-center gap-2">
					{/* Success/Failure Indicator for AUTO entries */}
					{entry.type === 'AUTO' && entry.success !== undefined && (
						<span
							className="flex items-center justify-center w-5 h-5 rounded-full"
							style={{
								backgroundColor: entry.success
									? entry.validated
										? theme.colors.success
										: theme.colors.success + '20'
									: theme.colors.error + '20',
								border: `1px solid ${
									entry.success
										? entry.validated
											? theme.colors.success
											: theme.colors.success + '40'
										: theme.colors.error + '40'
								}`,
							}}
							title={
								entry.success
									? entry.validated
										? 'Task completed successfully and human-validated'
										: 'Task completed successfully'
									: 'Task failed'
							}
						>
							{entry.success ? (
								entry.validated ? (
									<DoubleCheck className="w-3 h-3" style={{ color: '#ffffff' }} />
								) : (
									<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
								)
							) : (
								<X className="w-3 h-3" style={{ color: theme.colors.error }} />
							)}
						</span>
					)}

					{/* Type Pill */}
					<span
						className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase"
						style={{
							backgroundColor: colors.bg,
							color: colors.text,
							border: `1px solid ${colors.border}`,
						}}
					>
						<Icon className="w-2.5 h-2.5" />
						{entry.type}
					</span>

					{/* Session Name or ID Octet (clickable) - opens session as new tab */}
					{entry.agentSessionId && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onOpenSessionAsTab?.(entry.agentSessionId!);
							}}
							className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors hover:opacity-80 min-w-0 ${entry.sessionName ? '' : 'font-mono uppercase'}`}
							style={{
								backgroundColor: theme.colors.accent + '20',
								color: theme.colors.accent,
								border: `1px solid ${theme.colors.accent}40`,
							}}
							title={`Open session ${entry.sessionName || entry.agentSessionId.split('-')[0]} as new tab`}
						>
							<span className="truncate">
								{entry.sessionName || entry.agentSessionId.split('-')[0].toUpperCase()}
							</span>
							<ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
						</button>
					)}
				</div>

				{/* Timestamp */}
				<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
					{formatTime(entry.timestamp)}
				</span>
			</div>

			{/* Summary - 3 lines max, strip markdown for list view */}
			<p
				className="text-xs leading-relaxed overflow-hidden"
				style={{
					color: theme.colors.textMain,
					display: '-webkit-box',
					WebkitLineClamp: 3,
					WebkitBoxOrient: 'vertical' as const,
				}}
			>
				{entry.summary ? stripMarkdown(entry.summary) : 'No summary available'}
			</p>

			{/* Footer Row - Time, Cost, and Achievement Action */}
			{(entry.elapsedTimeMs !== undefined ||
				(entry.usageStats && entry.usageStats.totalCostUsd > 0) ||
				entry.achievementAction) && (
				<div
					className="flex items-center gap-3 mt-2 pt-2 border-t"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Elapsed Time */}
					{entry.elapsedTimeMs !== undefined && (
						<div className="flex items-center gap-1">
							<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							<span className="text-[10px] font-mono" style={{ color: theme.colors.textDim }}>
								{formatElapsedTime(entry.elapsedTimeMs)}
							</span>
						</div>
					)}
					{/* Cost */}
					{entry.usageStats && entry.usageStats.totalCostUsd > 0 && (
						<span
							className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full"
							style={{
								backgroundColor: theme.colors.success + '15',
								color: theme.colors.success,
								border: `1px solid ${theme.colors.success}30`,
							}}
						>
							${entry.usageStats.totalCostUsd.toFixed(2)}
						</span>
					)}
					{/* Achievement Action Button */}
					{entry.achievementAction === 'openAbout' && onOpenAboutModal && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onOpenAboutModal();
							}}
							className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors hover:opacity-80 ml-auto"
							style={{
								backgroundColor: theme.colors.warning + '20',
								color: theme.colors.warning,
								border: `1px solid ${theme.colors.warning}40`,
							}}
							title="View achievements"
						>
							<Award className="w-3 h-3" />
							View Achievements
						</button>
					)}
				</div>
			)}
		</div>
	);
});

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
		const [searchFilterOpen, setSearchFilterOpen] = useState(false);
		const [graphReferenceTime, setGraphReferenceTime] = useState<number | undefined>(undefined);
		const [helpModalOpen, setHelpModalOpen] = useState(false);
		const [graphLookbackHours, setGraphLookbackHours] = useState<number | null>(null); // default to "All time"

		const listRef = useRef<HTMLDivElement>(null);
		const searchInputRef = useRef<HTMLInputElement>(null);
		const hasRestoredScroll = useRef<boolean>(false);

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

		// Filter entries based on active filters and search text
		const allFilteredEntries = useMemo(
			() =>
				historyEntries.filter((entry) => {
					if (!entry || !entry.type) return false;
					if (!activeFilters.has(entry.type)) return false;

					// Apply text search filter
					if (searchFilter) {
						const searchLower = searchFilter.toLowerCase();
						const summaryMatch = entry.summary?.toLowerCase().includes(searchLower);
						const responseMatch = entry.fullResponse?.toLowerCase().includes(searchLower);
						// Search by session ID (full ID or short octet form)
						const sessionIdMatch = entry.agentSessionId?.toLowerCase().includes(searchLower);
						const sessionNameMatch = entry.sessionName?.toLowerCase().includes(searchLower);
						if (!summaryMatch && !responseMatch && !sessionIdMatch && !sessionNameMatch)
							return false;
					}

					return true;
				}),
			[historyEntries, activeFilters, searchFilter]
		);

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

		// Reset selected index and graph reference time when filters change
		useEffect(() => {
			setSelectedIndex(-1);
			setGraphReferenceTime(undefined); // Reset to "now" when filters change
			// Scroll to top when filters change
			if (listRef.current) {
				listRef.current.scrollTop = 0;
			}
		}, [activeFilters, searchFilter, setSelectedIndex]);

		// Scroll selected item into view when selectedIndex changes (keyboard navigation)
		useEffect(() => {
			if (selectedIndex >= 0 && selectedIndex < allFilteredEntries.length) {
				virtualizer.scrollToIndex(selectedIndex, { align: 'auto', behavior: 'smooth' });
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

		// Get pill color based on type (used by filter buttons in header)
		const getPillColor = (type: HistoryEntryType) => {
			switch (type) {
				case 'AUTO':
					return {
						bg: theme.colors.warning + '20',
						text: theme.colors.warning,
						border: theme.colors.warning + '40',
					};
				case 'USER':
					return {
						bg: theme.colors.accent + '20',
						text: theme.colors.accent,
						border: theme.colors.accent + '40',
					};
				default:
					return {
						bg: theme.colors.bgActivity,
						text: theme.colors.textDim,
						border: theme.colors.border,
					};
			}
		};

		// Get icon for entry type (used by filter buttons in header)
		const getEntryIcon = (type: HistoryEntryType) => {
			switch (type) {
				case 'AUTO':
					return Bot;
				case 'USER':
					return User;
				default:
					return Bot;
			}
		};

		return (
			<div className="flex flex-col h-full">
				{/* Filter Pills + Activity Graph + Help Button */}
				<div className="flex items-start gap-3 mb-4 pt-2">
					{/* Left-justified filter pills */}
					<div className="flex gap-2 flex-shrink-0">
						{(['AUTO', 'USER'] as HistoryEntryType[]).map((type) => {
							const isActive = activeFilters.has(type);
							const colors = getPillColor(type);
							const Icon = getEntryIcon(type);

							return (
								<button
									key={type}
									onClick={() => toggleFilter(type)}
									className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold uppercase transition-all ${
										isActive ? 'opacity-100' : 'opacity-40'
									}`}
									style={{
										backgroundColor: isActive ? colors.bg : 'transparent',
										color: isActive ? colors.text : theme.colors.textDim,
										border: `1px solid ${isActive ? colors.border : theme.colors.border}`,
									}}
								>
									<Icon className="w-3 h-3" />
									{type}
								</button>
							);
						})}
					</div>

					{/* 24-hour activity bar graph */}
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
									: 'No entries match the selected filters.'}
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
