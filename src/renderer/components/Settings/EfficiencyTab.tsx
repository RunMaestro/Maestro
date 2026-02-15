/**
 * EfficiencyTab - Memory efficiency analysis and tracking.
 *
 * Visualizes which memories/rules are having positive outcomes vs underperforming,
 * with ROI rankings, tier distribution, scope/type breakdowns, and sortable tables.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
	TrendingUp,
	TrendingDown,
	Minus,
	BarChart3,
	Target,
	Zap,
	AlertTriangle,
	RefreshCw,
	Pin,
	ArrowUpDown,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	EfficiencyAnalysis,
	MemoryEfficiencyRecord,
} from '../../../shared/memory-types';
import { TabDescriptionBanner } from './TabDescriptionBanner';
import { SectionHeader } from './SectionHeader';

interface EfficiencyTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
}

type SortField = 'roi' | 'effectivenessScore' | 'useCount' | 'tokenEstimate' | 'confidence' | 'lastUsedAt';
type SortDir = 'asc' | 'desc';

/** Format a number as percentage */
function pct(n: number): string {
	return `${Math.round(n * 100)}%`;
}

/** Format a timestamp as relative time */
function relativeTime(ts: number): string {
	if (!ts) return 'never';
	const diff = Date.now() - ts;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

/** Tier color for a given tier */
function tierColor(tier: MemoryEfficiencyRecord['tier'], theme: Theme): string {
	switch (tier) {
		case 'high':
			return '#22c55e';
		case 'medium':
			return '#eab308';
		case 'low':
			return '#ef4444';
		case 'unscored':
			return theme.colors.textDim;
	}
}

/** Tier label */
function tierLabel(tier: MemoryEfficiencyRecord['tier']): string {
	switch (tier) {
		case 'high':
			return 'High Impact';
		case 'medium':
			return 'Medium Impact';
		case 'low':
			return 'Low Impact';
		case 'unscored':
			return 'Not Yet Scored';
	}
}

export function EfficiencyTab({
	theme,
	stats,
}: EfficiencyTabProps): React.ReactElement {
	const [analysis, setAnalysis] = useState<EfficiencyAnalysis | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Table state
	const [sortField, setSortField] = useState<SortField>('roi');
	const [sortDir, setSortDir] = useState<SortDir>('desc');
	const [tierFilter, setTierFilter] = useState<MemoryEfficiencyRecord['tier'] | 'all'>('all');
	const [tableExpanded, setTableExpanded] = useState(true);
	const [topPerfExpanded, setTopPerfExpanded] = useState(true);
	const [underPerfExpanded, setUnderPerfExpanded] = useState(true);
	const [breakdownExpanded, setBreakdownExpanded] = useState(true);

	const fetchAnalysis = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await window.maestro.memory.getEfficiencyAnalysis();
			if (res.success) {
				setAnalysis(res.data);
			} else {
				setError(res.error);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load efficiency analysis');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchAnalysis();
	}, [fetchAnalysis]);

	// Sorted and filtered memory list
	const filteredMemories = useMemo(() => {
		if (!analysis) return [];
		let list = analysis.memories;
		if (tierFilter !== 'all') {
			list = list.filter((m) => m.tier === tierFilter);
		}
		return [...list].sort((a, b) => {
			const av = a[sortField] ?? 0;
			const bv = b[sortField] ?? 0;
			return sortDir === 'desc' ? (bv as number) - (av as number) : (av as number) - (bv as number);
		});
	}, [analysis, tierFilter, sortField, sortDir]);

	const handleSort = useCallback(
		(field: SortField) => {
			if (sortField === field) {
				setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
			} else {
				setSortField(field);
				setSortDir('desc');
			}
		},
		[sortField]
	);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-16" style={{ color: theme.colors.textDim }}>
				<RefreshCw className="w-4 h-4 animate-spin mr-2" />
				Loading efficiency analysis...
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex items-center justify-center py-16" style={{ color: theme.colors.error }}>
				<AlertTriangle className="w-4 h-4 mr-2" />
				{error}
			</div>
		);
	}

	if (!analysis) return <></>;

	const { summary } = analysis;

	// Tier distribution
	const dist = stats?.effectivenessDistribution ?? { high: 0, medium: 0, low: 0, unscored: 0 };
	const totalDist = dist.high + dist.medium + dist.low + dist.unscored;

	return (
		<div className="space-y-4">
			<TabDescriptionBanner
				theme={theme}
				description="Track which memories and rules are having positive outcomes. Memories are scored based on session outcomes after injection — high ROI means the memory is frequently used and correlates with successful sessions."
				descriptionKey="efficiency-tab"
			/>

			{/* ─── Summary Cards ─────────────────────────────────────────── */}
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				<SummaryCard
					theme={theme}
					label="Avg Effectiveness"
					value={pct(summary.avgEffectiveness)}
					icon={Target}
					color={summary.avgEffectiveness >= 0.5 ? '#22c55e' : summary.avgEffectiveness >= 0.3 ? '#eab308' : '#ef4444'}
				/>
				<SummaryCard
					theme={theme}
					label="Avg ROI"
					value={summary.avgROI.toFixed(2)}
					icon={Zap}
					color="#8b5cf6"
				/>
				<SummaryCard
					theme={theme}
					label="Total Injections"
					value={summary.totalInjections.toLocaleString()}
					icon={BarChart3}
					color={theme.colors.accent}
				/>
				<SummaryCard
					theme={theme}
					label="Never Used"
					value={`${summary.neverUsedCount}`}
					icon={AlertTriangle}
					color={summary.neverUsedCount > 0 ? '#eab308' : '#22c55e'}
				/>
			</div>

			{/* ─── Trend Summary ─────────────────────────────────────────── */}
			<div
				className="flex items-center gap-4 px-3 py-2 rounded text-xs"
				style={{ background: theme.colors.bgActivity, color: theme.colors.textDim }}
			>
				<span className="flex items-center gap-1">
					<TrendingUp className="w-3 h-3" style={{ color: '#22c55e' }} />
					{summary.improvingCount} improving
				</span>
				<span className="flex items-center gap-1">
					<TrendingDown className="w-3 h-3" style={{ color: '#ef4444' }} />
					{summary.decliningCount} declining
				</span>
				<span className="flex items-center gap-1">
					<Minus className="w-3 h-3" />
					{summary.totalActive - summary.improvingCount - summary.decliningCount} stable
				</span>
				<span className="ml-auto" style={{ color: theme.colors.textDim }}>
					{summary.totalActive} active memories
				</span>
			</div>

			{/* ─── Tier Distribution Bar ───────────────────────────────────── */}
			{totalDist > 0 && (
				<div>
					<div className="flex items-center justify-between mb-1">
						<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							Effectiveness Distribution
						</span>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{totalDist} scored
						</span>
					</div>
					<div className="flex h-5 rounded overflow-hidden" style={{ background: theme.colors.bgActivity }}>
						{(['high', 'medium', 'low', 'unscored'] as const).map((tier) => {
							const count = dist[tier];
							if (!count) return null;
							const widthPct = (count / totalDist) * 100;
							return (
								<div
									key={tier}
									className="flex items-center justify-center text-xs font-medium cursor-pointer transition-opacity hover:opacity-80"
									style={{
										width: `${widthPct}%`,
										background: tierColor(tier, theme),
										color: tier === 'unscored' ? theme.colors.textMain : '#fff',
										minWidth: count > 0 ? '24px' : 0,
									}}
									title={`${tierLabel(tier)}: ${count} memories`}
									onClick={() => setTierFilter(tierFilter === tier ? 'all' : tier)}
								>
									{widthPct > 10 ? count : ''}
								</div>
							);
						})}
					</div>
					<div className="flex gap-3 mt-1">
						{(['high', 'medium', 'low', 'unscored'] as const).map((tier) => (
							<button
								key={tier}
								className="flex items-center gap-1 text-xs cursor-pointer transition-opacity"
								style={{
									color: tierFilter === tier ? tierColor(tier, theme) : theme.colors.textDim,
									opacity: tierFilter !== 'all' && tierFilter !== tier ? 0.4 : 1,
									background: 'none',
									border: 'none',
									padding: 0,
								}}
								onClick={() => setTierFilter(tierFilter === tier ? 'all' : tier)}
							>
								<span
									className="w-2 h-2 rounded-full inline-block"
									style={{ background: tierColor(tier, theme) }}
								/>
								{tierLabel(tier)} ({dist[tier]})
							</button>
						))}
					</div>
				</div>
			)}

			{/* ─── Scope & Type Breakdown ──────────────────────────────────── */}
			<SectionHeader
				title="Breakdown by Scope & Type"
				theme={theme}
				icon={BarChart3}
				collapsible
				collapsed={!breakdownExpanded}
				onToggle={() => setBreakdownExpanded((p) => !p)}
			/>
			{breakdownExpanded && (
				<div className="grid grid-cols-2 gap-3">
					<BreakdownTable
						theme={theme}
						title="By Scope"
						data={Object.entries(analysis.byScope).map(([scope, v]) => ({
							label: scope,
							count: v.count,
							avgEff: v.avgEffectiveness,
							avgROI: v.avgROI,
						}))}
					/>
					<BreakdownTable
						theme={theme}
						title="By Type"
						data={Object.entries(analysis.byType).map(([type, v]) => ({
							label: type,
							count: v.count,
							avgEff: v.avgEffectiveness,
							avgROI: v.avgROI,
						}))}
					/>
				</div>
			)}

			{/* ─── Top Performers ───────────────────────────────────────────── */}
			<SectionHeader
				title="Top Performers"
				theme={theme}
				icon={TrendingUp}
				description="Highest ROI memories"
				badge={analysis.topPerformers.length}
				collapsible
				collapsed={!topPerfExpanded}
				onToggle={() => setTopPerfExpanded((p) => !p)}
			/>
			{topPerfExpanded && (
				<div className="space-y-1">
					{analysis.topPerformers.length === 0 ? (
						<div className="text-xs py-3 text-center" style={{ color: theme.colors.textDim }}>
							No scored memories yet. Memories are scored after agent sessions complete.
						</div>
					) : (
						analysis.topPerformers.map((m) => (
							<MemoryRow key={m.id} memory={m} theme={theme} />
						))
					)}
				</div>
			)}

			{/* ─── Underperformers ──────────────────────────────────────────── */}
			<SectionHeader
				title="Needs Attention"
				theme={theme}
				icon={TrendingDown}
				description="Lowest effectiveness (scored only)"
				badge={analysis.underperformers.length}
				collapsible
				collapsed={!underPerfExpanded}
				onToggle={() => setUnderPerfExpanded((p) => !p)}
			/>
			{underPerfExpanded && (
				<div className="space-y-1">
					{analysis.underperformers.length === 0 ? (
						<div className="text-xs py-3 text-center" style={{ color: theme.colors.textDim }}>
							No underperforming memories detected.
						</div>
					) : (
						analysis.underperformers.map((m) => (
							<MemoryRow key={m.id} memory={m} theme={theme} />
						))
					)}
				</div>
			)}

			{/* ─── Full Memory Table ───────────────────────────────────────── */}
			<SectionHeader
				title="All Memories"
				theme={theme}
				icon={ArrowUpDown}
				description={`${filteredMemories.length} ${tierFilter !== 'all' ? tierFilter : ''} memories`}
				badge={filteredMemories.length}
				collapsible
				collapsed={!tableExpanded}
				onToggle={() => setTableExpanded((p) => !p)}
			/>
			{tableExpanded && (
				<div
					className="rounded border overflow-hidden"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Header */}
					<div
						className="grid text-xs font-medium"
						style={{
							gridTemplateColumns: '1fr 70px 70px 60px 55px 75px',
							background: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						<div className="px-2 py-1.5">Memory</div>
						<SortableHeader label="Effect." field="effectivenessScore" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
						<SortableHeader label="ROI" field="roi" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
						<SortableHeader label="Uses" field="useCount" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
						<SortableHeader label="Tokens" field="tokenEstimate" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
						<SortableHeader label="Last Used" field="lastUsedAt" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
					</div>
					{/* Rows */}
					<div style={{ maxHeight: '400px', overflowY: 'auto' }}>
						{filteredMemories.length === 0 ? (
							<div
								className="text-xs py-6 text-center"
								style={{ color: theme.colors.textDim }}
							>
								{tierFilter !== 'all'
									? `No ${tierLabel(tierFilter).toLowerCase()} memories found.`
									: 'No memories to display.'}
							</div>
						) : (
							filteredMemories.map((m) => (
								<div
									key={m.id}
									className="grid text-xs border-t"
									style={{
										gridTemplateColumns: '1fr 70px 70px 60px 55px 75px',
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
								>
									<div className="px-2 py-1.5 truncate flex items-center gap-1" title={m.content}>
										<span
											className="w-1.5 h-1.5 rounded-full shrink-0"
											style={{ background: tierColor(m.tier, theme) }}
										/>
										{m.pinned && <Pin className="w-2.5 h-2.5 shrink-0" style={{ color: theme.colors.accent }} />}
										<span className="truncate">{m.content}</span>
										{m.skillAreaName && (
											<span
												className="text-xs shrink-0 ml-1"
												style={{ color: theme.colors.textDim }}
											>
												({m.skillAreaName})
											</span>
										)}
									</div>
									<div className="px-2 py-1.5 text-center" style={{ color: tierColor(m.tier, theme) }}>
										{m.tier === 'unscored' ? '—' : pct(m.effectivenessScore)}
										{m.effectivenessDelta !== 0 && (
											<span className="ml-0.5">
												{m.effectivenessDelta > 0 ? (
													<TrendingUp className="w-2.5 h-2.5 inline" style={{ color: '#22c55e' }} />
												) : (
													<TrendingDown className="w-2.5 h-2.5 inline" style={{ color: '#ef4444' }} />
												)}
											</span>
										)}
									</div>
									<div className="px-2 py-1.5 text-center">{m.roi.toFixed(2)}</div>
									<div className="px-2 py-1.5 text-center">{m.useCount}</div>
									<div className="px-2 py-1.5 text-center" style={{ color: theme.colors.textDim }}>
										{m.tokenEstimate}
									</div>
									<div className="px-2 py-1.5 text-center" style={{ color: theme.colors.textDim }}>
										{relativeTime(m.lastUsedAt)}
									</div>
								</div>
							))
						)}
					</div>
				</div>
			)}

			{/* Refresh */}
			<div className="flex justify-end">
				<button
					className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors"
					style={{
						color: theme.colors.accent,
						background: 'transparent',
						border: `1px solid ${theme.colors.border}`,
						cursor: 'pointer',
					}}
					onClick={fetchAnalysis}
				>
					<RefreshCw className="w-3 h-3" />
					Refresh
				</button>
			</div>
		</div>
	);
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SummaryCard({
	theme,
	label,
	value,
	icon: Icon,
	color,
}: {
	theme: Theme;
	label: string;
	value: string;
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	color: string;
}) {
	return (
		<div
			className="rounded px-3 py-2 flex flex-col gap-0.5"
			style={{ background: theme.colors.bgActivity, border: `1px solid ${theme.colors.border}` }}
		>
			<div className="flex items-center gap-1.5">
				<Icon className="w-3.5 h-3.5" style={{ color }} />
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{label}
				</span>
			</div>
			<span className="text-lg font-semibold" style={{ color }}>
				{value}
			</span>
		</div>
	);
}

function SortableHeader({
	label,
	field,
	sortField,
	sortDir,
	onSort,
}: {
	label: string;
	field: SortField;
	sortField: SortField;
	sortDir: SortDir;
	onSort: (f: SortField) => void;
}) {
	const active = sortField === field;
	return (
		<div
			className="px-2 py-1.5 text-center cursor-pointer select-none hover:opacity-80"
			onClick={() => onSort(field)}
		>
			{label}
			{active && <span className="ml-0.5">{sortDir === 'desc' ? '↓' : '↑'}</span>}
		</div>
	);
}

function BreakdownTable({
	theme,
	title,
	data,
}: {
	theme: Theme;
	title: string;
	data: { label: string; count: number; avgEff: number; avgROI: number }[];
}) {
	return (
		<div
			className="rounded border overflow-hidden"
			style={{ borderColor: theme.colors.border }}
		>
			<div
				className="px-2 py-1.5 text-xs font-medium"
				style={{ background: theme.colors.bgActivity, color: theme.colors.textMain }}
			>
				{title}
			</div>
			{data.map((row) => (
				<div
					key={row.label}
					className="flex items-center justify-between px-2 py-1 text-xs border-t"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					<span className="capitalize">{row.label}</span>
					<div className="flex items-center gap-3" style={{ color: theme.colors.textDim }}>
						<span>{row.count} memories</span>
						<span style={{ color: row.avgEff >= 0.5 ? '#22c55e' : row.avgEff >= 0.3 ? '#eab308' : theme.colors.textDim }}>
							{pct(row.avgEff)} eff
						</span>
						<span>{row.avgROI.toFixed(2)} ROI</span>
					</div>
				</div>
			))}
		</div>
	);
}

function MemoryRow({ memory: m, theme }: { memory: MemoryEfficiencyRecord; theme: Theme }) {
	return (
		<div
			className="flex items-start gap-2 px-3 py-2 rounded text-xs"
			style={{ background: theme.colors.bgActivity, border: `1px solid ${theme.colors.border}` }}
		>
			<span
				className="w-2 h-2 rounded-full shrink-0 mt-1"
				style={{ background: tierColor(m.tier, theme) }}
			/>
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-1.5">
					<span className="truncate font-medium" style={{ color: theme.colors.textMain }}>
						{m.content}
					</span>
					{m.pinned && <Pin className="w-2.5 h-2.5 shrink-0" style={{ color: theme.colors.accent }} />}
				</div>
				<div className="flex items-center gap-3 mt-0.5" style={{ color: theme.colors.textDim }}>
					<span className="capitalize">{m.scope}</span>
					<span>{m.type}</span>
					{m.skillAreaName && <span>{m.skillAreaName}</span>}
					<span>{m.useCount} uses</span>
					<span>{m.tokenEstimate} tokens</span>
				</div>
			</div>
			<div className="flex flex-col items-end shrink-0 gap-0.5">
				<span className="font-medium" style={{ color: tierColor(m.tier, theme) }}>
					{m.tier === 'unscored' ? '—' : pct(m.effectivenessScore)}
				</span>
				<span style={{ color: theme.colors.textDim }}>
					ROI {m.roi.toFixed(2)}
				</span>
				{m.effectivenessDelta !== 0 && (
					<span className="flex items-center gap-0.5">
						{m.effectivenessDelta > 0 ? (
							<TrendingUp className="w-2.5 h-2.5" style={{ color: '#22c55e' }} />
						) : (
							<TrendingDown className="w-2.5 h-2.5" style={{ color: '#ef4444' }} />
						)}
					</span>
				)}
			</div>
		</div>
	);
}
