/**
 * ProviderPanel - Provider status, failover configuration, and migration history
 *
 * Three sections:
 * 1. Provider Status Grid — shows detected agents with availability and session counts
 * 2. Failover Configuration — controls for automatic provider failover
 * 3. Migration History — timeline of past provider switches
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
	ChevronDown,
	ChevronUp,
	Plus,
	X,
	ArrowRightLeft,
	RefreshCw,
} from 'lucide-react';
import type { Theme, Session } from '../types';
import type { ToolType } from '../../shared/types';
import type { StatsTimeRange } from '../../shared/stats-types';
import type { ProviderSwitchConfig } from '../../shared/account-types';
import { DEFAULT_PROVIDER_SWITCH_CONFIG } from '../../shared/account-types';
import { getAgentIcon } from '../constants/agentIcons';
import { getAgentDisplayName } from '../services/contextGroomer';
import { ProviderHealthCard } from './ProviderHealthCard';
import { ProviderDetailView } from './ProviderDetailView';
import { useProviderHealth } from '../hooks/useProviderHealth';
import { formatTokenCount } from '../hooks/useAccountUsage';

// ============================================================================
// Types
// ============================================================================

interface ProviderPanelProps {
	theme: Theme;
	sessions?: Session[];
}

interface MigrationEntry {
	timestamp: number;
	sessionName: string;
	sourceProvider: ToolType;
	targetProvider: ToolType;
	generation: number;
}

// ============================================================================
// Constants
// ============================================================================

const ERROR_WINDOW_OPTIONS = [
	{ label: '1 minute', value: 1 * 60 * 1000 },
	{ label: '2 minutes', value: 2 * 60 * 1000 },
	{ label: '5 minutes', value: 5 * 60 * 1000 },
	{ label: '10 minutes', value: 10 * 60 * 1000 },
	{ label: '15 minutes', value: 15 * 60 * 1000 },
];

const MIGRATION_HISTORY_LIMIT = 20;

const TIME_RANGE_OPTIONS: { label: string; value: StatsTimeRange }[] = [
	{ label: 'Today', value: 'day' },
	{ label: 'This Week', value: 'week' },
	{ label: 'This Month', value: 'month' },
	{ label: 'This Quarter', value: 'quarter' },
	{ label: 'All Time', value: 'all' },
];

// ============================================================================
// Helpers
// ============================================================================

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

function ordinalSuffix(n: number): string {
	const s = ['th', 'st', 'nd', 'rd'];
	const v = n % 100;
	return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ============================================================================
// Component
// ============================================================================

export function ProviderPanel({ theme, sessions = [] }: ProviderPanelProps) {
	const {
		providers: healthProviders,
		isLoading: healthLoading,
		lastUpdated,
		timeRange,
		setTimeRange,
		refresh: refreshHealth,
		failoverThreshold,
		totals,
	} = useProviderHealth(sessions);
	const [config, setConfig] = useState<ProviderSwitchConfig>(DEFAULT_PROVIDER_SWITCH_CONFIG);
	const [showMoreHistory, setShowMoreHistory] = useState(false);
	const [selectedProvider, setSelectedProvider] = useState<ToolType | null>(null);

	// ── Load failover config ────────────────────────────────────────────
	useEffect(() => {
		async function loadConfig() {
			try {
				const saved = await window.maestro.settings.get('providerSwitchConfig');
				if (saved && typeof saved === 'object') {
					setConfig({ ...DEFAULT_PROVIDER_SWITCH_CONFIG, ...(saved as Partial<ProviderSwitchConfig>) });
				}
			} catch {
				// Use defaults
			}
		}
		loadConfig();
	}, []);

	const saveConfig = useCallback(async (updates: Partial<ProviderSwitchConfig>) => {
		const updated = { ...config, ...updates };
		setConfig(updated);
		try {
			await window.maestro.settings.set('providerSwitchConfig', updated);
		} catch (err) {
			console.error('Failed to save provider switch config:', err);
		}
	}, [config]);

	// ── Build migration history ─────────────────────────────────────────
	const migrations: MigrationEntry[] = React.useMemo(() => {
		const entries: MigrationEntry[] = [];

		for (const session of sessions) {
			if (session.migratedFromSessionId && session.migratedAt) {
				// This session was created by migration — find source
				const source = sessions.find((s) => s.id === session.migratedFromSessionId);
				if (source) {
					entries.push({
						timestamp: session.migratedAt,
						sessionName: session.name || 'Unnamed Agent',
						sourceProvider: source.toolType as ToolType,
						targetProvider: session.toolType as ToolType,
						generation: session.migrationGeneration || 1,
					});
				}
			}
		}

		entries.sort((a, b) => b.timestamp - a.timestamp);
		return entries;
	}, [sessions]);

	const visibleMigrations = showMoreHistory
		? migrations
		: migrations.slice(0, MIGRATION_HISTORY_LIMIT);
	const hasMoreMigrations = migrations.length > MIGRATION_HISTORY_LIMIT;

	// ── Fallback provider management ────────────────────────────────────
	const availableForFallback = healthProviders
		.filter((p) => !config.fallbackProviders.includes(p.toolType))
		.map((p) => ({ id: p.toolType, name: p.displayName, icon: getAgentIcon(p.toolType), available: p.available }));

	const handleAddFallback = (toolType: ToolType) => {
		saveConfig({ fallbackProviders: [...config.fallbackProviders, toolType] });
	};

	const handleRemoveFallback = (toolType: ToolType) => {
		saveConfig({
			fallbackProviders: config.fallbackProviders.filter((p) => p !== toolType),
		});
	};

	const handleMoveFallback = (index: number, direction: 'up' | 'down') => {
		const list = [...config.fallbackProviders];
		const swapIndex = direction === 'up' ? index - 1 : index + 1;
		if (swapIndex < 0 || swapIndex >= list.length) return;
		[list[index], list[swapIndex]] = [list[swapIndex], list[index]];
		saveConfig({ fallbackProviders: list });
	};

	// ── Styles ──────────────────────────────────────────────────────────
	const sectionStyle: React.CSSProperties = {
		backgroundColor: theme.colors.bgSidebar,
		borderRadius: 8,
		padding: '16px',
		marginBottom: 16,
	};

	const sectionTitleStyle: React.CSSProperties = {
		color: theme.colors.textMain,
		fontSize: 13,
		fontWeight: 600,
		marginBottom: 12,
	};

	const labelStyle: React.CSSProperties = {
		color: theme.colors.textMain,
		fontSize: 12,
	};

	const dimStyle: React.CSSProperties = {
		color: theme.colors.textDim,
		fontSize: 11,
	};

	const timeRangeLabel = TIME_RANGE_OPTIONS.find((o) => o.value === timeRange)?.label?.toLowerCase() ?? 'today';

	// ── Render ───────────────────────────────────────────────────────────

	// Detail view for a selected provider
	if (selectedProvider) {
		return (
			<div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
				<div style={sectionStyle}>
					<ProviderDetailView
						theme={theme}
						toolType={selectedProvider}
						sessions={sessions}
						timeRange={timeRange}
						setTimeRange={setTimeRange}
						onBack={() => setSelectedProvider(null)}
					/>
				</div>
			</div>
		);
	}

	return (
		<div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
			{/* Provider Health Dashboard */}
			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>Provider Health</div>

				{/* Totals summary bar */}
				{!healthLoading && healthProviders.length > 0 && (
					<div
						style={{
							backgroundColor: theme.colors.bgMain,
							borderRadius: 6,
							padding: '8px 14px',
							marginBottom: 10,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<span style={{ color: theme.colors.textDim, fontSize: 11 }}>
							Total {timeRangeLabel}:
						</span>
						<span style={{ color: theme.colors.textMain, fontSize: 12, fontWeight: 500, marginLeft: 8 }}>
							{totals.queryCount.toLocaleString()} queries
						</span>
						<span style={{ color: theme.colors.textDim, fontSize: 11, margin: '0 6px' }}>&middot;</span>
						<span style={{ color: theme.colors.textMain, fontSize: 12, fontWeight: 500 }}>
							{formatTokenCount(totals.totalTokens)} tokens
						</span>
						<span style={{ color: theme.colors.textDim, fontSize: 11, margin: '0 6px' }}>&middot;</span>
						<span style={{ color: theme.colors.textMain, fontSize: 12, fontWeight: 500 }}>
							${totals.totalCostUsd.toFixed(2)} cost
						</span>
					</div>
				)}

				{healthLoading && healthProviders.length === 0 ? (
					<div
						style={{
							display: 'grid',
							gridTemplateColumns: 'repeat(2, 1fr)',
							gap: 10,
						}}
					>
						{[0, 1].map((i) => (
							<div
								key={i}
								style={{
									backgroundColor: theme.colors.bgMain,
									borderRadius: 8,
									padding: '14px 16px',
									border: `1px solid ${theme.colors.border}`,
									minHeight: 160,
									opacity: 0.5,
								}}
							>
								<div
									style={{
										width: 120,
										height: 14,
										borderRadius: 4,
										backgroundColor: theme.colors.bgActivity,
										marginBottom: 8,
									}}
								/>
								<div
									style={{
										width: 80,
										height: 12,
										borderRadius: 4,
										backgroundColor: theme.colors.bgActivity,
										marginBottom: 16,
									}}
								/>
								<div
									style={{
										width: '100%',
										height: 6,
										borderRadius: 3,
										backgroundColor: theme.colors.bgActivity,
										marginTop: 'auto',
									}}
								/>
							</div>
						))}
					</div>
				) : (
					<div
						style={{
							display: 'grid',
							gridTemplateColumns: 'repeat(2, 1fr)',
							gap: 10,
						}}
					>
						{healthProviders.map((provider) => (
							<ProviderHealthCard
								key={provider.toolType}
								theme={theme}
								toolType={provider.toolType}
								available={provider.available}
								activeSessionCount={provider.activeSessionCount}
								errorStats={provider.errorStats}
								usageStats={provider.usageStats}
								failoverThreshold={failoverThreshold}
								healthPercent={provider.healthPercent}
								status={provider.status}
								onSelect={() => setSelectedProvider(provider.toolType)}
							/>
						))}
						{healthProviders.length === 0 && (
							<div style={dimStyle}>No providers detected</div>
						)}
					</div>
				)}

				{/* Footer: time range selector, auto-refresh, refresh button */}
				<div
					className="flex items-center justify-between"
					style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${theme.colors.border}30` }}
				>
					<div className="flex items-center gap-2">
						<span style={{ color: theme.colors.textDim, fontSize: 11 }}>Time range:</span>
						<select
							value={timeRange}
							onChange={(e) => setTimeRange(e.target.value as StatsTimeRange)}
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
								borderRadius: 4,
								padding: '2px 6px',
								fontSize: 11,
							}}
						>
							{TIME_RANGE_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</div>
					<div className="flex items-center gap-3">
						<span style={{ color: theme.colors.textDim, fontSize: 10 }}>
							Auto-refresh: 10s
						</span>
						<button
							onClick={refreshHealth}
							className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors"
							style={{
								color: theme.colors.accent,
								backgroundColor: `${theme.colors.accent}10`,
								border: `1px solid ${theme.colors.accent}30`,
							}}
							title="Refresh Now"
						>
							<RefreshCw className="w-3 h-3" />
							Refresh
						</button>
					</div>
				</div>
			</div>

			{/* Failover Configuration */}
			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>Automatic Failover</div>

				{/* Enable automatic failover toggle */}
				<div className="flex items-center justify-between mb-3">
					<div>
						<div style={labelStyle}>Enable automatic failover</div>
						<div style={dimStyle}>
							When a provider hits repeated errors, suggest switching to an
							alternative provider.
						</div>
					</div>
					<button
						onClick={() => saveConfig({ enabled: !config.enabled })}
						className="w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ml-3"
						style={{
							backgroundColor: config.enabled
								? theme.colors.accent
								: theme.colors.bgActivity,
						}}
					>
						<div
							className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
							style={{
								transform: config.enabled
									? 'translateX(16px)'
									: 'translateX(2px)',
							}}
						/>
					</button>
				</div>

				{/* Prompt before switching toggle */}
				<div className="flex items-center justify-between mb-3">
					<div>
						<div style={labelStyle}>Prompt before switching</div>
						<div style={dimStyle}>
							Ask for confirmation before auto-switching. Uncheck for fully
							automatic failover.
						</div>
					</div>
					<button
						onClick={() =>
							saveConfig({ promptBeforeSwitch: !config.promptBeforeSwitch })
						}
						className="w-8 h-4 rounded-full transition-colors relative flex-shrink-0 ml-3"
						style={{
							backgroundColor: config.promptBeforeSwitch
								? theme.colors.accent
								: theme.colors.bgActivity,
						}}
					>
						<div
							className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
							style={{
								transform: config.promptBeforeSwitch
									? 'translateX(16px)'
									: 'translateX(2px)',
							}}
						/>
					</button>
				</div>

				{/* Error threshold and window */}
				<div className="flex items-center gap-4 mb-3">
					<div className="flex items-center gap-2">
						<span style={labelStyle}>Error threshold:</span>
						<select
							value={config.errorThreshold}
							onChange={(e) =>
								saveConfig({ errorThreshold: parseInt(e.target.value) })
							}
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
								borderRadius: 4,
								padding: '2px 6px',
								fontSize: 12,
							}}
						>
							{Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
								<option key={n} value={n}>
									{n}
								</option>
							))}
						</select>
						<span style={dimStyle}>consecutive errors</span>
					</div>
					<div className="flex items-center gap-2">
						<span style={labelStyle}>Error window:</span>
						<select
							value={config.errorWindowMs}
							onChange={(e) =>
								saveConfig({ errorWindowMs: parseInt(e.target.value) })
							}
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
								borderRadius: 4,
								padding: '2px 6px',
								fontSize: 12,
							}}
						>
							{ERROR_WINDOW_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
					</div>
				</div>

				{/* Fallback priority list */}
				<div style={{ marginTop: 12 }}>
					<div style={labelStyle} className="mb-2">
						Fallback priority:
					</div>
					{config.fallbackProviders.length === 0 && (
						<div style={dimStyle} className="mb-2">
							No fallback providers configured
						</div>
					)}
					{config.fallbackProviders.map((toolType, index) => (
						<div
							key={toolType}
							className="flex items-center gap-2 mb-1"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderRadius: 4,
								padding: '6px 10px',
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<span style={dimStyle}>{index + 1}.</span>
							<span style={{ fontSize: 14 }}>
								{getAgentIcon(toolType)}
							</span>
							<span
								style={{
									color: theme.colors.textMain,
									fontSize: 12,
									flex: 1,
								}}
							>
								{getAgentDisplayName(toolType)}
							</span>
							<button
								onClick={() => handleMoveFallback(index, 'up')}
								disabled={index === 0}
								className="p-0.5 rounded transition-colors"
								style={{
									color:
										index === 0
											? theme.colors.textDim + '40'
											: theme.colors.textDim,
								}}
								title="Move up"
							>
								<ChevronUp className="w-3.5 h-3.5" />
							</button>
							<button
								onClick={() => handleMoveFallback(index, 'down')}
								disabled={
									index === config.fallbackProviders.length - 1
								}
								className="p-0.5 rounded transition-colors"
								style={{
									color:
										index === config.fallbackProviders.length - 1
											? theme.colors.textDim + '40'
											: theme.colors.textDim,
								}}
								title="Move down"
							>
								<ChevronDown className="w-3.5 h-3.5" />
							</button>
							<button
								onClick={() => handleRemoveFallback(toolType)}
								className="p-0.5 rounded transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Remove"
							>
								<X className="w-3.5 h-3.5" />
							</button>
						</div>
					))}

					{/* Add provider dropdown */}
					{availableForFallback.length > 0 && (
						<div className="mt-2 relative">
							<AddProviderDropdown
								theme={theme}
								providers={availableForFallback}
								onAdd={handleAddFallback}
							/>
						</div>
					)}
				</div>
			</div>

			{/* Switch Behavior */}
			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>Switch Behavior</div>
				<div style={dimStyle} className="mb-2">
					When switching back to a provider that already has an archived session:
				</div>
				<div className="flex gap-4">
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="radio"
							name="switchBehavior"
							checked={(config.switchBehavior ?? 'merge-back') === 'merge-back'}
							onChange={() => saveConfig({ switchBehavior: 'merge-back' })}
						/>
						<div>
							<div style={{ color: theme.colors.textMain, fontSize: 12, fontWeight: 500 }}>
								Merge & update
							</div>
							<div style={{ color: theme.colors.textDim, fontSize: 10 }}>
								Reactivate the archived session and append new context
							</div>
						</div>
					</label>
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="radio"
							name="switchBehavior"
							checked={config.switchBehavior === 'always-new'}
							onChange={() => saveConfig({ switchBehavior: 'always-new' })}
						/>
						<div>
							<div style={{ color: theme.colors.textMain, fontSize: 12, fontWeight: 500 }}>
								Always new
							</div>
							<div style={{ color: theme.colors.textDim, fontSize: 10 }}>
								Create a fresh session each time
							</div>
						</div>
					</label>
				</div>
			</div>

			{/* Migration History */}
			<div style={sectionStyle}>
				<div style={sectionTitleStyle}>Migration History</div>
				{migrations.length === 0 ? (
					<div
						className="text-center py-4"
						style={dimStyle}
					>
						No provider switches yet
					</div>
				) : (
					<div>
						{visibleMigrations.map((entry, i) => (
							<div
								key={`${entry.timestamp}-${i}`}
								className="mb-3 last:mb-0"
								style={{
									borderLeft: `2px solid ${theme.colors.accent}40`,
									paddingLeft: 12,
								}}
							>
								<div
									style={{
										color: theme.colors.textDim,
										fontSize: 11,
										marginBottom: 2,
									}}
								>
									{formatMigrationTime(entry.timestamp)}
								</div>
								<div
									style={{
										color: theme.colors.textMain,
										fontSize: 12,
									}}
								>
									{entry.sessionName}:{' '}
									<span style={{ color: theme.colors.accent }}>
										{getAgentDisplayName(entry.sourceProvider)}
									</span>
									{' '}
									<ArrowRightLeft
										className="w-3 h-3 inline-block mx-1"
										style={{ color: theme.colors.textDim }}
									/>
									{' '}
									<span style={{ color: theme.colors.accent }}>
										{getAgentDisplayName(entry.targetProvider)}
									</span>
								</div>
								{entry.generation > 1 && (
									<div style={dimStyle}>
										{ordinalSuffix(entry.generation)} switch
									</div>
								)}
							</div>
						))}
						{hasMoreMigrations && !showMoreHistory && (
							<button
								onClick={() => setShowMoreHistory(true)}
								className="text-xs mt-2 hover:underline"
								style={{ color: theme.colors.accent }}
							>
								Show more ({migrations.length - MIGRATION_HISTORY_LIMIT}{' '}
								remaining)
							</button>
						)}
						{showMoreHistory && hasMoreMigrations && (
							<button
								onClick={() => setShowMoreHistory(false)}
								className="text-xs mt-2 hover:underline"
								style={{ color: theme.colors.accent }}
							>
								Show less
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// ============================================================================
// Sub-components
// ============================================================================

function AddProviderDropdown({
	theme,
	providers,
	onAdd,
}: {
	theme: Theme;
	providers: { id: ToolType; name: string; icon: string; available: boolean }[];
	onAdd: (toolType: ToolType) => void;
}) {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<div className="relative">
			<button
				onClick={() => setIsOpen(!isOpen)}
				className="flex items-center gap-1 text-xs px-3 py-1.5 rounded transition-colors"
				style={{
					color: theme.colors.accent,
					backgroundColor: `${theme.colors.accent}10`,
					border: `1px solid ${theme.colors.accent}30`,
				}}
			>
				<Plus className="w-3 h-3" />
				Add provider
			</button>
			{isOpen && (
				<div
					className="absolute left-0 top-full mt-1 z-50 rounded-md shadow-lg py-1 min-w-[180px]"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					{providers.map((p) => (
						<button
							key={p.id}
							onClick={() => {
								onAdd(p.id);
								setIsOpen(false);
							}}
							className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors"
							style={{ color: theme.colors.textMain }}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = 'transparent';
							}}
						>
							<span>{p.icon}</span>
							<span>{p.name}</span>
							{!p.available && (
								<span
									style={{
										color: theme.colors.textDim,
										fontSize: 10,
									}}
								>
									(not installed)
								</span>
							)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export default ProviderPanel;
