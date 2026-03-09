/**
 * SecurityBadge
 *
 * A small badge component for the session list (Left Bar) that shows
 * security finding counts from LLM Guard for each agent/session.
 *
 * Features:
 * - Red badge: Content blocked
 * - Yellow badge: Warnings detected (secrets, PII, prompt injection)
 * - Green badge: Scanned clean (no issues)
 * - Auto-dismiss after configurable timeout
 * - Can be dismissed when session is clicked/activated
 */

import React, { useState, useEffect, useRef, memo } from 'react';
import { Shield, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import type { Theme } from '../types';
import type { SecurityEventData } from '../../main/preload/security';

export type SecurityBadgeStatus = 'clean' | 'warning' | 'blocked' | 'hidden';

interface SecurityBadgeProps {
	theme: Theme;
	/** Session ID to filter security events */
	sessionId: string;
	/** Whether LLM Guard is enabled */
	enabled: boolean;
	/** Whether this session is currently active (used for auto-dismiss) */
	isActive?: boolean;
	/** Timeout in ms before badge auto-dismisses (default: 30000ms = 30s) */
	dismissTimeout?: number;
	/** Show compact variant (icon only, no count) */
	compact?: boolean;
}

// Badge configuration based on status
const getStatusConfig = (status: SecurityBadgeStatus, theme: Theme) => {
	switch (status) {
		case 'blocked':
			return {
				Icon: ShieldX,
				bgColor: theme.colors.error,
				textColor: '#ffffff',
				label: 'Content blocked',
			};
		case 'warning':
			return {
				Icon: ShieldAlert,
				bgColor: theme.colors.warning,
				textColor: '#000000',
				label: 'Warnings detected',
			};
		case 'clean':
			return {
				Icon: ShieldCheck,
				bgColor: theme.colors.success,
				textColor: '#ffffff',
				label: 'Scanned clean',
			};
		case 'hidden':
		default:
			return {
				Icon: Shield,
				bgColor: 'transparent',
				textColor: theme.colors.textDim,
				label: '',
			};
	}
};

export const SecurityBadge = memo(function SecurityBadge({
	theme,
	sessionId,
	enabled,
	isActive = false,
	dismissTimeout = 30000,
	compact = false,
}: SecurityBadgeProps) {
	// Track event counts
	const [warningCount, setWarningCount] = useState(0);
	const [blockedCount, setBlockedCount] = useState(0);
	const [scanCount, setScanCount] = useState(0);
	const [visible, setVisible] = useState(false);

	// Timeout refs for auto-dismiss
	const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastEventTimeRef = useRef<number | null>(null);

	// Clear badge when session becomes active (user clicked on it)
	useEffect(() => {
		if (isActive && visible) {
			setVisible(false);
			setWarningCount(0);
			setBlockedCount(0);
			setScanCount(0);
		}
	}, [isActive, visible]);

	// Subscribe to security events
	useEffect(() => {
		if (!enabled || !window.maestro?.security?.onSecurityEvent) {
			return;
		}

		const unsubscribe = window.maestro.security.onSecurityEvent((event: SecurityEventData) => {
			// Filter events for this session only
			if (event.sessionId !== sessionId) {
				return;
			}

			lastEventTimeRef.current = Date.now();
			setVisible(true);

			// Update counts based on event type
			if (event.eventType === 'blocked') {
				setBlockedCount((prev) => prev + 1);
			} else if (event.eventType === 'warning') {
				setWarningCount((prev) => prev + 1);
			} else if (event.eventType === 'input_scan' || event.eventType === 'output_scan') {
				// Increment scan count for clean scans (no findings)
				if (event.findingCount === 0) {
					setScanCount((prev) => prev + 1);
				}
			}

			// Reset dismiss timeout
			if (dismissTimeoutRef.current) {
				clearTimeout(dismissTimeoutRef.current);
			}
			dismissTimeoutRef.current = setTimeout(() => {
				setVisible(false);
				setWarningCount(0);
				setBlockedCount(0);
				setScanCount(0);
			}, dismissTimeout);
		});

		return () => {
			unsubscribe();
			if (dismissTimeoutRef.current) {
				clearTimeout(dismissTimeoutRef.current);
			}
		};
	}, [enabled, sessionId, dismissTimeout]);

	// Determine current status
	const getStatus = (): SecurityBadgeStatus => {
		if (!visible) return 'hidden';
		if (blockedCount > 0) return 'blocked';
		if (warningCount > 0) return 'warning';
		if (scanCount > 0) return 'clean';
		return 'hidden';
	};

	const status = getStatus();

	// Don't render if not visible or guard disabled
	if (!enabled || status === 'hidden') {
		return null;
	}

	const config = getStatusConfig(status, theme);
	const { Icon } = config;
	const totalFindings = blockedCount + warningCount;
	const displayCount = totalFindings > 0 ? totalFindings : scanCount;

	if (compact) {
		// Compact mode: just icon with colored background
		return (
			<div
				className="w-4 h-4 rounded flex items-center justify-center shrink-0"
				style={{ backgroundColor: config.bgColor }}
				title={config.label}
			>
				<Icon className="w-2.5 h-2.5" style={{ color: config.textColor }} />
			</div>
		);
	}

	// Full mode: icon + count badge
	return (
		<div
			className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold shrink-0"
			style={{ backgroundColor: config.bgColor, color: config.textColor }}
			title={config.label}
		>
			<Icon className="w-2.5 h-2.5" />
			{displayCount > 0 && <span>{displayCount > 99 ? '99+' : displayCount}</span>}
		</div>
	);
});

export default SecurityBadge;
