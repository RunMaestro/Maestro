import { memo, useEffect, useState, useCallback } from 'react';
import type { Theme } from '../../types';

interface UsagePeriod {
	utilization: number;
	resets_at: string;
}

interface ClaudeUsage {
	five_hour?: UsagePeriod | null;
	seven_day?: UsagePeriod | null;
	extra_usage?: {
		is_enabled: boolean;
		monthly_limit: number;
		used_credits: number;
		utilization: number;
	} | null;
}

interface ClaudeUsageWidgetProps {
	theme: Theme;
}

/** Returns remaining time as a human-readable string, e.g. "4h 12m" */
function formatTimeUntil(isoString: string): string {
	const now = Date.now();
	const target = new Date(isoString).getTime();
	const diffMs = target - now;
	if (diffMs <= 0) return 'resetting...';
	const totalMin = Math.floor(diffMs / 60000);
	const hours = Math.floor(totalMin / 60);
	const mins = totalMin % 60;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

/** Returns a Tailwind-compatible color based on utilization percentage */
function utilizationColor(pct: number): string {
	if (pct >= 80) return '#ef4444'; // red-500
	if (pct >= 50) return '#f59e0b'; // amber-500
	return '#22c55e'; // green-500
}

interface UsageBarProps {
	label: string;
	sublabel: string;
	utilization: number;
	theme: Theme;
}

function UsageBar({ label, sublabel, utilization, theme }: UsageBarProps) {
	const pct = Math.min(100, Math.max(0, utilization));
	const color = utilizationColor(pct);

	return (
		<div className="flex flex-col gap-0.5">
			<div className="flex items-center justify-between">
				<span className="text-[10px] font-medium opacity-60" style={{ color: theme.colors.text }}>
					{label}
				</span>
				<span className="text-[10px] font-mono font-bold" style={{ color }}>
					{pct.toFixed(0)}%
				</span>
			</div>
			<div
				className="h-1 rounded-full overflow-hidden"
				style={{ backgroundColor: `${theme.colors.text}20` }}
			>
				<div
					className="h-full rounded-full transition-all duration-500"
					style={{ width: `${pct}%`, backgroundColor: color }}
				/>
			</div>
			<span className="text-[9px] opacity-40" style={{ color: theme.colors.text }}>
				{sublabel}
			</span>
		</div>
	);
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes, matching PAI cache TTL

export const ClaudeUsageWidget = memo(function ClaudeUsageWidget({
	theme,
}: ClaudeUsageWidgetProps) {
	const [usage, setUsage] = useState<ClaudeUsage | null>(null);
	const [error, setError] = useState(false);

	const fetchUsage = useCallback(async () => {
		try {
			const result = await window.maestro.usage.getClaudeUsage();
			if (result.success && result.data) {
				setUsage(result.data as ClaudeUsage);
				setError(false);
			} else {
				setError(true);
			}
		} catch {
			setError(true);
		}
	}, []);

	useEffect(() => {
		fetchUsage();
		const interval = setInterval(fetchUsage, POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [fetchUsage]);

	if (error || !usage) return null;

	const fiveHour = usage.five_hour;
	const sevenDay = usage.seven_day;

	if (!fiveHour && !sevenDay) return null;

	return (
		<div
			className="px-3 py-2 border-t flex flex-col gap-2"
			style={{ borderColor: theme.colors.border }}
			title="Claude usage limits — click Usage Dashboard (Alt+Meta+U) for full stats"
		>
			<div className="flex items-center justify-between mb-0.5">
				<span
					className="text-[9px] font-semibold uppercase tracking-wider opacity-40"
					style={{ color: theme.colors.text }}
				>
					Claude Usage
				</span>
				<button
					type="button"
					onClick={fetchUsage}
					className="text-[9px] opacity-30 hover:opacity-60 transition-opacity"
					style={{ color: theme.colors.text }}
					title="Refresh usage data"
				>
					↻
				</button>
			</div>

			{fiveHour && (
				<UsageBar
					label="5-Hour Session"
					sublabel={`resets in ${formatTimeUntil(fiveHour.resets_at)}`}
					utilization={fiveHour.utilization}
					theme={theme}
				/>
			)}

			{sevenDay && (
				<UsageBar
					label="7-Day Limit"
					sublabel={`resets in ${formatTimeUntil(sevenDay.resets_at)}`}
					utilization={sevenDay.utilization}
					theme={theme}
				/>
			)}
		</div>
	);
});
