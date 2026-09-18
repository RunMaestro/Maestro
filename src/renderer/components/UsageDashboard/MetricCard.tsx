/**
 * MetricCard - the labeled single-number tile used by the Usage Dashboard's
 * metric rows (Auto Run, Resilience, Wizard).
 *
 * Distinct from `EntityTile`, which is the richer grid card for an agent or a
 * group: this one is a single figure with an icon, a caption, and an optional
 * sub-line. It was copied verbatim into three sections before it lived here.
 *
 * Purely presentational - it takes formatted strings, not raw numbers.
 */

import React, { memo } from 'react';
import type { Theme } from '../../types';

export interface MetricCardProps {
	icon: React.ReactNode;
	label: string;
	/** Pre-formatted headline value. */
	value: string;
	/** Optional smaller line under the value. */
	subValue?: string;
	theme: Theme;
	/** Test hook for sections that assert on their own tiles. */
	testId?: string;
}

export const MetricCard = memo(function MetricCard({
	icon,
	label,
	value,
	subValue,
	theme,
	testId,
}: MetricCardProps) {
	return (
		<div
			className="p-4 rounded-lg flex items-start gap-3"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid={testId}
			role="group"
			aria-label={`${label}: ${value}${subValue ? `, ${subValue}` : ''}`}
		>
			<div
				className="flex-shrink-0 p-2 rounded-md"
				style={{
					backgroundColor: `${theme.colors.accent}15`,
					color: theme.colors.accent,
				}}
			>
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<div
					className="text-xs uppercase tracking-wide mb-1"
					style={{ color: theme.colors.textDim }}
				>
					{label}
				</div>
				<div
					className="text-2xl font-bold truncate"
					style={{ color: theme.colors.textMain }}
					title={value}
				>
					{value}
				</div>
				{subValue && (
					<div className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						{subValue}
					</div>
				)}
			</div>
		</div>
	);
});
