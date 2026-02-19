/**
 * ProviderDetailView - Full-width detail view for a single provider
 *
 * Shows provider header with health status, 8 summary metrics,
 * and navigates back to the card grid on back button or Escape key.
 */

import React, { useEffect } from 'react';
import { ArrowLeft, ArrowRightLeft } from 'lucide-react';
import type { Theme, Session } from '../types';
import type { ToolType } from '../../shared/types';
import type { StatsTimeRange } from '../../shared/stats-types';
import { getAgentIcon } from '../constants/agentIcons';
import { formatTokenCount } from '../hooks/useAccountUsage';
import { useProviderDetail } from '../hooks/useProviderDetail';
import type { HealthStatus } from './ProviderHealthCard';
import { getAgentDisplayName } from '../services/contextGroomer';

// ============================================================================
// Types
// ============================================================================

interface ProviderDetailViewProps {
	theme: Theme;
	toolType: ToolType;
	sessions: Session[];
	timeRange: StatsTimeRange;
	setTimeRange: (range: StatsTimeRange) => void;
	onBack: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function getStatusLabel(status: HealthStatus): string {
	switch (status) {
		case 'healthy': return 'Healthy';
		case 'degraded': return 'Degraded';
		case 'failing': return 'Failing';
		case 'not_installed': return 'Not Installed';
		case 'idle': return 'Idle';
	}
}

function getStatusColor(status: HealthStatus, theme: Theme): string {
	switch (status) {
		case 'healthy': return theme.colors.success;
		case 'degraded': return theme.colors.warning;
		case 'failing': return theme.colors.error;
		case 'not_installed': return theme.colors.textDim;
		case 'idle': return theme.colors.accent;
	}
}

function formatDurationMs(ms: number): string {
	if (ms === 0) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatMigrationTime(timestamp: number): string {
	const date = new Date(timestamp);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffHours = diffMs / (1000 * 60 * 60);

	if (diffHours < 24) {
		return date.toLocaleTimeString(undefined, {
			hour: 'numeric',
			minute: '2-digit',
		});
	}

	return date.toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

// ============================================================================
// Component
// ============================================================================

export function ProviderDetailView({
	theme,
	toolType,
	sessions,
	timeRange,
	setTimeRange,
	onBack,
}: ProviderDetailViewProps) {
	const { detail, isLoading } = useProviderDetail(toolType, sessions, timeRange);

	// Handle Escape key to go back
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				onBack();
			}
		}
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [onBack]);

	const statusColor = detail ? getStatusColor(detail.status, theme) : theme.colors.textDim;

	// Loading skeleton
	if (isLoading && !detail) {
		return (
			<div>
				<button
					onClick={onBack}
					className="flex items-center gap-1 text-xs mb-3 transition-colors"
					style={{ color: theme.colors.accent }}
				>
					<ArrowLeft className="w-3.5 h-3.5" />
					Back to Providers
				</button>
				<div style={{ opacity: 0.5 }}>
					<div
						style={{
							width: 180,
							height: 16,
							borderRadius: 4,
							backgroundColor: theme.colors.bgActivity,
							marginBottom: 12,
						}}
					/>
					<div
						style={{
							display: 'grid',
							gridTemplateColumns: 'repeat(4, 1fr)',
							gap: 10,
						}}
					>
						{Array.from({ length: 8 }).map((_, i) => (
							<div
								key={i}
								style={{
									height: 50,
									borderRadius: 6,
									backgroundColor: theme.colors.bgActivity,
								}}
							/>
						))}
					</div>
				</div>
			</div>
		);
	}

	if (!detail) {
		return (
			<div>
				<button
					onClick={onBack}
					className="flex items-center gap-1 text-xs mb-3 transition-colors"
					style={{ color: theme.colors.accent }}
				>
					<ArrowLeft className="w-3.5 h-3.5" />
					Back to Providers
				</button>
				<div style={{ color: theme.colors.textDim, fontSize: 12, textAlign: 'center', padding: 20 }}>
					Failed to load provider details
				</div>
			</div>
		);
	}

	const reliabilityDisplay = detail.usage.queryCount > 0
		? `${detail.reliability.successRate.toFixed(1)}%`
		: 'N/A';
	const errorRateDisplay = detail.usage.queryCount > 0
		? `${detail.reliability.errorRate.toFixed(1)}%`
		: 'N/A';

