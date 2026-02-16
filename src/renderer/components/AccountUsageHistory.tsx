import React, { useState, useEffect } from 'react';
import type { Theme } from '../types';
import { formatTokenCount } from '../hooks/useAccountUsage';

interface AccountDailyUsage {
	date: string;
	totalTokens: number;
	costUsd: number;
	queryCount: number;
}

interface AccountMonthlyUsage {
	month: string;
	totalTokens: number;
	costUsd: number;
	queryCount: number;
	daysActive: number;
}

type ViewMode = '7d' | '30d' | 'monthly';

function formatDateLabel(label: string, view: ViewMode): string {
	if (view === 'monthly') {
		// YYYY-MM -> "Jan 26", "Feb 26", etc.
		const [year, month] = label.split('-');
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${months[parseInt(month, 10) - 1]} ${year.slice(2)}`;
	}
	// YYYY-MM-DD -> "Feb 15", etc.
	const [, month, day] = label.split('-');
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}`;
}

export function AccountUsageHistory({ accountId, theme }: { accountId: string; theme: Theme }) {
	const [view, setView] = useState<ViewMode>('7d');
	const [dailyData, setDailyData] = useState<AccountDailyUsage[]>([]);
	const [monthlyData, setMonthlyData] = useState<AccountMonthlyUsage[]>([]);
	const [throttleCount, setThrottleCount] = useState(0);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		async function load() {
			setLoading(true);
			try {
				if (view === 'monthly') {
					const data = await window.maestro.accounts.getMonthlyUsage(accountId, 6);
					setMonthlyData(data as AccountMonthlyUsage[]);
				} else {
					const days = view === '7d' ? 7 : 30;
					const data = await window.maestro.accounts.getDailyUsage(accountId, days);
					setDailyData(data as AccountDailyUsage[]);
				}

				// Fetch throttle events for displayed time range
				const sinceMs = view === 'monthly'
					? Date.now() - 6 * 30 * 24 * 60 * 60 * 1000
					: Date.now() - (view === '7d' ? 7 : 30) * 24 * 60 * 60 * 1000;
				const events = await window.maestro.accounts.getThrottleEvents(accountId, sinceMs);
				setThrottleCount(events.length);
			} catch (err) { console.warn('[AccountUsageHistory] Failed to load usage history:', err); }
			setLoading(false);
		}
		load();
	}, [accountId, view]);

	const data: Array<{ totalTokens: number; costUsd: number; queryCount: number }> & Array<AccountDailyUsage | AccountMonthlyUsage> =
		view === 'monthly' ? monthlyData : dailyData;
	const totalTokens = data.reduce((sum, d) => sum + d.totalTokens, 0);
	const avgTokens = data.length > 0 ? totalTokens / data.length : 0;
	const peakTokens = data.length > 0 ? Math.max(...data.map(d => d.totalTokens)) : 0;
	const maxTokens = peakTokens || 1;

	return (
		<div className="mt-3 border rounded-lg p-3" style={{ borderColor: theme.colors.border }}>
			{/* View tabs */}
			<div className="flex gap-2 mb-3">
				{(['7d', '30d', 'monthly'] as const).map(v => (
					<button
						key={v}
						onClick={() => setView(v)}
						className={`text-xs px-2 py-1 rounded ${view === v ? 'font-bold' : ''}`}
						style={{
							backgroundColor: view === v ? theme.colors.accent + '20' : 'transparent',
							color: view === v ? theme.colors.accent : theme.colors.textDim,
						}}
					>
						{v === '7d' ? 'Last 7 Days' : v === '30d' ? '30 Days' : 'Monthly'}
					</button>
				))}
			</div>

			{/* Data rows */}
			{loading ? (
				<div className="text-xs py-4 text-center" style={{ color: theme.colors.textDim }}>Loading...</div>
			) : data.length === 0 ? (
				<div className="text-xs py-4 text-center" style={{ color: theme.colors.textDim }}>No usage data yet</div>
			) : (
				<div className="space-y-1">
					{data.map((row, i) => {
						const label = 'date' in row ? (row as AccountDailyUsage).date : (row as AccountMonthlyUsage).month;
						const barWidth = maxTokens > 0 ? (row.totalTokens / maxTokens) * 100 : 0;
						return (
							<div key={i} className="flex items-center gap-2 text-xs">
								<span className="w-16 tabular-nums" style={{ color: theme.colors.textDim }}>
									{formatDateLabel(label, view)}
								</span>
								<div
									className="flex-1 h-3 rounded-sm overflow-hidden"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									<div
										className="h-full rounded-sm"
										style={{
											width: `${barWidth}%`,
											backgroundColor: theme.colors.accent,
										}}
									/>
								</div>
								<span className="w-12 text-right tabular-nums" style={{ color: theme.colors.textMain }}>
									{formatTokenCount(row.totalTokens)}
								</span>
								<span className="w-14 text-right tabular-nums" style={{ color: theme.colors.textDim }}>
									${row.costUsd.toFixed(2)}
								</span>
								<span className="w-12 text-right tabular-nums" style={{ color: theme.colors.textDim }}>
									{row.queryCount} qry
								</span>
							</div>
						);
					})}
				</div>
			)}

			{/* Summary footer */}
			{data.length > 0 && (
				<div className="flex gap-4 mt-3 pt-2 border-t text-xs" style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}>
					<span>Avg: <span style={{ color: theme.colors.textMain }}>{formatTokenCount(Math.round(avgTokens))}/{view === 'monthly' ? 'mo' : 'day'}</span></span>
					<span>Peak: <span style={{ color: theme.colors.textMain }}>{formatTokenCount(peakTokens)}</span></span>
					<span>Throttles: <span style={{
						color: throttleCount > 0 ? theme.colors.error : theme.colors.textMain
					}}>{throttleCount}</span></span>
				</div>
			)}
		</div>
	);
}
