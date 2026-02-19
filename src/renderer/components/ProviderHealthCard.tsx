/**
 * ProviderHealthCard - Individual provider health status card
 *
 * Displays:
 * - Provider icon and name
 * - Health status badge (Healthy/Degraded/Failing/Not Installed/Idle)
 * - Stats grid: sessions, queries, tokens, cost, errors, last error
 * - Health bar at bottom (green/yellow/red gradient)
 */

import React from 'react';
import type { Theme } from '../types';
import type { ToolType } from '../../shared/types';
import type { ProviderErrorStats } from '../../shared/account-types';
import type { ProviderUsageStats } from '../hooks/useProviderHealth';
import { getAgentIcon } from '../constants/agentIcons';
import { getAgentDisplayName } from '../services/contextGroomer';
import { formatTokenCount } from '../hooks/useAccountUsage';

// ============================================================================
// Types
// ============================================================================

export type HealthStatus = 'healthy' | 'degraded' | 'failing' | 'not_installed' | 'idle';

export interface ProviderHealthCardProps {
	theme: Theme;
	toolType: ToolType;
	available: boolean;
	activeSessionCount: number;
	errorStats: ProviderErrorStats | null;
	usageStats: ProviderUsageStats;
	failoverThreshold: number;
	healthPercent: number;
	status: HealthStatus;
	onSelect?: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function getStatusLabel(status: HealthStatus, errorCount: number): string {
	switch (status) {
		case 'healthy':
			return 'Healthy';
		case 'degraded':
			return `Degraded (${errorCount} error${errorCount !== 1 ? 's' : ''})`;
		case 'failing':
			return 'Failing';
		case 'not_installed':
			return 'Not Installed';
		case 'idle':
			return 'No Sessions';
	}
}

function getStatusColor(status: HealthStatus, theme: Theme): string {
	switch (status) {
		case 'healthy':
			return theme.colors.success;
		case 'degraded':
			return theme.colors.warning;
		case 'failing':
			return theme.colors.error;
		case 'not_installed':
			return theme.colors.textDim;
		case 'idle':
			return theme.colors.accent;
	}
}

function getStatusBgTint(status: HealthStatus, theme: Theme): string {
	switch (status) {
		case 'healthy':
			return theme.colors.success + '08';
		case 'degraded':
			return theme.colors.warning + '08';
		case 'failing':
			return theme.colors.error + '08';
		default:
			return 'transparent';
	}
}

function getHealthBarColor(healthPercent: number, theme: Theme): string {
	if (healthPercent >= 80) return theme.colors.success;
	if (healthPercent >= 50) return theme.colors.warning;
	return theme.colors.error;
}

function formatRelativeTime(timestamp: number | null): string {
	if (!timestamp) return '\u2014';
	const diffMs = Date.now() - timestamp;
	if (diffMs < 0) return 'just now';
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}

function formatWindowDuration(ms: number): string {
	const minutes = Math.round(ms / 60000);
	return `${minutes}m`;
}

// ============================================================================
// Component
// ============================================================================

export function ProviderHealthCard({
	theme,
	toolType,
	available,
	activeSessionCount,
	errorStats,
	usageStats,
	failoverThreshold,
	healthPercent,
	status,
	onSelect,
}: ProviderHealthCardProps) {
	const errorCount = errorStats?.totalErrorsInWindow ?? 0;
	const windowMs = 5 * 60 * 1000; // Default 5m window display
	const statusColor = getStatusColor(status, theme);
	const bgTint = getStatusBgTint(status, theme);
	const barColor = status === 'not_installed'
		? theme.colors.textDim + '30'
		: getHealthBarColor(healthPercent, theme);

	const isUnavailable = status === 'not_installed';
	const dash = '\u2014';

	return (
		<div
			style={{
				backgroundColor: bgTint !== 'transparent' ? bgTint : theme.colors.bgMain,
				borderRadius: 8,
				padding: '14px 16px',
				border: `1px solid ${theme.colors.border}`,
				transition: 'box-shadow 0.15s ease',
				minHeight: 160,
				display: 'flex',
				flexDirection: 'column',
				cursor: onSelect ? 'pointer' : undefined,
			}}
			onClick={onSelect}
			onMouseEnter={(e) => {
				e.currentTarget.style.boxShadow = `0 2px 8px ${theme.colors.border}80`;
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.boxShadow = 'none';
			}}
		>
			{/* Header: icon + name */}
			<div className="flex items-center gap-2 mb-2">
				<span style={{ fontSize: 18 }}>{getAgentIcon(toolType)}</span>
				<span
					style={{
						color: theme.colors.textMain,
						fontSize: 13,
						fontWeight: 600,
						flex: 1,
					}}
				>
					{getAgentDisplayName(toolType)}
				</span>
			</div>

			{/* Status badge */}
			<div className="flex items-center gap-1.5 mb-3">
				<span
					style={{
						display: 'inline-block',
						width: 7,
						height: 7,
						borderRadius: '50%',
						backgroundColor: statusColor,
						flexShrink: 0,
					}}
				/>
				<span
					style={{
						color: statusColor,
						fontSize: 12,
						fontWeight: 500,
					}}
				>
					{getStatusLabel(status, errorCount)}
				</span>
			</div>

			{/* Stats grid */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: '1fr 1fr',
					gap: '4px 12px',
					flex: 1,
				}}
			>
				<StatRow
					theme={theme}
					label="Sessions"
					value={isUnavailable ? dash : `${activeSessionCount} active`}
				/>
				<StatRow
					theme={theme}
					label="Queries"
					value={isUnavailable ? dash : usageStats.queryCount.toLocaleString()}
				/>
				<StatRow
					theme={theme}
					label="Tokens"
					value={
						isUnavailable
							? dash
							: `${formatTokenCount(usageStats.totalInputTokens)} in / ${formatTokenCount(usageStats.totalOutputTokens)} out`
					}
				/>
				<StatRow
					theme={theme}
					label="Cost"
					value={isUnavailable ? dash : `$${usageStats.totalCostUsd.toFixed(2)}`}
				/>
				<StatRow
					theme={theme}
					label="Errors"
					value={
						isUnavailable
							? dash
							: `${errorCount} (${formatWindowDuration(windowMs)})`
					}
				/>
				<StatRow
					theme={theme}
					label="Last error"
					value={
						isUnavailable
							? dash
							: formatRelativeTime(errorStats?.lastErrorAt ?? null)
					}
				/>
			</div>

			{/* Health bar */}
			<div
				style={{
					marginTop: 10,
					height: 6,
					borderRadius: 3,
					backgroundColor: theme.colors.bgActivity,
					overflow: 'hidden',
				}}
			>
				<div
					style={{
						height: '100%',
						width: `${status === 'not_installed' ? 0 : healthPercent}%`,
						backgroundColor: barColor,
						borderRadius: 3,
						transition: 'width 0.3s ease, background-color 0.3s ease',
					}}
				/>
			</div>
			<div
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					marginTop: 2,
				}}
			>
				<span
					style={{
						color: theme.colors.textDim,
						fontSize: 10,
					}}
				>
					{status === 'not_installed' ? 'N/A' : `${Math.round(healthPercent)}%`}
				</span>
				{onSelect && (
					<span
						style={{
							color: theme.colors.accent,
							fontSize: 10,
							cursor: 'pointer',
						}}
						onClick={(e) => {
							e.stopPropagation();
							onSelect();
						}}
					>
						Details →
					</span>
				)}
			</div>
		</div>
	);
}

// ============================================================================
// Sub-components
// ============================================================================

function StatRow({
	theme,
	label,
	value,
}: {
	theme: Theme;
	label: string;
	value: string;
}) {
	return (
		<div className="flex items-center gap-1">
			<span style={{ color: theme.colors.textDim, fontSize: 11 }}>
				{label}:
			</span>
			<span style={{ color: theme.colors.textMain, fontSize: 11 }}>
				{value}
			</span>
		</div>
	);
}

export default ProviderHealthCard;
