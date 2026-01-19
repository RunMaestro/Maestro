/**
 * PullToRefresh Component for Maestro Mobile Web
 *
 * A visual indicator for pull-to-refresh functionality.
 * Shows progress during pull and a spinner during refresh.
 */

import React from 'react';
import { useThemeColors } from './ThemeProvider';

export interface PullToRefreshIndicatorProps {
	/** Current pull distance in pixels */
	pullDistance: number;
	/** Progress from 0 to 1 (1 = threshold reached) */
	progress: number;
	/** Whether currently refreshing */
	isRefreshing: boolean;
	/** Whether the threshold has been reached */
	isThresholdReached: boolean;
	/** Optional custom styles */
	style?: React.CSSProperties;
}

/**
 * Spinning refresh icon component
 */
function RefreshIcon({
	size = 24,
	color,
	spinning = false,
	progress = 1,
}: {
	size?: number;
	color: string;
	spinning?: boolean;
	progress?: number;
}) {
	// Rotate based on progress or spin continuously when refreshing
	const rotation = spinning ? 0 : progress * 360;
	const animationStyle: React.CSSProperties = spinning
		? { animation: 'spin 1s linear infinite' }
		: { transform: `rotate(${rotation}deg)` };

	return (
		<>
			{spinning && (
				<style>
					{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}
				</style>
			)}
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="none"
				stroke={color}
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={animationStyle}
			>
				<path d="M21 12a9 9 0 1 1-6.219-8.56" />
				<polyline points="21 3 21 9 15 9" />
			</svg>
		</>
	);
}

/**
 * Arrow down icon for pull indicator
 */
function ArrowDownIcon({
	size = 24,
	color,
	progress = 0,
}: {
	size?: number;
	color: string;
	progress?: number;
}) {
	// Rotate arrow to point up when threshold is reached
	const rotation = progress >= 1 ? 180 : 0;

	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke={color}
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{
				transform: `rotate(${rotation}deg)`,
				transition: 'transform 0.2s ease',
			}}
		>
			<line x1="12" y1="5" x2="12" y2="19" />
			<polyline points="19 12 12 19 5 12" />
		</svg>
	);
}

/**
 * Pull-to-refresh visual indicator component
 *
 * @example
 * ```tsx
 * <PullToRefreshIndicator
 *   pullDistance={pullDistance}
 *   progress={progress}
 *   isRefreshing={isRefreshing}
 *   isThresholdReached={isThresholdReached}
 * />
 * ```
 */
export function PullToRefreshIndicator({
	pullDistance,
	progress,
	isRefreshing,
	isThresholdReached,
	style,
}: PullToRefreshIndicatorProps) {
	const colors = useThemeColors();

	// Don't render if not pulling and not refreshing
	if (pullDistance === 0 && !isRefreshing) {
		return null;
	}

	// Calculate opacity based on progress
	const opacity = Math.min(progress * 1.5, 1);

	// Calculate scale for a nice pop effect when threshold is reached
	const scale = isThresholdReached || isRefreshing ? 1 : 0.8 + progress * 0.2;

	// Background becomes more visible as you pull
	const bgOpacity = Math.min(progress * 0.3, 0.2);

	return (
		<div
			style={{
				position: 'absolute',
				top: 0,
				left: 0,
				right: 0,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				height: `${Math.max(pullDistance, isRefreshing ? 60 : 0)}px`,
				overflow: 'hidden',
				backgroundColor: `rgba(${hexToRgb(colors.accent)}, ${bgOpacity})`,
				transition: isRefreshing ? 'height 0.3s ease' : 'none',
				...style,
			}}
		>
			<div
				style={{
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					gap: '4px',
					opacity,
					transform: `scale(${scale})`,
					transition: 'transform 0.15s ease',
				}}
			>
				{isRefreshing ? (
					<RefreshIcon color={colors.accent} spinning={true} />
				) : (
					<ArrowDownIcon color={colors.accent} progress={progress} />
				)}
				<span
					style={{
						fontSize: '12px',
						color: colors.textDim,
						fontWeight: 500,
					}}
				>
					{isRefreshing
						? 'Refreshing...'
						: isThresholdReached
							? 'Release to refresh'
							: 'Pull to refresh'}
				</span>
			</div>
		</div>
	);
}

/**
 * Wrapper component that provides pull-to-refresh functionality
 * Combines the hook and indicator into one convenient component
 */
export interface PullToRefreshWrapperProps {
	/** Called when pull-to-refresh is triggered */
	onRefresh: () => Promise<void> | void;
	/** Whether pull-to-refresh is enabled (default: true) */
	enabled?: boolean;
	/** Children to render inside the scrollable container */
	children: React.ReactNode;
	/** Style for the outer container */
	style?: React.CSSProperties;
	/** Style for the scrollable content area */
	contentStyle?: React.CSSProperties;
	/** Additional class name for the container */
	className?: string;
}

/**
 * Helper function to convert a hex or rgb(a) color to RGB values
 */
function hexToRgb(color: string): string {
	const trimmed = color.trim();

	if (trimmed.startsWith('rgb')) {
		const match = trimmed.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
		if (match) {
			const r = Math.round(parseFloat(match[1]));
			const g = Math.round(parseFloat(match[2]));
			const b = Math.round(parseFloat(match[3]));
			return `${r}, ${g}, ${b}`;
		}
	}

	let cleanHex = trimmed.replace('#', '');

	if (cleanHex.length === 3 || cleanHex.length === 4) {
		cleanHex = cleanHex
			.slice(0, 3)
			.split('')
			.map((value) => value + value)
			.join('');
	}

	if (cleanHex.length === 8) {
		cleanHex = cleanHex.slice(0, 6);
	}

	if (!/^[\da-fA-F]{6}$/.test(cleanHex)) {
		return '0, 0, 0';
	}

	const bigint = parseInt(cleanHex, 16);
	const r = (bigint >> 16) & 255;
	const g = (bigint >> 8) & 255;
	const b = bigint & 255;

	return `${r}, ${g}, ${b}`;
}

export default PullToRefreshIndicator;
