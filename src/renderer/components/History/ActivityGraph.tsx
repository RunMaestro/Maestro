import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Check } from 'lucide-react';
import type { Theme, HistoryEntry } from '../../types';
import { LOOKBACK_OPTIONS, CUE_COLOR } from './historyConstants';
import { useContextMenuPosition } from '../../hooks/ui/useContextMenuPosition';

/** Pre-computed activity graph bucket from backend */
export interface GraphBucket {
	auto: number;
	user: number;
	cue: number;
}

// Activity bar graph component with configurable lookback window
export interface ActivityGraphProps {
	entries: HistoryEntry[];
	theme: Theme;
	viewportRange?: { start: number; end: number }; // Timestamps of currently visible entries in the list
	onBarClick?: (bucketStartTime: number, bucketEndTime: number) => void;
	lookbackHours: number | null; // null = all time
	onLookbackChange: (hours: number | null) => void;
	/** Pre-computed buckets from backend (uses all entries, not just first page) */
	precomputedBuckets?: GraphBucket[];
	/**
	 * Time range that `precomputedBuckets` actually spans. When the buckets
	 * come from the server's all-time aggregate, the renderer's loaded
	 * `entries` won't contain the earliest entry — so deriving the axis
	 * range from `entries` would mismatch the buckets. Pass the server's
	 * earliest/latest here to keep them aligned.
	 */
	precomputedRange?: { start: number; end: number };
	/** Always show the viewport date label, repositioning near edges instead of hiding */
	alwaysShowViewportLabel?: boolean;
}

