import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Check } from 'lucide-react';
import type { Theme, HistoryEntry } from '../../types';
import { LOOKBACK_OPTIONS } from './historyConstants';
import { useI18n } from '../../hooks/useI18n';
import { getActiveLocale } from '../../utils/formatters';
import { useContextMenuPosition } from '../../hooks/ui/useContextMenuPosition';

// Activity bar graph component with configurable lookback window
export interface ActivityGraphProps {
	entries: HistoryEntry[];
	theme: Theme;
	referenceTime?: number; // The "end" of the window (defaults to now)
	onBarClick?: (bucketStartTime: number, bucketEndTime: number) => void;
	lookbackHours: number | null; // null = all time
	onLookbackChange: (hours: number | null) => void;
}

export const ActivityGraph: React.FC<ActivityGraphProps> = ({
	entries,
	theme,
	referenceTime,
	onBarClick,
	lookbackHours,
	onLookbackChange,
}) => {
	const { t } = useI18n();
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
	const graphRef = useRef<HTMLDivElement>(null);
	const contextMenuRef = useRef<HTMLDivElement>(null);
	const contextMenuPos = useContextMenuPosition(
		contextMenuRef,
		contextMenu?.x ?? 0,
		contextMenu?.y ?? 0
	);

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
				return date.toLocaleDateString(getActiveLocale(), { month: 'short', day: 'numeric' });
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

		if (diffMins < 1) return t('history.graph.now_label');
		if (diffMins < 60) return t('history.graph.minutes_ago', { count: diffMins });
		if (diffHours < 24) return t('history.graph.hours_ago', { count: diffHours });
		return new Date(endTime).toLocaleDateString(getActiveLocale(), {
			month: 'short',
			day: 'numeric',
		});
	};

	// Check if we're viewing historical data (not "now")
	const isHistorical = referenceTime && Date.now() - referenceTime > 60000;

	// Generate labels for the x-axis
	const getAxisLabels = () => {
		if (lookbackHours === null) {
			// All time - show start and end dates
			return [
				{
					label: new Date(startTime).toLocaleDateString(getActiveLocale(), {
						month: 'short',
						day: 'numeric',
					}),
					index: 0,
				},
				{ label: t('history.graph.now_label'), index: bucketCount - 1 },
			];
		} else if (lookbackHours <= 24) {
			return [
				{ label: t('time.hours_short', { count: lookbackHours }), index: 0 },
				{
					label: t('time.hours_short', { count: Math.floor((lookbackHours * 2) / 3) }),
					index: Math.floor(bucketCount / 3),
				},
				{
					label: t('time.hours_short', { count: Math.floor(lookbackHours / 3) }),
					index: Math.floor((bucketCount * 2) / 3),
				},
				{ label: t('time.hours_short', { count: 0 }), index: bucketCount - 1 },
			];
		} else if (lookbackHours <= 168) {
			// Up to 1 week - show days
			const days = Math.floor(lookbackHours / 24);
			return [
				{ label: t('time.days_short', { count: days }), index: 0 },
				{
					label: t('time.days_short', { count: Math.floor(days / 2) }),
					index: Math.floor(bucketCount / 2),
				},
				{ label: t('history.graph.now_label'), index: bucketCount - 1 },
			];
		} else {
			// Longer periods - show start/end
			const startLabel = new Date(startTime).toLocaleDateString(getActiveLocale(), {
				month: 'short',
				day: 'numeric',
			});
			return [
				{ label: startLabel, index: 0 },
				{ label: t('history.graph.now_label'), index: bucketCount - 1 },
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
					? isHistorical
						? t('history.graph.tooltip_viewing', {
								time: formatReferenceTime(),
								period: t(lookbackConfig.tKey, { defaultValue: lookbackConfig.label }),
								autoCount: totalAuto,
								userCount: totalUser,
							})
						: t('history.graph.tooltip', {
								period: t(lookbackConfig.tKey, { defaultValue: lookbackConfig.label }),
								autoCount: totalAuto,
								userCount: totalUser,
							})
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
						left: contextMenuPos.left,
						top: contextMenuPos.top,
						opacity: contextMenuPos.ready ? 1 : 0,
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
						minWidth: '120px',
					}}
				>
					<div
						className="px-3 py-1 text-[10px] font-bold uppercase"
						style={{ color: theme.colors.textDim }}
					>
						{t('history.graph.lookback_period')}
					</div>
					{LOOKBACK_OPTIONS.map((option) => (
						<button
							key={option.hours ?? 'all'}
							className="w-full px-3 py-1.5 text-left text-xs hover:bg-white/10 transition-colors flex items-center justify-between"
							style={{
								color: option.hours === lookbackHours ? theme.colors.accent : theme.colors.textMain,
							}}
							onClick={() => {
								onLookbackChange(option.hours);
								setContextMenu(null);
							}}
						>
							{t(option.tKey, { defaultValue: option.label })}
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
							<span style={{ color: theme.colors.warning }}>{t('history.graph.auto_label')}</span>
							<span className="font-bold" style={{ color: theme.colors.warning }}>
								{bucketData[hoveredIndex].auto}
							</span>
						</div>
						<div className="flex items-center justify-between gap-3">
							<span style={{ color: theme.colors.accent }}>{t('history.graph.user_label')}</span>
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
