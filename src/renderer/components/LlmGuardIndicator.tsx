/**
 * LlmGuardIndicator
 *
 * Status indicator component for LLM Guard that displays in the tab bar.
 * Shows guard status with color-coded shield icons:
 * - Gray shield: Guard disabled
 * - Green shield: Guard active, no issues
 * - Yellow shield: Guard active, warnings detected
 * - Red shield: Guard active, content blocked
 *
 * Features:
 * - Subtle pulse animation when actively scanning
 * - Tooltip showing last scan summary on hover
 * - Click to open Security tab in Right Bar
 */

import React, { useState, useEffect, useRef, memo, useCallback } from 'react';
import { Shield, ShieldAlert, ShieldCheck, ShieldX, ShieldOff } from 'lucide-react';
import type { Theme } from '../types';
import type { SecurityEventData } from '../../main/preload/security';
import { useUIStore } from '../stores/uiStore';

export type LlmGuardStatus = 'disabled' | 'active' | 'warning' | 'blocked' | 'scanning';

interface LlmGuardIndicatorProps {
	theme: Theme;
	/** Whether LLM Guard is enabled */
	enabled: boolean;
	/** Current session ID to filter events (optional - if not provided, shows all events) */
	sessionId?: string;
}

// Status colors and icons
const getStatusConfig = (status: LlmGuardStatus, theme: Theme) => {
	switch (status) {
		case 'disabled':
			return {
				Icon: ShieldOff,
				color: theme.colors.textDim,
				bgColor: 'transparent',
				label: 'LLM Guard disabled',
			};
		case 'active':
			return {
				Icon: ShieldCheck,
				color: theme.colors.success,
				bgColor: theme.colors.success + '20',
				label: 'LLM Guard active, no issues',
			};
		case 'warning':
			return {
				Icon: ShieldAlert,
				color: theme.colors.warning,
				bgColor: theme.colors.warning + '20',
				label: 'LLM Guard: warnings detected',
			};
		case 'blocked':
			return {
				Icon: ShieldX,
				color: theme.colors.error,
				bgColor: theme.colors.error + '20',
				label: 'LLM Guard: content blocked',
			};
		case 'scanning':
			return {
				Icon: Shield,
				color: theme.colors.accent,
				bgColor: theme.colors.accent + '20',
				label: 'Scanning...',
			};
		default:
			return {
				Icon: Shield,
				color: theme.colors.textDim,
				bgColor: 'transparent',
				label: 'LLM Guard',
			};
	}
};