	return (
		<div>
			{/* Back button */}
			<button
				onClick={onBack}
				className="flex items-center gap-1 text-xs mb-3 transition-colors"
				style={{ color: theme.colors.accent }}
				onMouseEnter={(e) => {
					e.currentTarget.style.opacity = '0.8';
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.opacity = '1';
				}}
			>
				<ArrowLeft className="w-3.5 h-3.5" />
				Back to Providers
			</button>

			{/* Header: icon + name + status */}
			<div
				className="flex items-center justify-between mb-3"
				style={{
					paddingBottom: 10,
					borderBottom: `1px solid ${theme.colors.border}`,
				}}
			>
				<div className="flex items-center gap-2">
					<span style={{ fontSize: 22 }}>{getAgentIcon(toolType)}</span>
					<span
						style={{
							color: theme.colors.textMain,
							fontSize: 16,
							fontWeight: 600,
						}}
					>
						{detail.displayName}
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span
						style={{
							display: 'inline-block',
							width: 8,
							height: 8,
							borderRadius: '50%',
							backgroundColor: statusColor,
						}}
					/>
					<span
						style={{
							color: statusColor,
							fontSize: 13,
							fontWeight: 500,
						}}
					>
						{getStatusLabel(detail.status)}
					</span>
				</div>
			</div>

			{/* Summary stats row — 8 key metrics */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(4, 1fr)',
					gap: 8,
					marginBottom: 16,
				}}
			>
				<MetricCard
					theme={theme}
					label="Queries"
					value={detail.usage.queryCount.toLocaleString()}
				/>
				<MetricCard
					theme={theme}
					label="Tokens In"
					value={formatTokenCount(detail.usage.totalInputTokens)}
				/>
				<MetricCard
					theme={theme}
					label="Tokens Out"
					value={formatTokenCount(detail.usage.totalOutputTokens)}
				/>
				<MetricCard
					theme={theme}
					label="Cost"
					value={`$${detail.usage.totalCostUsd.toFixed(2)}`}
				/>
				<MetricCard
					theme={theme}
					label="Reliability"
					value={reliabilityDisplay}
					valueColor={
						detail.reliability.successRate >= 95
							? theme.colors.success
							: detail.reliability.successRate >= 85
								? theme.colors.warning
								: theme.colors.error
					}
				/>
				<MetricCard
					theme={theme}
					label="Error Rate"
					value={errorRateDisplay}
					valueColor={
						detail.reliability.errorRate === 0
							? theme.colors.success
							: detail.reliability.errorRate < 5
								? theme.colors.warning
								: theme.colors.error
					}
				/>
				<MetricCard
					theme={theme}
					label="Sessions"
					value={`${detail.activeSessions.length} active`}
				/>
				<MetricCard
					theme={theme}
					label="Source Split"
					value={`${detail.queriesBySource.user} user / ${detail.queriesBySource.auto} auto`}
				/>
			</div>

			{/* Avg Response Time row */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(4, 1fr)',
					gap: 8,
					marginBottom: 16,
				}}
			>
				<MetricCard
					theme={theme}
					label="Avg Time"
					value={formatDurationMs(detail.reliability.avgResponseTimeMs)}
				/>
				<MetricCard
					theme={theme}
					label="P95 Time"
					value={formatDurationMs(detail.reliability.p95ResponseTimeMs)}
				/>
				<MetricCard
					theme={theme}
					label="Location"
					value={`${detail.queriesByLocation.local} local / ${detail.queriesByLocation.remote} remote`}
				/>
				<MetricCard
					theme={theme}
					label="Migrations"
					value={`${detail.migrations.length}`}
				/>
			</div>

			{/* Active Sessions */}
			{detail.activeSessions.length > 0 && (
				<div
					style={{
						backgroundColor: theme.colors.bgMain,
						borderRadius: 6,
						padding: '10px 14px',
						marginBottom: 12,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<div
						style={{
							color: theme.colors.textMain,
							fontSize: 12,
							fontWeight: 600,
							marginBottom: 8,
						}}
					>
						Active Sessions ({detail.activeSessions.length})
					</div>
					{detail.activeSessions.map((s) => (
						<div
							key={s.id}
							className="flex items-center gap-2 py-1"
							style={{
								borderBottom: `1px solid ${theme.colors.border}20`,
							}}
						>
							<span style={{ color: theme.colors.textMain, fontSize: 12, flex: 1 }}>
								{s.name}
							</span>
							<span
								style={{
									color: theme.colors.textDim,
									fontSize: 10,
									maxWidth: 180,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								}}
							>
								{s.projectRoot}
							</span>
							<span
								style={{
									fontSize: 10,
									color: s.state === 'busy'
										? theme.colors.warning
										: s.state === 'error'
											? theme.colors.error
											: theme.colors.success,
								}}
							>
								● {s.state}
							</span>
						</div>
					))}
				</div>
			)}

			{/* Migration History */}
			{detail.migrations.length > 0 && (
				<div
					style={{
						backgroundColor: theme.colors.bgMain,
						borderRadius: 6,
						padding: '10px 14px',
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<div
						style={{
							color: theme.colors.textMain,
							fontSize: 12,
							fontWeight: 600,
							marginBottom: 8,
						}}
					>
						Migration History
					</div>
					{detail.migrations.slice(0, 10).map((m, i) => (
						<div
							key={`${m.timestamp}-${i}`}
							className="flex items-center gap-2 py-1"
							style={{
								borderLeft: `2px solid ${theme.colors.accent}40`,
								paddingLeft: 10,
								marginBottom: 4,
							}}
						>
							<span style={{ color: theme.colors.textDim, fontSize: 10, minWidth: 70 }}>
								{formatMigrationTime(m.timestamp)}
							</span>
							<span style={{ color: theme.colors.textMain, fontSize: 11 }}>
								{m.sessionName}:
							</span>
							<span style={{ color: theme.colors.accent, fontSize: 11 }}>
								{m.direction === 'from' ? '→' : '←'}{' '}
								{m.direction === 'from' ? 'Switched TO' : 'Switched FROM'}{' '}
								{getAgentDisplayName(m.otherProvider)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ============================================================================
// Sub-components
// ============================================================================

function MetricCard({
	theme,
	label,
	value,
	valueColor,
}: {
	theme: Theme;
	label: string;
	value: string;
	valueColor?: string;
}) {
	return (
		<div
			style={{
				backgroundColor: theme.colors.bgMain,
				borderRadius: 6,
				padding: '8px 10px',
				border: `1px solid ${theme.colors.border}`,
			}}
		>
			<div style={{ color: theme.colors.textDim, fontSize: 10, marginBottom: 2 }}>
				{label}
			</div>
			<div
				style={{
					color: valueColor ?? theme.colors.textMain,
					fontSize: 13,
					fontWeight: 600,
				}}
			>
				{value}
			</div>
		</div>
	);
}

export default ProviderDetailView;
