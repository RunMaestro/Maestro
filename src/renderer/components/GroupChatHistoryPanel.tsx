/**
 * GroupChatHistoryPanel.tsx
 *
 * History panel for group chats showing task completion history.
 * Features a multi-color activity graph where each participant has their own color.
 * History entries are logged by the moderator when agents complete tasks.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Check } from 'lucide-react';
import type { Theme } from '../types';
import type { GroupChatHistoryEntry } from '../../shared/group-chat-types';

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
	{ label: 'All time', hours: null, bucketCount: 24 },
];

interface GroupChatActivityGraphProps {
	entries: GroupChatHistoryEntry[];
	theme: Theme;
	participantColors: Record<string, string>;
	lookbackHours: number | null;
	onLookbackChange: (hours: number | null) => void;
	onBarClick?: (bucketStartTime: number, bucketEndTime: number) => void;
}

/**
 * Multi-participant activity graph.
 * Shows stacked bars with each participant's contribution in their assigned color.
 */
function GroupChatActivityGraph({
	entries,
	theme,
	participantColors,
	lookbackHours,
	onLookbackChange,
	onBarClick,
}: GroupChatActivityGraphProps) {
	const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
	const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

	// Get the current lookback config
	const lookbackConfig = useMemo(
		() => LOOKBACK_OPTIONS.find((o) => o.hours === lookbackHours) || LOOKBACK_OPTIONS[0],
		[lookbackHours]
	);

	const endTime = Date.now();

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

	// Get unique participants in order of first appearance
	const participantOrder = useMemo(() => {
		const seen = new Set<string>();
		const order: string[] = [];
		for (const entry of [...entries].sort((a, b) => a.timestamp - b.timestamp)) {
			if (!seen.has(entry.participantName)) {
				seen.add(entry.participantName);
				order.push(entry.participantName);
			}
		}
		return order;
	}, [entries]);

	// Group entries into buckets by participant
	const bucketData = useMemo(() => {
		const buckets: Record<string, number>[] = Array.from({ length: bucketCount }, () => ({}));

		entries.forEach((entry) => {
			if (entry.timestamp >= startTime && entry.timestamp <= endTime) {
				const bucketIndex = Math.min(
					bucketCount - 1,
					Math.floor((entry.timestamp - startTime) / msPerBucket)
				);
				if (bucketIndex >= 0 && bucketIndex < bucketCount) {
					if (!buckets[bucketIndex][entry.participantName]) {
						buckets[bucketIndex][entry.participantName] = 0;
					}
					buckets[bucketIndex][entry.participantName]++;
				}
			}
		});

		return buckets;
	}, [entries, startTime, endTime, msPerBucket, bucketCount]);

	// Find max value for scaling
	const maxValue = useMemo(() => {
		return Math.max(
			1,
			...bucketData.map((bucket) => Object.values(bucket).reduce((sum, count) => sum + count, 0))
		);
	}, [bucketData]);

	// Get time range label for tooltip
	const getTimeRangeLabel = (index: number) => {
		const bucketStart = new Date(startTime + index * msPerBucket);
		const bucketEnd = new Date(startTime + (index + 1) * msPerBucket);

		if (lookbackHours !== null && lookbackHours <= 72) {
			const formatHour = (date: Date) => {
				const hour = date.getHours();
				const ampm = hour >= 12 ? 'PM' : 'AM';
				const hour12 = hour % 12 || 12;
				return `${hour12}${ampm}`;
			};
			return `${formatHour(bucketStart)} - ${formatHour(bucketEnd)}`;
		} else {
			const formatDate = (date: Date) => {
				return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
			};
			if (formatDate(bucketStart) === formatDate(bucketEnd)) {
				return formatDate(bucketStart);
			}
			return `${formatDate(bucketStart)} - ${formatDate(bucketEnd)}`;
		}
	};

	// Handle bar click
	const handleBarClick = (index: number) => {
		const total = Object.values(bucketData[index]).reduce((sum, count) => sum + count, 0);
		if (total > 0 && onBarClick) {
			const start = startTime + index * msPerBucket;
			const end = startTime + (index + 1) * msPerBucket;
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
				{ label: '0h', index: bucketCount - 1 },
			];
		} else if (lookbackHours <= 168) {
			const days = Math.floor(lookbackHours / 24);
			return [
				{ label: `${days}d`, index: 0 },
				{ label: 'Now', index: bucketCount - 1 },
			];
		} else {
			return [
				{
					label: new Date(startTime).toLocaleDateString([], { month: 'short', day: 'numeric' }),
					index: 0,
				},
				{ label: 'Now', index: bucketCount - 1 },
			];
		}
	};

	const axisLabels = getAxisLabels();

	return (
		<div
			className="flex-1 min-w-0 flex flex-col relative mt-0.5"
			title={`${lookbackConfig.label} (right-click to change)`}
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
					</div>
					<div className="flex flex-col gap-0.5">
						{participantOrder
							.filter((name) => bucketData[hoveredIndex][name])
							.map((name) => (
								<div key={name} className="flex items-center justify-between gap-3">
									<span style={{ color: participantColors[name] || theme.colors.textDim }}>
										{name}
									</span>
									<span
										className="font-bold"
										style={{ color: participantColors[name] || theme.colors.textMain }}
									>
										{bucketData[hoveredIndex][name]}
									</span>
								</div>
							))}
						{Object.keys(bucketData[hoveredIndex]).length === 0 && (
							<div style={{ color: theme.colors.textDim }}>No activity</div>
						)}
					</div>
				</div>
			)}

			{/* Graph container with border */}
			<div
				className="flex items-end gap-px h-6 rounded border px-1 pt-1"
				style={{ borderColor: theme.colors.border }}
			>
				{bucketData.map((bucket, index) => {
					const total = Object.values(bucket).reduce((sum, count) => sum + count, 0);
					const heightPercent = total > 0 ? (total / maxValue) * 100 : 0;
					const isHovered = hoveredIndex === index;

					// Build stacked segments for each participant
					const segments: { name: string; percent: number; color: string }[] = [];
					for (const name of participantOrder) {
						if (bucket[name]) {
							const segmentPercent = (bucket[name] / total) * 100;
							segments.push({
								name,
								percent: segmentPercent,
								color: participantColors[name] || theme.colors.textDim,
							});
						}
					}

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
								{/* Stacked segments for each participant */}
								{segments.map((segment, segIndex) => (
									<div
										key={segIndex}
										style={{
											height: `${segment.percent}%`,
											backgroundColor: segment.color,
											minHeight: '1px',
										}}
									/>
								))}
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
}

interface GroupChatHistoryPanelProps {
	theme: Theme;
	groupChatId: string;
	entries: GroupChatHistoryEntry[];
	isLoading: boolean;
	participantColors: Record<string, string>;
	onJumpToMessage?: (timestamp: number) => void;
}

export function GroupChatHistoryPanel({
	theme,
	groupChatId,
	entries,
	isLoading,
	participantColors,
	onJumpToMessage,
}: GroupChatHistoryPanelProps): JSX.Element {
	const [lookbackHours, setLookbackHours] = useState<number | null>(24);
	const listRef = useRef<HTMLDivElement>(null);

	// Load lookback preference
	useEffect(() => {
		const loadLookbackPreference = async () => {
			const settingsKey = `groupChatHistoryLookback:${groupChatId}`;
			const saved = await window.maestro.settings.get(settingsKey);
			if (saved !== undefined) {
				setLookbackHours(saved as number | null);
			}
		};
		loadLookbackPreference();
	}, [groupChatId]);

	// Handler to update lookback and persist
	const handleLookbackChange = (hours: number | null) => {
		setLookbackHours(hours);
		const settingsKey = `groupChatHistoryLookback:${groupChatId}`;
		window.maestro.settings.set(settingsKey, hours);
	};

	// Handle bar click - scroll to entries in that time range
	const handleBarClick = (bucketStart: number, bucketEnd: number) => {
		const entriesInBucket = entries.filter(
			(e) => e.timestamp >= bucketStart && e.timestamp < bucketEnd
		);
		if (entriesInBucket.length > 0 && listRef.current) {
			// Find first entry element and scroll to it
			const firstEntryId = entriesInBucket[0].id;
			const element = listRef.current.querySelector(`[data-entry-id="${firstEntryId}"]`);
			if (element) {
				element.scrollIntoView({ block: 'center', behavior: 'smooth' });
			}
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

	return (
		<div className="flex-1 flex flex-col overflow-hidden p-3">
			{/* Activity Graph */}
			<div className="mb-3">
				<GroupChatActivityGraph
					entries={entries}
					theme={theme}
					participantColors={participantColors}
					lookbackHours={lookbackHours}
					onLookbackChange={handleLookbackChange}
					onBarClick={handleBarClick}
				/>
			</div>

			{/* History List */}
			<div ref={listRef} className="flex-1 overflow-y-auto space-y-2 scrollbar-thin">
				{isLoading ? (
					<div className="text-center py-8 text-xs opacity-50">Loading history...</div>
				) : entries.length === 0 ? (
					<div className="text-center py-8 text-xs opacity-50">
						No task history yet.
						<br />
						Entries will appear when agents complete tasks.
					</div>
				) : (
					entries.map((entry) => {
						// Prioritize the runtime-generated color map over the stored color
						// The stored color might be a default gray, but we want consistent colors from buildParticipantColorMap
						const participantColor =
							participantColors[entry.participantName] ||
							entry.participantColor ||
							theme.colors.accent;
						return (
							<div
								key={entry.id}
								data-entry-id={entry.id}
								onClick={() => onJumpToMessage?.(entry.timestamp)}
								className="p-2.5 rounded border transition-colors cursor-pointer hover:bg-white/5"
								style={{
									borderColor: theme.colors.border,
									borderLeftWidth: '3px',
									borderLeftColor: participantColor,
								}}
							>
								{/* Header Row */}
								<div className="flex items-center justify-between mb-1.5">
									{/* Participant Name Pill */}
									<span
										className="px-2 py-0.5 rounded text-[10px] font-bold"
										style={{
											backgroundColor: participantColor + '25',
											color: participantColor,
											border: `1px solid ${participantColor}50`,
										}}
									>
										{entry.participantName}
									</span>
									{/* Timestamp */}
									<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
										{formatTime(entry.timestamp)}
									</span>
								</div>

								{/* Summary - full text */}
								<p className="text-xs leading-relaxed" style={{ color: theme.colors.textMain }}>
									{entry.summary}
								</p>

								{/* Footer with cost */}
								{entry.cost !== undefined && entry.cost > 0 && (
									<div className="flex items-center gap-2 mt-1.5">
										<span
											className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full"
											style={{
												backgroundColor: theme.colors.success + '15',
												color: theme.colors.success,
												border: `1px solid ${theme.colors.success}30`,
											}}
										>
											${entry.cost.toFixed(2)}
										</span>
									</div>
								)}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