export const LlmGuardIndicator = memo(function LlmGuardIndicator({
	theme,
	enabled,
	sessionId,
}: LlmGuardIndicatorProps) {
	// Track recent events for status determination
	const [recentWarnings, setRecentWarnings] = useState(0);
	const [recentBlocked, setRecentBlocked] = useState(0);
	const [lastEventTime, setLastEventTime] = useState<number | null>(null);
	const [isScanning, setIsScanning] = useState(false);
	const [tooltipOpen, setTooltipOpen] = useState(false);

	// Tooltip hover state with delay
	const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Clear counts after a period of inactivity (30 seconds)
	const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Subscribe to security events
	useEffect(() => {
		if (!enabled || !window.maestro?.security?.onSecurityEvent) {
			return;
		}

		const unsubscribe = window.maestro.security.onSecurityEvent((event: SecurityEventData) => {
			// Filter by session if provided
			if (sessionId && event.sessionId !== sessionId) {
				return;
			}

			setLastEventTime(Date.now());

			// Update counts based on action taken (more accurate than eventType)
			// Events can be input_scan/output_scan with action 'blocked', 'warned', or 'sanitized'
			if (event.action === 'blocked' || event.eventType === 'blocked') {
				setRecentBlocked((prev) => prev + 1);
			} else if (
				event.action === 'warned' ||
				event.action === 'sanitized' ||
				event.eventType === 'warning'
			) {
				setRecentWarnings((prev) => prev + 1);
			}

			// Show scanning animation briefly
			setIsScanning(true);
			setTimeout(() => setIsScanning(false), 500);

			// Reset clear timeout
			if (clearTimeoutRef.current) {
				clearTimeout(clearTimeoutRef.current);
			}
			clearTimeoutRef.current = setTimeout(() => {
				setRecentWarnings(0);
				setRecentBlocked(0);
			}, 30000); // Clear counts after 30 seconds of inactivity
		});

		return () => {
			unsubscribe();
			if (clearTimeoutRef.current) {
				clearTimeout(clearTimeoutRef.current);
			}
		};
	}, [enabled, sessionId]);

	// Determine current status
	const getStatus = (): LlmGuardStatus => {
		if (!enabled) return 'disabled';
		if (isScanning) return 'scanning';
		if (recentBlocked > 0) return 'blocked';
		if (recentWarnings > 0) return 'warning';
		return 'active';
	};

	const status = getStatus();
	const config = getStatusConfig(status, theme);
	const { Icon } = config;

	// Click handler to open Security tab
	const handleClick = useCallback(() => {
		const { setRightPanelOpen, setActiveRightTab } = useUIStore.getState();
		setActiveRightTab('security');
		setRightPanelOpen(true);
	}, []);

	// Tooltip handlers with delay
	const handleMouseEnter = () => {
		if (tooltipTimeoutRef.current) {
			clearTimeout(tooltipTimeoutRef.current);
		}
		setTooltipOpen(true);
	};

	const handleMouseLeave = () => {
		tooltipTimeoutRef.current = setTimeout(() => {
			setTooltipOpen(false);
		}, 150);
	};

	// Build tooltip text
	const buildTooltipText = () => {
		if (!enabled) {
			return 'LLM Guard is disabled. Click to configure.';
		}

		const parts: string[] = [config.label];

		if (recentBlocked > 0 || recentWarnings > 0) {
			const eventParts: string[] = [];
			if (recentBlocked > 0) {
				eventParts.push(`${recentBlocked} blocked`);
			}
			if (recentWarnings > 0) {
				eventParts.push(`${recentWarnings} warning${recentWarnings !== 1 ? 's' : ''}`);
			}
			parts.push(`Recent: ${eventParts.join(', ')}`);
		}

		if (lastEventTime) {
			const ago = Math.floor((Date.now() - lastEventTime) / 1000);
			if (ago < 60) {
				parts.push(`Last event: ${ago}s ago`);
			} else if (ago < 3600) {
				parts.push(`Last event: ${Math.floor(ago / 60)}m ago`);
			}
		}

		parts.push('Click to view security events');

		return parts.join('\n');
	};

	// Don't render if guard is disabled (optional - could also show disabled state)
	// For now, we render a dimmed indicator so users know they can enable it
	if (!enabled) {
		return null;
	}

	const totalFindings = recentBlocked + recentWarnings;

	return (
		<div className="relative" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
			<button
				onClick={handleClick}
				className="flex items-center gap-1 px-2 py-1 rounded transition-colors hover:bg-white/10"
				title={buildTooltipText()}
				aria-label={config.label}
			>
				{/* Shield icon with conditional pulse animation */}
				<div
					className={`relative ${isScanning ? 'animate-pulse' : ''}`}
					style={{
						color: config.color,
					}}
				>
					<Icon className="w-4 h-4" />

					{/* Pulsing dot indicator for active findings */}
					{totalFindings > 0 && (
						<span
							className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full animate-pulse"
							style={{
								backgroundColor: recentBlocked > 0 ? theme.colors.error : theme.colors.warning,
							}}
						/>
					)}
				</div>

				{/* Badge showing finding count */}
				{totalFindings > 0 && (
					<span
						className="text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center"
						style={{
							backgroundColor: recentBlocked > 0 ? theme.colors.error : theme.colors.warning,
							color: recentBlocked > 0 ? '#ffffff' : '#000000',
						}}
					>
						{totalFindings > 99 ? '99+' : totalFindings}
					</span>
				)}
			</button>

			{/* Custom tooltip with more details */}
			{tooltipOpen && (
				<>
					{/* Tooltip bridge to prevent closing when moving mouse to tooltip */}
					<div
						className="absolute top-full left-0 w-full h-3 pointer-events-auto"
						onMouseEnter={handleMouseEnter}
						onMouseLeave={handleMouseLeave}
					/>
					<div
						className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-[100] px-3 py-2 rounded shadow-lg text-xs whitespace-pre-line max-w-[200px]"
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.textMain,
						}}
						onMouseEnter={handleMouseEnter}
						onMouseLeave={handleMouseLeave}
					>
						{buildTooltipText()}
					</div>
				</>
			)}
		</div>
	);
});
