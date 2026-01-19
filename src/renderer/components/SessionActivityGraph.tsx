import React, { useState, useEffect, useMemo } from 'react';
import { Check } from 'lucide-react';
import type { Theme } from '../types';

// Lookback period options for the activity graph
export type LookbackPeriod = {
	label: string;
	hours: number | null; // null = all time
	bucketCount: number;
};

export const LOOKBACK_OPTIONS: LookbackPeriod[] = [
	{ label: '24 hours', hours: 24, bucketCount: 24 },
	{ label: '72 hours', hours: 72, bucketCount: 24 },
	{ label: '1 week', hours: 168, bucketCount: 28 },
	{ label: '2 weeks', hours: 336, bucketCount: 28 },
	{ label: '1 month', hours: 720, bucketCount: 30 },
	{ label: '6 months', hours: 4320, bucketCount: 24 },
	{ label: '1 year', hours: 8760, bucketCount: 24 },
	{ label: 'All time', hours: null, bucketCount: 24 },
];

// Generic entry type - just needs timestamp
export interface ActivityEntry {
	timestamp: string | number;
}

interface SessionActivityGraphProps {
	entries: ActivityEntry[];
	theme: Theme;
	onBarClick?: (bucketStartTime: number, bucketEndTime: number) => void;
	lookbackHours: number | null; // null = all time
	onLookbackChange: (hours: number | null) => void;
	className?: string;
}

export const SessionActivityGraph: React.FC<SessionActivityGraphProps> = ({
	entries,
	theme,
	onBarClick,
	lookbackHours,
	onLookbackChange,
	className = '',
}) => {
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

	// Get the current lookback config
	const lookbackConfig = useMemo(
		() =>
			LOOKBACK_OPTIONS.find((o) => o.hours === lookbackHours) ||
			LOOKBACK_OPTIONS[LOOKBACK_OPTIONS.length - 1], // Default to "All time"
		[lookbackHours]
	);

	// Use current time as the end of our window - stabilized to avoid recalculation on every render
	const endTime = useMemo(() => Date.now(), [entries.length, lookbackHours]);

	// Calculate time range based on lookback setting
	const { startTime, msPerBucket, bucketCount } = useMemo(() => {
		// Convert entries to timestamps for calculation
		const timestamps = entries.map((e) =>
			typeof e.timestamp === 'string' ? new Date(e.timestamp).getTime() : e.timestamp
		);

		if (lookbackHours === null) {
			// All time: find earliest entry
			const earliest =
				timestamps.length > 0 ? Math.min(...timestamps) : endTime - 24 * 60 * 60 * 1000;
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
		const buckets: number[] = Array.from({ length: bucketCount }, () => 0);

		entries.forEach((entry) => {
			const timestamp =
				typeof entry.timestamp === 'string' ? new Date(entry.timestamp).getTime() : entry.timestamp;
			if (timestamp >= startTime && timestamp <= endTime) {
				const bucketIndex = Math.min(
					bucketCount - 1,
					Math.floor((timestamp - startTime) / msPerBucket)
				);
				if (bucketIndex >= 0 && bucketIndex < bucketCount) {
					buckets[bucketIndex]++;
				}
			}
		});

		return buckets;
	}, [entries, startTime, endTime, msPerBucket, bucketCount]);

	// Find max value for scaling
	const maxValue = useMemo(() => {
		return Math.max(1, ...bucketData);
	}, [bucketData]);

	// Total count for summary tooltip
	const totalSessions = useMemo(
		() => bucketData.reduce((sum, count) => sum + count, 0),
		[bucketData]
	);

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
		const count = bucketData[index];
		if (count > 0 && onBarClick) {
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
			className={`flex-1 min-w-0 flex flex-col relative ${className}`}
			title={
				hoveredIndex === null
					? `${lookbackConfig.label}: ${totalSessions} session${totalSessions !== 1 ? 's' : ''} (right-click to change)`
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
					<div className="font-bold mb-0.5" style={{ color: theme.colors.textMain }}>
						{getTimeRangeLabel(hoveredIndex)}
					</div>
					<div className="flex items-center justify-between gap-3">
						<span style={{ color: theme.colors.textDim }}>Sessions</span>
						<span className="font-bold" style={{ color: theme.colors.accent }}>
							{bucketData[hoveredIndex]}
						</span>
					</div>
				</div>
			)}

			{/* Graph container with border */}
			<div
				className="flex items-end gap-px h-6 rounded border px-1 pt-1"
				style={{ borderColor: theme.colors.border }}
			>
				{bucketData.map((count, index) => {
					const heightPercent = count > 0 ? (count / maxValue) * 100 : 0;
					const isHovered = hoveredIndex === index;

					return (
						<div
							key={index}
							className="flex-1 min-w-0 flex flex-col justify-end rounded-t-sm overflow-visible cursor-pointer"
							style={{
								height: '100%',
								opacity: count > 0 ? 1 : 0.15,
								transform: isHovered ? 'scaleX(1.5)' : 'scaleX(1)',
								zIndex: isHovered ? 10 : 1,
								transition: 'transform 0.1s ease-out',
								cursor: count > 0 ? 'pointer' : 'default',
							}}
							onMouseEnter={() => setHoveredIndex(index)}
							onMouseLeave={() => setHoveredIndex(null)}
							onClick={() => handleBarClick(index)}
						>
							<div
								className="w-full rounded-t-sm overflow-hidden"
								style={{
									height: `${Math.max(heightPercent, count > 0 ? 15 : 8)}%`,
									minHeight: count > 0 ? '3px' : '1px',
									backgroundColor: count > 0 ? theme.colors.accent : theme.colors.border,
								}}
							/>
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