export const ActivityGraph: React.FC<ActivityGraphProps> = ({
	entries,
	theme,
	viewportRange,
	onBarClick,
	lookbackHours,
	onLookbackChange,
	precomputedBuckets,
	precomputedRange,
	alwaysShowViewportLabel = false,
}) => {
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const graphRef = useRef<HTMLDivElement>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);
	const {
		left: contextMenuLeft,
		top: contextMenuTop,
		ready: contextMenuReady,
	} = useContextMenuPosition(contextMenuRef, contextMenu?.x ?? 0, contextMenu?.y ?? 0);

	// Get the current lookback config
	const lookbackConfig = useMemo(
		() => LOOKBACK_OPTIONS.find((o) => o.hours === lookbackHours) || LOOKBACK_OPTIONS[0],
		[lookbackHours]
	);

	// Always use current time as the end of the window (graph is static).
	// When a precomputed range is provided, prefer its `end` so the axis
	// stays consistent with the server's snapshot.
	const endTime = precomputedRange?.end ?? Date.now();

	// Calculate time range based on lookback setting
	const { startTime, msPerBucket, bucketCount } = useMemo(() => {
		if (lookbackHours === null) {
			// All time: server-side range wins when provided; otherwise fall
			// back to deriving from currently-loaded entries.
			const earliest =
				precomputedRange?.start ??
				(entries.length > 0
					? Math.min(...entries.map((e) => e.timestamp))
					: endTime - 24 * 60 * 60 * 1000);
			const totalMs = Math.max(endTime - earliest, 1);
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
	}, [entries, endTime, lookbackHours, lookbackConfig.bucketCount, precomputedRange]);

	// Group entries into buckets — use precomputed data from backend when available
	const bucketData = useMemo(() => {
		// Prefer backend-computed buckets (covers all entries, not just first page)
		if (precomputedBuckets && precomputedBuckets.length === bucketCount) {
			return precomputedBuckets;
		}

		// Fallback: client-side bucketing from available entries
		const buckets: { auto: number; user: number; cue: number }[] = Array.from(
			{ length: bucketCount },
			() => ({
				auto: 0,
				user: 0,
				cue: 0,
			})
		);

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
					} else if (entry.type === 'CUE') {
						buckets[bucketIndex].cue++;
					}
				}
			}
		});

		return buckets;
	}, [precomputedBuckets, entries, startTime, endTime, msPerBucket, bucketCount]);

	// Find max value for scaling
	const maxValue = useMemo(() => {
		return Math.max(1, ...bucketData.map((h) => h.auto + h.user + h.cue));
	}, [bucketData]);

	// Total counts for summary tooltip
	const totalAuto = useMemo(() => bucketData.reduce((sum, h) => sum + h.auto, 0), [bucketData]);
	const totalUser = useMemo(() => bucketData.reduce((sum, h) => sum + h.user, 0), [bucketData]);
	const totalCue = useMemo(() => bucketData.reduce((sum, h) => sum + h.cue, 0), [bucketData]);

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
		const total = bucketData[index].auto + bucketData[index].user + bucketData[index].cue;
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

	// Compute viewport indicator position as a percentage (0% = left/oldest, 100% = right/now)
	// Uses the newest visible entry's timestamp to position the indicator
	const viewportIndicatorPercent = useMemo(() => {
		if (!viewportRange) return null;
		const totalMs = endTime - startTime;
		if (totalMs <= 0) return null;
		const percent = ((viewportRange.end - startTime) / totalMs) * 100;
		return Math.max(0, Math.min(100, percent));
	}, [viewportRange, startTime, endTime]);

	// Format the viewport indicator timestamp for display in the axis row
	const viewportIndicatorLabel = useMemo(() => {
		if (!viewportRange) return null;
		const ts = viewportRange.end;
		const date = new Date(ts);
		if (lookbackHours !== null && lookbackHours <= 24) {
			// Short lookback: show time of day
			const hour = date.getHours();
			const min = date.getMinutes();
			const ampm = hour >= 12 ? 'PM' : 'AM';
			const hour12 = hour % 12 || 12;
			return `${hour12}:${min.toString().padStart(2, '0')}${ampm}`;
		}
		// Longer lookback or all-time: show date
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}, [viewportRange, lookbackHours]);

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
					? `${lookbackConfig.label}: ${totalAuto} auto, ${totalUser} user${totalCue > 0 ? `, ${totalCue} cue` : ''} (right-click to change)`
					: undefined
			}
			onContextMenu={handleContextMenu}
		>
			{/* Context menu for lookback options */}
			{contextMenu && (
				<div
					ref={contextMenuRef}
					className="fixed z-50 py-1 rounded border shadow-lg"
					style={{
						left: contextMenuLeft,
						top: contextMenuTop,
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						minWidth: '120px',
						opacity: contextMenuReady ? 1 : 0,
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
						<div className="flex items-center justify-between gap-3">
							<span style={{ color: CUE_COLOR }}>Cue</span>
							<span className="font-bold" style={{ color: CUE_COLOR }}>
								{bucketData[hoveredIndex].cue}
							</span>
						</div>
					</div>
				</div>
			)}

			{/* Graph container with border */}
			<div
				className="flex items-end gap-px h-6 rounded border px-1 pt-1 relative"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Viewport position indicator — shows where you are in the history */}
				{viewportIndicatorPercent !== null && (
					<div
						className="absolute top-0 bottom-0 pointer-events-none z-20"
						style={{
							left: `${viewportIndicatorPercent}%`,
							width: '2px',
							backgroundColor: theme.colors.error,
							transition: 'left 0.15s ease-out',
						}}
					/>
				)}
				{bucketData.map((bucket, index) => {
					const total = bucket.auto + bucket.user + bucket.cue;
					const heightPercent = total > 0 ? (total / maxValue) * 100 : 0;
					const autoPercent = total > 0 ? (bucket.auto / total) * 100 : 0;
					const cuePercent = total > 0 ? (bucket.cue / total) * 100 : 0;
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
								{/* Cue portion (middle) - cyan */}
								{bucket.cue > 0 && (
									<div
										style={{
											height: `${cuePercent}%`,
											backgroundColor: CUE_COLOR,
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
				{axisLabels.map(({ label, index }) => {
					// When alwaysShowViewportLabel is on, fade out edge axis labels that would overlap
					const isRightEdge = index === bucketCount - 1;
					const isLeftEdge = index === 0;
					const hideForIndicator =
						alwaysShowViewportLabel &&
						viewportIndicatorPercent !== null &&
						viewportIndicatorLabel &&
						((isRightEdge && viewportIndicatorPercent >= 88) ||
							(isLeftEdge && viewportIndicatorPercent <= 12));

					return (
						<span
							key={`${label}-${index}`}
							className="absolute text-[8px] font-mono"
							style={{
								color: theme.colors.textDim,
								left: isLeftEdge
									? '0'
									: isRightEdge
										? 'auto'
										: `${(index / (bucketCount - 1)) * 100}%`,
								right: isRightEdge ? '0' : 'auto',
								transform: index > 0 && index < bucketCount - 1 ? 'translateX(-50%)' : 'none',
								opacity: hideForIndicator ? 0 : 1,
								transition: hideForIndicator !== undefined ? 'opacity 0.15s ease-out' : undefined,
							}}
						>
							{label}
						</span>
					);
				})}
				{/* Viewport indicator label */}
				{viewportIndicatorPercent !== null &&
					viewportIndicatorLabel &&
					(alwaysShowViewportLabel ||
						(viewportIndicatorPercent > 12 && viewportIndicatorPercent < 88)) && (
						<span
							className="absolute text-[8px] font-mono"
							data-testid="viewport-indicator-label"
							style={{
								color: theme.colors.error,
								left:
									alwaysShowViewportLabel && viewportIndicatorPercent <= 12
										? `${viewportIndicatorPercent}%`
										: alwaysShowViewportLabel && viewportIndicatorPercent >= 88
											? 'auto'
											: `${viewportIndicatorPercent}%`,
								right: alwaysShowViewportLabel && viewportIndicatorPercent >= 88 ? '0' : 'auto',
								transform:
									alwaysShowViewportLabel &&
									(viewportIndicatorPercent <= 12 || viewportIndicatorPercent >= 88)
										? 'none'
										: 'translateX(-50%)',
								transition: 'left 0.15s ease-out',
							}}
						>
							{viewportIndicatorLabel}
						</span>
					)}
			</div>
		</div>
	);
};
