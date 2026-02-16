/**
 * AccountRateMetrics - Compact panel showing token consumption rates
 * at three time scales with period-over-period deltas and trend indicator.
 */

import React from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { Theme } from '../../types';
import type { RateMetrics } from '../../hooks/useAccountUsage';
import { formatTokenCount } from '../../hooks/useAccountUsage';

interface AccountRateMetricsProps {
	rateMetrics: RateMetrics;
	theme: Theme;
}

function formatDelta(delta: number, theme: Theme): { text: string; color: string } {
	if (delta === 0 || isNaN(delta)) {
		return { text: '\u2014', color: theme.colors.textDim };
	}
	const capped = Math.max(-999, Math.min(999, delta));
	if (capped > 0) {
		return { text: `+${capped.toFixed(0)}%`, color: theme.colors.error };
	}
	return { text: `${capped.toFixed(0)}%`, color: theme.colors.success };
}

export function AccountRateMetrics({ rateMetrics, theme }: AccountRateMetricsProps) {
	const trendConfig = {
		up: { Icon: TrendingUp, label: 'Trending up', color: theme.colors.warning },
		stable: { Icon: Minus, label: 'Stable', color: theme.colors.textDim },
		down: { Icon: TrendingDown, label: 'Trending down', color: theme.colors.success },
	};

	const { Icon: TrendIcon, label: trendLabel, color: trendColor } = trendConfig[rateMetrics.trend];
	const dailyDelta = formatDelta(rateMetrics.dailyDelta, theme);
	const weeklyDelta = formatDelta(rateMetrics.weeklyDelta, theme);

	return (
		<div>
			{/* Row 1: Rate metrics grid */}
			<div className="grid grid-cols-3 gap-3 text-xs">
				<div>
					<div style={{ color: theme.colors.textDim }}>Tokens/hr</div>
					<div className="flex items-center gap-1.5">
						<span className="font-bold" style={{ color: theme.colors.textMain }}>
							{formatTokenCount(Math.round(rateMetrics.tokensPerHour))}
						</span>
					</div>
				</div>
				<div>
					<div style={{ color: theme.colors.textDim }}>Tokens/day</div>
					<div className="flex items-center gap-1.5">
						<span className="font-bold" style={{ color: theme.colors.textMain }}>
							{formatTokenCount(Math.round(rateMetrics.tokensPerDay))}
						</span>
						<span
							className="text-[10px] px-1 py-0.5 rounded"
							style={{ backgroundColor: dailyDelta.color + '15', color: dailyDelta.color }}
						>
							{dailyDelta.text}
						</span>
					</div>
				</div>
				<div>
					<div style={{ color: theme.colors.textDim }}>Tokens/wk</div>
					<div className="flex items-center gap-1.5">
						<span className="font-bold" style={{ color: theme.colors.textMain }}>
							{formatTokenCount(Math.round(rateMetrics.tokensPerWeek))}
						</span>
						<span
							className="text-[10px] px-1 py-0.5 rounded"
							style={{ backgroundColor: weeklyDelta.color + '15', color: weeklyDelta.color }}
						>
							{weeklyDelta.text}
						</span>
					</div>
				</div>
			</div>

			{/* Row 2: Trend indicator */}
			<div className="flex items-center gap-1.5 mt-2 text-[11px]">
				<TrendIcon className="w-3 h-3" style={{ color: trendColor }} />
				<span style={{ color: trendColor }}>{trendLabel}</span>
			</div>
		</div>
	);
}
