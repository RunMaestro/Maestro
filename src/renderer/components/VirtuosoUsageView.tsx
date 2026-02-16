/**
 * VirtuosoUsageView - Usage tab content for the VirtuososModal
 *
 * Presents account usage data in three sections:
 * A) Current Window Overview — aggregate summary + per-account usage cards
 * B) Predictions — linear/P90 time-to-limit estimates
 * C) Historical — per-account expandable history + throttle event timeline
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
	Activity,
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	Clock,
	TrendingUp,
	Users,
	Zap,
	BarChart3,
} from 'lucide-react';
import type { Theme, Session } from '../types';
import type { AccountProfile } from '../../shared/account-types';
import { useAccountUsage, formatTimeRemaining, formatTokenCount } from '../hooks/useAccountUsage';
import { AccountUsageHistory } from './AccountUsageHistory';
import { AccountTrendChart } from './UsageDashboard/AccountTrendChart';
import { AccountRateMetrics } from './UsageDashboard/AccountRateMetrics';

interface ThrottleEvent {
	timestamp: number;
	accountId: string;
	accountName?: string;
	reason: string;
	totalTokens: number;
	recoveryAction?: string;
}

interface VirtuosoUsageViewProps {
	theme: Theme;
	sessions?: Session[];
}

export function VirtuosoUsageView({ theme, sessions }: VirtuosoUsageViewProps) {
	const { metrics, loading } = useAccountUsage();
	const [accounts, setAccounts] = useState<AccountProfile[]>([]);
	const [throttleEvents, setThrottleEvents] = useState<ThrottleEvent[]>([]);
	const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			const [accountList, events] = await Promise.all([
				window.maestro.accounts.list() as Promise<AccountProfile[]>,
				window.maestro.accounts.getThrottleEvents() as Promise<ThrottleEvent[]>,
			]);
			setAccounts(accountList || []);
			setThrottleEvents(events || []);
		} catch (err) {
			console.warn('[VirtuosoUsageView] Failed to fetch data:', err);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	// Derive aggregate stats from metrics
	const metricsArray = useMemo(() => Object.values(metrics), [metrics]);

	const activeCount = useMemo(() => {
		return accounts.filter((a) => a.status === 'active').length;
	}, [accounts]);

	const totalTokensThisWindow = useMemo(() => {
		return metricsArray.reduce((sum, m) => sum + m.totalTokens, 0);
	}, [metricsArray]);

	const totalCostThisWindow = useMemo(() => {
		return metricsArray.reduce((sum, m) => sum + m.costUsd, 0);
	}, [metricsArray]);

	// Count sessions per account
	const sessionCountByAccount = useMemo(() => {
		if (!sessions) return {};
		const counts: Record<string, number> = {};
		for (const s of sessions) {
			if (s.accountId) {
				counts[s.accountId] = (counts[s.accountId] || 0) + 1;
			}
		}
		return counts;
	}, [sessions]);

	// Accounts with token limits configured (for predictions section)
	const accountsWithLimits = useMemo(() => {
		return metricsArray.filter((m) => m.limitTokens > 0);
	}, [metricsArray]);

	if (loading && accounts.length === 0) {
		return (
			<div className="flex items-center justify-center py-12">
				<Activity className="w-5 h-5 animate-spin" style={{ color: theme.colors.accent }} />
				<span className="ml-2 text-sm" style={{ color: theme.colors.textDim }}>
					Loading usage data...
				</span>
			</div>
		);
	}

	if (accounts.length === 0) {
		return (
			<div className="text-center py-12">
				<Users className="w-8 h-8 mx-auto mb-3" style={{ color: theme.colors.textDim }} />
				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					No Virtuoso accounts configured.
				</p>
				<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
					Switch to the Configuration tab to add accounts.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Section A: Aggregate Summary */}
			<div
				className="grid grid-cols-4 gap-4 text-center py-3 px-4 rounded-lg"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<div>
					<div className="text-lg font-bold" style={{ color: theme.colors.textMain }}>
						{accounts.length}
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Virtuosos
					</div>
				</div>
				<div>
					<div className="text-lg font-bold" style={{ color: theme.colors.textMain }}>
						{activeCount}
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Active
					</div>
				</div>
				<div>
					<div className="text-lg font-bold" style={{ color: theme.colors.textMain }}>
						{formatTokenCount(totalTokensThisWindow)}
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Tokens This Window
					</div>
				</div>
				<div>
					<div className="text-lg font-bold" style={{ color: theme.colors.textMain }}>
						${totalCostThisWindow.toFixed(2)}
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Cost This Window
					</div>
				</div>
			</div>

			{/* Section A: Per-Account Usage Cards */}
			<div>
				<h3
					className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<Activity className="w-3.5 h-3.5" />
					Current Window
				</h3>
				<div
					className="grid gap-3"
					style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
				>
					{accounts.map((account) => {
						const usage = metrics[account.id];
						const severityColor = getSeverityColor(usage?.usagePercent, theme);
						const sessionCount = sessionCountByAccount[account.id] || 0;

						return (
							<div
								key={account.id}
								className="rounded-lg p-3 border"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgActivity,
								}}
							>
								{/* Header */}
								<div className="flex items-center justify-between mb-2">
									<div className="flex items-center gap-2 min-w-0">
										<span
											className="text-sm font-medium truncate"
											style={{ color: theme.colors.textMain }}
										>
											{account.name || account.email}
										</span>
										<span
											className="text-[10px] px-1.5 py-0.5 rounded-full"
											style={{
												backgroundColor: getStatusColor(account.status, theme).bg,
												color: getStatusColor(account.status, theme).fg,
											}}
										>
											{account.status}
										</span>
									</div>
									{sessions && sessionCount > 0 && (
										<span
											className="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
											style={{
												backgroundColor: theme.colors.accent + '20',
												color: theme.colors.accent,
											}}
										>
											{sessionCount} session{sessionCount !== 1 ? 's' : ''}
										</span>
									)}
								</div>

								{usage ? (
									<>
										{/* Usage bar */}
										{usage.limitTokens > 0 && (
											<div className="mb-2">
												<div
													className="w-full h-1.5 rounded-full overflow-hidden"
													style={{ backgroundColor: theme.colors.border }}
												>
													<div
														className="h-full rounded-full transition-all"
														style={{
															width: `${Math.min(usage.usagePercent ?? 0, 100)}%`,
															backgroundColor: severityColor,
														}}
													/>
												</div>
												<div
													className="flex justify-between mt-1 text-[10px]"
													style={{ color: theme.colors.textDim }}
												>
													<span>
														{formatTokenCount(usage.totalTokens)} /{' '}
														{formatTokenCount(usage.limitTokens)}
													</span>
													<span style={{ color: severityColor }}>
														{usage.usagePercent?.toFixed(0) ?? 0}%
													</span>
												</div>
											</div>
										)}

										{/* Token breakdown */}
										<div
											className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] mb-1.5"
											style={{ color: theme.colors.textDim }}
										>
											<div>
												In:{' '}
												<span style={{ color: theme.colors.textMain }}>
													{formatTokenCount(usage.inputTokens)}
												</span>
											</div>
											<div>
												Out:{' '}
												<span style={{ color: theme.colors.textMain }}>
													{formatTokenCount(usage.outputTokens)}
												</span>
											</div>
											<div>
												Cache R:{' '}
												<span style={{ color: theme.colors.textMain }}>
													{formatTokenCount(usage.cacheReadTokens)}
												</span>
											</div>
											<div>
												Cache W:{' '}
												<span style={{ color: theme.colors.textMain }}>
													{formatTokenCount(usage.cacheCreationTokens)}
												</span>
											</div>
										</div>

										{/* Metrics grid */}
										<div
											className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]"
											style={{ color: theme.colors.textDim }}
										>
											{usage.limitTokens === 0 && (
												<div>
													Total:{' '}
													<span style={{ color: theme.colors.textMain }}>
														{formatTokenCount(usage.totalTokens)}
													</span>
												</div>
											)}
											<div>
												Cost:{' '}
												<span style={{ color: theme.colors.textMain }}>
													${usage.costUsd.toFixed(2)}
												</span>
											</div>
											<div>
												Queries:{' '}
												<span style={{ color: theme.colors.textMain }}>
													{usage.queryCount}
												</span>
											</div>
											<div>
												Burn:{' '}
												<span style={{ color: theme.colors.textMain }}>
													~{formatTokenCount(Math.round(usage.burnRatePerHour))}/hr
												</span>
												{usage?.rateMetrics?.trend && usage.rateMetrics.trend !== 'stable' && (
													<span
														className="ml-1"
														style={{
															color: usage.rateMetrics.trend === 'up'
																? theme.colors.warning
																: theme.colors.success,
														}}
													>
														{usage.rateMetrics.trend === 'up' ? '\u2197' : '\u2198'}
													</span>
												)}
											</div>
											{usage.estimatedTimeToLimitMs !== null && (
												<div>
													TTL:{' '}
													<span style={{ color: severityColor }}>
														{formatTimeRemaining(usage.estimatedTimeToLimitMs)}
													</span>
												</div>
											)}
											<div>
												Reset:{' '}
												<span style={{ color: theme.colors.textMain }}>
													{formatTimeRemaining(usage.timeRemainingMs)}
												</span>
											</div>
										</div>

										{/* 7-day sparkline */}
										{usage && (
											<div className="mt-2 pt-1.5 border-t" style={{ borderColor: theme.colors.border + '40' }}>
												<AccountTrendChart accountId={account.id} theme={theme} days={7} compact={true} />
											</div>
										)}
									</>
								) : (
									<p
										className="text-[11px] italic"
										style={{ color: theme.colors.textDim }}
									>
										No usage data for current window
									</p>
								)}
							</div>
						);
					})}
				</div>
			</div>

			{/* Section B: Predictions */}
			{accountsWithLimits.length > 0 && (
				<div>
					<h3
						className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
						style={{ color: theme.colors.textDim }}
					>
						<TrendingUp className="w-3.5 h-3.5" />
						Predictions
					</h3>
					<div className="space-y-2">
						{accountsWithLimits.map((usage) => {
							const account = accounts.find((a) => a.id === usage.accountId);
							if (!account) return null;
							const pred = usage.prediction;

							return (
								<div
									key={usage.accountId}
									className="rounded-lg p-3 border text-xs"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									<div className="flex items-center justify-between mb-2">
										<span
											className="font-medium"
											style={{ color: theme.colors.textMain }}
										>
											{account.name || account.email}
										</span>
										<span
											className="px-1.5 py-0.5 rounded-full text-[10px]"
											style={{
												backgroundColor:
													pred.confidence === 'high'
														? theme.colors.success + '20'
														: pred.confidence === 'medium'
															? theme.colors.warning + '20'
															: theme.colors.error + '20',
												color:
													pred.confidence === 'high'
														? theme.colors.success
														: pred.confidence === 'medium'
															? theme.colors.warning
															: theme.colors.error,
											}}
										>
											{pred.confidence} confidence
										</span>
									</div>
									<div
										className="grid grid-cols-2 gap-x-4 gap-y-1"
										style={{ color: theme.colors.textDim }}
									>
										<div>
											Linear TTL:{' '}
											<span style={{ color: theme.colors.textMain }}>
												{pred.linearTimeToLimitMs
													? formatTimeRemaining(pred.linearTimeToLimitMs)
													: '—'}
											</span>
										</div>
										<div>
											P90 est:{' '}
											<span style={{ color: theme.colors.textMain }}>
												{pred.weightedTimeToLimitMs
													? formatTimeRemaining(pred.weightedTimeToLimitMs)
													: '—'}
											</span>
										</div>
										<div>
											Avg/window:{' '}
											<span style={{ color: theme.colors.textMain }}>
												{formatTokenCount(Math.round(pred.avgTokensPerWindow))}
											</span>
										</div>
										<div>
											Windows remaining (P90):{' '}
											<span style={{ color: theme.colors.textMain }}>
												{pred.windowsRemainingP90 !== null
													? pred.windowsRemainingP90.toFixed(1)
													: '—'}
											</span>
										</div>
									</div>
								</div>
							);
						})}

						{/* Aggregate exhaustion warning */}
						{(() => {
							const exhaustingSoon = accountsWithLimits.filter(
								(m) =>
									m.prediction.linearTimeToLimitMs !== null &&
									m.prediction.linearTimeToLimitMs < 24 * 60 * 60 * 1000
							);
							if (exhaustingSoon.length === 0) return null;
							const soonestMs = Math.min(
								...exhaustingSoon.map((m) => m.prediction.linearTimeToLimitMs!)
							);
							return (
								<div
									className="flex items-center gap-2 text-xs p-2 rounded-lg"
									style={{
										backgroundColor: theme.colors.warning + '15',
										color: theme.colors.warning,
									}}
								>
									<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
									<span>
										At current rates, {exhaustingSoon.length} account
										{exhaustingSoon.length !== 1 ? 's' : ''} will reach limit
										within {formatTimeRemaining(soonestMs)}
									</span>
								</div>
							);
						})()}
					</div>
				</div>
			)}

			{/* Section B.5: Trends & Analytics */}
			{accounts.length > 0 && (
				<div>
					<h3
						className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
						style={{ color: theme.colors.textDim }}
					>
						<BarChart3 className="w-3.5 h-3.5" />
						Trends &amp; Analytics
					</h3>
					<div className="space-y-4">
						{accounts.map((account) => {
							const usage = metrics[account.id];
							if (!usage) return null;
							return (
								<div
									key={account.id}
									className="rounded-lg p-3 border"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									<div
										className="text-xs font-medium mb-2"
										style={{ color: theme.colors.textMain }}
									>
										{account.name || account.email}
									</div>
									<AccountTrendChart accountId={account.id} theme={theme} days={30} />
									{usage.rateMetrics && (
										<div className="mt-3">
											<AccountRateMetrics rateMetrics={usage.rateMetrics} theme={theme} />
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Section C: Historical Usage */}
			<div>
				<h3
					className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<Clock className="w-3.5 h-3.5" />
					Historical Usage
				</h3>
				<div className="space-y-1">
					{accounts.map((account) => (
						<div key={account.id}>
							<button
								onClick={() =>
									setExpandedAccountId(
										expandedAccountId === account.id ? null : account.id
									)
								}
								className="w-full flex items-center gap-2 py-2 px-2 rounded-lg text-xs text-left transition-colors"
								style={{ color: theme.colors.textMain }}
								onMouseEnter={(e) => {
									e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
								}}
								onMouseLeave={(e) => {
									e.currentTarget.style.backgroundColor = 'transparent';
								}}
							>
								{expandedAccountId === account.id ? (
									<ChevronDown className="w-3 h-3 flex-shrink-0" />
								) : (
									<ChevronRight className="w-3 h-3 flex-shrink-0" />
								)}
								<span className="font-medium">
									{account.name || account.email}
								</span>
							</button>
							{expandedAccountId === account.id && (
								<div className="ml-5 mb-3">
									<AccountUsageHistory
										accountId={account.id}
										theme={theme}
									/>
								</div>
							)}
						</div>
					))}
				</div>
			</div>

			{/* Section C: Throttle Event Timeline */}
			<div>
				<h3
					className="text-xs font-bold uppercase mb-2 flex items-center gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<AlertTriangle className="w-3.5 h-3.5" />
					Recent Throttle Events
				</h3>
				{throttleEvents.length === 0 ? (
					<p
						className="text-xs py-4 text-center"
						style={{ color: theme.colors.textDim }}
					>
						No throttle events recorded
					</p>
				) : (
					<div className="space-y-1">
						{throttleEvents.slice(0, 20).map((event, i) => (
							<div
								key={i}
								className="flex items-center gap-3 text-xs py-1.5 border-b"
								style={{ borderColor: theme.colors.border }}
							>
								<span
									className="tabular-nums"
									style={{ color: theme.colors.textDim }}
								>
									{new Date(event.timestamp).toLocaleString()}
								</span>
								<span style={{ color: theme.colors.textMain }}>
									{event.accountName || event.accountId}
								</span>
								<span style={{ color: theme.colors.warning }}>
									{formatTokenCount(event.totalTokens)} tokens
								</span>
								{event.recoveryAction && (
									<span style={{ color: theme.colors.success }}>
										&rarr; {event.recoveryAction}
									</span>
								)}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

// Helpers

function getSeverityColor(usagePercent: number | null | undefined, theme: Theme): string {
	if (usagePercent == null) return theme.colors.accent;
	if (usagePercent > 80) return theme.colors.error;
	if (usagePercent > 60) return theme.colors.warning;
	return theme.colors.success;
}

function getStatusColor(
	status: string,
	theme: Theme
): { bg: string; fg: string } {
	const styles: Record<string, { bg: string; fg: string }> = {
		active: { bg: theme.colors.success + '20', fg: theme.colors.success },
		throttled: { bg: theme.colors.warning + '20', fg: theme.colors.warning },
		disabled: { bg: theme.colors.error + '20', fg: theme.colors.error },
	};
	return styles[status] || styles.disabled;
}
