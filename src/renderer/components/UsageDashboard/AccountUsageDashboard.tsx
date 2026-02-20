/**
 * AccountUsageDashboard
 *
 * Real-time account usage monitoring panel that shows per-account token consumption,
 * limit progress bars, active session assignments, and throttle history.
 * Integrated as a tab within the existing Usage Dashboard.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
	Users,
	Activity,
	AlertTriangle,
	Zap,
	TrendingUp,
	ArrowRightLeft,
} from 'lucide-react';
import { useAccountUsage } from '../../hooks/useAccountUsage';
import { AccountTrendChart } from './AccountTrendChart';
import type { Theme, Session } from '../../types';
import type {
	AccountProfile,
	AccountUsageSnapshot,
	AccountAssignment,
	AccountCapacityMetrics,
} from '../../../shared/account-types';

interface AccountUsageDashboardProps {
	theme: Theme;
	sessions?: Session[];
	onClose: () => void;
}

/** Format token counts with K/M suffixes */
function formatTokens(n: number): string {
	if (n == null || isNaN(n)) return '0';
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}

/** Format cost in USD */
function formatCost(usd: number): string {
	if (usd == null || isNaN(usd)) return '$0.00';
	if (usd === 0) return '$0.00';
	if (usd < 0.01) return '<$0.01';
	return `$${usd.toFixed(2)}`;
}

