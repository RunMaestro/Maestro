/**
 * StatCard
 *
 * Part of the shared output-widget library: theme-aware, presentational-only
 * (no IPC, no store reads), independent of any Encore flag. Renders a single
 * headline metric - a large value with a label, an optional inline sparkline
 * trend, an optional accent color, and an optional lucide icon. Data arrives
 * entirely through props; the card never fetches anything.
 */

import { memo } from 'react';
import { Sparkline } from './Sparkline';
import { formatNumber } from '../../../../shared/formatters';
import type { StatCardDatum, WidgetProps } from '../types';

type StatCardProps = WidgetProps & StatCardDatum;

export const StatCard = memo(function StatCard({
	theme,
	label,
	value,
	displayValue,
	trend,
	color,
	icon: Icon,
	caption,
}: StatCardProps) {
	const accent = color ?? theme.colors.accent;
	const hasTrend = Array.isArray(trend) && trend.length > 0;

	return (
		<div
			className="flex flex-col gap-1.5 p-3 rounded-lg border"
			style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-1.5" style={{ color: theme.colors.textDim }}>
				{Icon && <Icon className="w-3.5 h-3.5" style={{ color: accent }} aria-hidden="true" />}
				<span className="text-[11px] font-medium uppercase tracking-wide truncate">{label}</span>
			</div>
			<div className="flex items-end justify-between gap-2">
				<span className="text-2xl font-bold leading-none" style={{ color: theme.colors.textMain }}>
					{displayValue ?? formatNumber(value)}
				</span>
				{hasTrend && <Sparkline data={trend} color={accent} width={64} height={22} />}
			</div>
			{caption && (
				<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
					{caption}
				</span>
			)}
		</div>
	);
});

export default StatCard;