/** Format remaining time from ms */
function formatTimeRemaining(ms: number): string {
	if (ms <= 0) return 'Expired';
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** Get usage color based on percentage */
function getUsageColor(percent: number | null, theme: Theme): string {
	if (percent === null) return theme.colors.accent;
	if (percent > 95) return theme.colors.error;
	if (percent > 80) return '#f97316'; // orange
	if (percent > 60) return theme.colors.warning;
	return theme.colors.success;
}

/** Get status badge style */
function getStatusStyle(status: string, theme: Theme): { bg: string; fg: string } {
	const styles: Record<string, { bg: string; fg: string }> = {
		active: { bg: theme.colors.success + '20', fg: theme.colors.success },
		throttled: { bg: theme.colors.warning + '20', fg: theme.colors.warning },
		expired: { bg: theme.colors.error + '20', fg: theme.colors.error },
		disabled: { bg: theme.colors.error + '20', fg: theme.colors.error },
	};
	return styles[status] || styles.disabled;
}

interface ThrottleEvent {
	timestamp: number;
	accountId: string;
	accountName?: string;
	reason: string;
	totalTokens: number;
	recoveryAction?: string;
}

export function AccountUsageDashboard({ theme, sessions = [] }: AccountUsageDashboardProps) {
	const [accounts, setAccounts] = useState<AccountProfile[]>([]);
	const [usageData, setUsageData] = useState<Record<string, AccountUsageSnapshot>>({});
	const [assignments, setAssignments] = useState<AccountAssignment[]>([]);
	const [throttleEvents, setThrottleEvents] = useState<ThrottleEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { metrics: accountMetrics } = useAccountUsage();

	// Fetch all data on mount
	const fetchData = useCallback(async () => {
		try {
			const [accountList, allUsage, allAssignments, events] = await Promise.all([
				window.maestro.accounts.list() as Promise<AccountProfile[]>,
				window.maestro.accounts.getAllUsage() as Promise<Record<string, AccountUsageSnapshot>>,
				window.maestro.accounts.getAllAssignments() as Promise<AccountAssignment[]>,
				window.maestro.accounts.getThrottleEvents() as Promise<ThrottleEvent[]>,
			]);
			setAccounts(accountList);
			setUsageData(allUsage || {});
			setAssignments(allAssignments || []);
			setThrottleEvents(events || []);
			setError(null);
		} catch (err) {
			console.error('Failed to fetch account usage data:', err);
			setError(err instanceof Error ? err.message : 'Failed to load account data');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();

		// Poll every 30 seconds
		const pollInterval = setInterval(fetchData, 30_000);

		// Listen for real-time usage updates
		const unsubUsage = window.maestro.accounts.onUsageUpdate((data) => {
			setUsageData((prev) => {
				const defaults: AccountUsageSnapshot = {
					accountId: data.accountId,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: 0,
					windowStart: 0,
					windowEnd: 0,
					queryCount: 0,
					usagePercent: null,
				};
				return {
					...prev,
					[data.accountId]: {
						...defaults,
						...prev[data.accountId],
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheReadTokens: data.cacheReadTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						costUsd: data.costUsd,
						windowStart: data.windowStart,
						windowEnd: data.windowEnd,
						queryCount: data.queryCount,
						usagePercent: data.usagePercent,
					},
				};
			});
		});

		return () => {
			clearInterval(pollInterval);
			unsubUsage();
		};
	}, [fetchData]);

	// Build session lookup map
	const sessionMap = useMemo(() => {
		const map = new Map<string, Session>();
		for (const s of sessions) {
			map.set(s.id, s);
		}
		return map;
	}, [sessions]);

	// Build account lookup map
	const accountMap = useMemo(() => {
		const map = new Map<string, AccountProfile>();
		for (const a of accounts) {
			map.set(a.id, a);
		}
		return map;
	}, [accounts]);

	// Capacity metrics (derived)
	const capacityMetrics = useMemo((): AccountCapacityMetrics | null => {
		if (accounts.length === 0) return null;

		const totalTokens = Object.values(usageData).reduce((sum, u) => {
			return sum + (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0);
		}, 0);

		// Estimate tokens/hour based on current window
		const windowMs = accounts[0]?.tokenWindowMs || 5 * 60 * 60 * 1000;
		const hoursInWindow = windowMs / 3_600_000;
		const avgTokensPerHour = hoursInWindow > 0 ? Math.round(totalTokens / hoursInWindow / accounts.length) : 0;
		const peakTokensPerHour = avgTokensPerHour * 1.5; // estimate

		// Recommend accounts based on usage
		const maxTokensPerAccountPerHour = accounts[0]?.tokenLimitPerWindow
			? accounts[0].tokenLimitPerWindow / hoursInWindow
			: 200_000;
		const recommended = maxTokensPerAccountPerHour > 0
			? Math.max(1, Math.ceil(peakTokensPerHour / maxTokensPerAccountPerHour))
			: 1;

		return {
			avgTokensPerHour,
			peakTokensPerHour: Math.round(peakTokensPerHour),
			throttleEvents: throttleEvents.length,
			recommendedAccountCount: recommended,
			analysisWindowMs: windowMs,
		};
	}, [accounts, usageData, throttleEvents]);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-20" style={{ color: theme.colors.textDim }}>
				Loading virtuoso usage data...
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex flex-col items-center justify-center py-20 gap-4" style={{ color: theme.colors.textDim }}>
				<p>Failed to load virtuoso data: {error}</p>
				<button
					onClick={fetchData}
					className="px-4 py-2 rounded text-sm"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
				>
					Retry
				</button>
			</div>
		);
	}

	if (accounts.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-20 gap-3" style={{ color: theme.colors.textDim }}>
				<Users className="w-10 h-10" style={{ opacity: 0.3 }} />
				<p className="text-sm">No virtuosos registered</p>
				<p className="text-xs" style={{ opacity: 0.6 }}>
					Add virtuosos via the Virtuosos menu to start tracking usage
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Section 1: Virtuoso Overview Cards */}
			<div>
				<h3
					className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<Activity className="w-3.5 h-3.5" />
					Virtuoso Overview
				</h3>
				<div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
					{accounts.map((account) => {
						const usage = usageData[account.id];
						const percent = usage?.usagePercent ?? null;
						const totalTokens = usage
							? (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0)
							: 0;
						const timeRemaining = usage?.windowEnd ? usage.windowEnd - Date.now() : 0;
						const activeSessionCount = assignments.filter((a) => a.accountId === account.id).length;
						const usageColor = getUsageColor(percent, theme);
						const statusStyle = getStatusStyle(account.status, theme);

						return (
							<div
								key={account.id}
								className="rounded-lg p-4"
								style={{
									backgroundColor: theme.colors.bgActivity,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{/* Header: name + status */}
								<div className="flex items-center justify-between mb-3">
									<div className="flex items-center gap-2 min-w-0">
										<span
											className="text-sm font-bold truncate"
											style={{ color: theme.colors.textMain }}
											title={account.email}
										>
											{account.email || account.name}
										</span>
										{account.isDefault && (
											<span
												className="text-[9px] font-bold px-1 py-0.5 rounded"
												style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
											>
												DEFAULT
											</span>
										)}
									</div>
									<span
										className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0"
										style={{ backgroundColor: statusStyle.bg, color: statusStyle.fg }}
									>
										{account.status}
									</span>
								</div>

								{/* Progress bar */}
								<div className="mb-3">
									<div className="flex items-center justify-between text-xs mb-1">
										<span style={{ color: theme.colors.textDim }}>
											{percent !== null ? `${Math.round(percent)}% of limit` : 'No limit set'}
										</span>
										<span style={{ color: usageColor, fontWeight: 'bold' }}>
											{formatTokens(totalTokens)}
											{account.tokenLimitPerWindow > 0 && (
												<span style={{ color: theme.colors.textDim, fontWeight: 'normal' }}>
													{' / '}{formatTokens(account.tokenLimitPerWindow)}
												</span>
											)}
										</span>
									</div>
									<div
										className="h-2 rounded-full overflow-hidden"
										style={{ backgroundColor: theme.colors.bgActivity }}
									>
										<div
											className="h-full rounded-full transition-all duration-500"
											style={{
												width: `${Math.min(percent ?? 0, 100)}%`,
												backgroundColor: usageColor,
											}}
										/>
									</div>
								</div>

								{/* Sparkline */}
								<div className="mb-2">
									<AccountTrendChart accountId={account.id} theme={theme} defaultRange="7d" compact={true} />
								</div>

								{/* Stats grid */}
								<div className="grid grid-cols-3 gap-2 text-xs">
									<div>
										<div style={{ color: theme.colors.textDim }}>Window</div>
										<div style={{ color: theme.colors.textMain, fontWeight: 'bold' }}>
											{timeRemaining > 0 ? formatTimeRemaining(timeRemaining) : '—'}
										</div>
									</div>
									<div>
										<div style={{ color: theme.colors.textDim }}>Sessions</div>
										<div style={{ color: theme.colors.textMain, fontWeight: 'bold' }}>
											{activeSessionCount}
										</div>
									</div>
									<div>
										<div style={{ color: theme.colors.textDim }}>Cost</div>
										<div style={{ color: theme.colors.success, fontWeight: 'bold' }}>
											{formatCost(usage?.costUsd ?? 0)}
										</div>
									</div>
								</div>

								{/* Prediction row */}
								{(() => {
									const acctMetrics = accountMetrics[account.id];
									if (!acctMetrics || acctMetrics.burnRatePerHour <= 0) return null;
									return (
										<div
											className="grid grid-cols-3 gap-2 text-xs mt-2 pt-2 border-t"
											style={{ borderColor: theme.colors.border + '40' }}
										>
											<div>
												<div style={{ color: theme.colors.textDim }}>Burn</div>
												<div style={{ color: theme.colors.textMain, fontWeight: 'bold' }}>
													~{formatTokens(Math.round(acctMetrics.burnRatePerHour))}/hr
												</div>
											</div>
											<div>
												<div style={{ color: theme.colors.textDim }}>TTL</div>
												<div style={{
													color: acctMetrics.estimatedTimeToLimitMs !== null && acctMetrics.estimatedTimeToLimitMs < 3600000
														? theme.colors.error
														: theme.colors.textMain,
													fontWeight: 'bold',
												}}>
													{acctMetrics.estimatedTimeToLimitMs !== null
														? formatTimeRemaining(acctMetrics.estimatedTimeToLimitMs)
														: '—'}
												</div>
											</div>
											<div>
												<div style={{ color: theme.colors.textDim }}>Confidence</div>
												<div className="font-bold" style={{
													color: acctMetrics.prediction.confidence === 'high'
														? theme.colors.success
														: acctMetrics.prediction.confidence === 'medium'
															? theme.colors.warning
															: theme.colors.textDim,
												}}>
													{acctMetrics.prediction.confidence}
												</div>
											</div>
										</div>
									);
								})()}
							</div>
						);
					})}
				</div>
			</div>

			{/* Section 2: Active Assignments Table */}
			<div>
				<h3
					className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<ArrowRightLeft className="w-3.5 h-3.5" />
					Active Assignments
				</h3>
				{assignments.length === 0 ? (
					<div
						className="text-xs text-center py-6 rounded-lg"
						style={{ color: theme.colors.textDim, backgroundColor: theme.colors.bgActivity, border: `1px solid ${theme.colors.border}` }}
					>
						No active account assignments
					</div>
				) : (
					<div
						className="rounded-lg overflow-hidden"
						style={{ border: `1px solid ${theme.colors.border}` }}
					>
						<table className="w-full text-xs">
							<thead>
								<tr style={{ backgroundColor: theme.colors.bgActivity }}>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Session</th>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Account</th>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Agent</th>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Assigned</th>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Status</th>
								</tr>
							</thead>
							<tbody>
								{assignments.map((assignment) => {
									const session = sessionMap.get(assignment.sessionId);
									const account = accountMap.get(assignment.accountId);
									return (
										<tr
											key={`${assignment.sessionId}-${assignment.accountId}`}
											className="border-t"
											style={{ borderColor: theme.colors.border }}
										>
											<td className="px-3 py-2" style={{ color: theme.colors.textMain }}>
												{session?.name || assignment.sessionId.slice(0, 8)}
											</td>
											<td className="px-3 py-2" style={{ color: theme.colors.accent }}>
												{account?.email || assignment.accountId.slice(0, 8)}
											</td>
											<td className="px-3 py-2" style={{ color: theme.colors.textDim }}>
												{session?.toolType || '—'}
											</td>
											<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
												{new Date(assignment.assignedAt).toLocaleTimeString()}
											</td>
											<td className="px-3 py-2">
												<span
													className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
													style={{
														backgroundColor: session?.state === 'busy'
															? theme.colors.warning + '20'
															: theme.colors.success + '20',
														color: session?.state === 'busy'
															? theme.colors.warning
															: theme.colors.success,
													}}
												>
													{session?.state || 'unknown'}
												</span>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>

			{/* Section 3: Usage Timeline (simplified — bar chart per account) */}
			<div>
				<h3
					className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<TrendingUp className="w-3.5 h-3.5" />
					Usage by Account
				</h3>
				<div
					className="rounded-lg p-4"
					style={{ backgroundColor: theme.colors.bgActivity, border: `1px solid ${theme.colors.border}` }}
				>
					{accounts.map((account) => {
						const usage = usageData[account.id];
						const totalTokens = usage
							? (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0)
							: 0;
						const maxTokens = Math.max(
							...accounts.map((a) => {
								const u = usageData[a.id];
								return u ? (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) : 0;
							}),
							1
						);
						const barPercent = (totalTokens / maxTokens) * 100;
						const usageColor = getUsageColor(usage?.usagePercent ?? null, theme);

						return (
							<div key={account.id} className="flex items-center gap-3 mb-2 last:mb-0">
								<span
									className="text-xs font-mono truncate shrink-0"
									style={{ color: theme.colors.textDim, width: '120px' }}
									title={account.email}
								>
									{(account.email || account.name).split('@')[0]}
								</span>
								<div className="flex-1 relative">
									<div
										className="h-5 rounded"
										style={{ backgroundColor: theme.colors.bgMain }}
									>
										<div
											className="h-full rounded transition-all duration-500 flex items-center px-2"
											style={{
												width: `${Math.max(barPercent, 2)}%`,
												backgroundColor: usageColor + '40',
												borderLeft: `3px solid ${usageColor}`,
											}}
										>
											<span className="text-[10px] font-bold whitespace-nowrap" style={{ color: usageColor }}>
												{formatTokens(totalTokens)}
											</span>
										</div>
									</div>
									{/* Limit line */}
									{account.tokenLimitPerWindow > 0 && (
										<div
											className="absolute top-0 h-full"
											style={{
												left: `${Math.min((account.tokenLimitPerWindow / Math.max(maxTokens, account.tokenLimitPerWindow)) * 100, 100)}%`,
												borderLeft: `2px dashed ${theme.colors.error}60`,
											}}
											title={`Limit: ${formatTokens(account.tokenLimitPerWindow)}`}
										/>
									)}
								</div>
								{(() => {
									const m = accountMetrics[account.id];
									if (!m?.rateMetrics) return null;
									const trendSymbol = m.rateMetrics.trend === 'up' ? '\u2197' : m.rateMetrics.trend === 'down' ? '\u2198' : '\u2192';
									const trendColor = m.rateMetrics.trend === 'up' ? theme.colors.warning : m.rateMetrics.trend === 'down' ? theme.colors.success : theme.colors.textDim;
									return (
										<span className="text-[10px] shrink-0" style={{ color: trendColor }}>
											{trendSymbol} {formatTokens(Math.round(m.rateMetrics.tokensPerDay))}/day
										</span>
									);
								})()}
							</div>
						);
					})}
				</div>
			</div>

			{/* Section 4: Throttle History */}
			<div>
				<h3
					className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textDim }}
				>
					<AlertTriangle className="w-3.5 h-3.5" />
					Throttle History
				</h3>
				{throttleEvents.length === 0 ? (
					<div
						className="text-xs text-center py-6 rounded-lg"
						style={{ color: theme.colors.textDim, backgroundColor: theme.colors.bgActivity, border: `1px solid ${theme.colors.border}` }}
					>
						No throttle events recorded
					</div>
				) : (
					<div
						className="rounded-lg overflow-hidden max-h-[200px] overflow-y-auto scrollbar-thin"
						style={{ border: `1px solid ${theme.colors.border}` }}
					>
						<table className="w-full text-xs">
							<thead className="sticky top-0">
								<tr style={{ backgroundColor: theme.colors.bgActivity }}>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Time</th>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Account</th>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Reason</th>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Tokens</th>
									<th className="text-left px-3 py-2 font-bold" style={{ color: theme.colors.textDim }}>Recovery</th>
								</tr>
							</thead>
							<tbody>
								{throttleEvents.slice().reverse().map((event, i) => {
									const account = accountMap.get(event.accountId);
									return (
										<tr
											key={i}
											className="border-t"
											style={{ borderColor: theme.colors.border }}
										>
											<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
												{new Date(event.timestamp).toLocaleString()}
											</td>
											<td className="px-3 py-2" style={{ color: theme.colors.textMain }}>
												{event.accountName || account?.email || event.accountId.slice(0, 8)}
											</td>
											<td className="px-3 py-2">
												<span
													className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
													style={{
														backgroundColor: theme.colors.warning + '20',
														color: theme.colors.warning,
													}}
												>
													{event.reason.replace(/_/g, ' ')}
												</span>
											</td>
											<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
												{formatTokens(event.totalTokens)}
											</td>
											<td className="px-3 py-2" style={{ color: theme.colors.textDim }}>
												{event.recoveryAction || '—'}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</div>

			{/* Section 5: Capacity Recommendation */}
			{capacityMetrics && (
				<div>
					<h3
						className="text-xs font-bold uppercase mb-3 flex items-center gap-2"
						style={{ color: theme.colors.textDim }}
					>
						<Zap className="w-3.5 h-3.5" />
						Capacity Recommendation
					</h3>
					<div
						className="rounded-lg p-4"
						style={{ backgroundColor: theme.colors.bgActivity, border: `1px solid ${theme.colors.border}` }}
					>
						<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
							Based on your usage in the current window:
						</p>
						<div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
							<div>
								<div style={{ color: theme.colors.textDim }}>Avg tokens/hour</div>
								<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
									{formatTokens(capacityMetrics.avgTokensPerHour)}
								</div>
							</div>
							<div>
								<div style={{ color: theme.colors.textDim }}>Peak tokens/hour</div>
								<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
									{formatTokens(capacityMetrics.peakTokensPerHour)}
								</div>
							</div>
							<div>
								<div style={{ color: theme.colors.textDim }}>Throttle events</div>
								<div className="text-sm font-bold" style={{ color: capacityMetrics.throttleEvents > 0 ? theme.colors.warning : theme.colors.textMain }}>
									{capacityMetrics.throttleEvents}
								</div>
							</div>
							<div>
								<div style={{ color: theme.colors.textDim }}>Recommended accounts</div>
								<div className="text-sm font-bold" style={{ color: theme.colors.accent }}>
									{capacityMetrics.recommendedAccountCount}
									{capacityMetrics.recommendedAccountCount > accounts.length && (
										<span className="text-[10px] font-normal ml-1" style={{ color: theme.colors.warning }}>
											(need {capacityMetrics.recommendedAccountCount - accounts.length} more)
										</span>
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
