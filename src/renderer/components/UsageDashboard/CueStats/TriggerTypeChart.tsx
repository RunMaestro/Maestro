import { memo, useMemo } from 'react';
import type { Theme } from '../../../types';
import type { CueStatsByGroup } from '../../../../shared/cue-stats-types';
import { formatNumber } from '../../../../shared/formatters';
import { getSeriesColor } from '../chartUtils';

/**
 * Horizontal bar chart of runs by trigger type. Tells the user how Cue is
 * actually being used (file watches vs scheduled vs PR polls etc).
 */
export const TriggerTypeChart = memo(function TriggerTypeChart({
	rows,
	theme,
	colorBlindMode,
}: {
	rows: CueStatsByGroup[];
	theme: Theme;
	colorBlindMode: boolean;
}) {
	const sorted = useMemo(
		() => [...rows].sort((a, b) => b.totals.occurrences - a.totals.occurrences),
		[rows]
	);
	const total = sorted.reduce((sum, r) => sum + r.totals.occurrences, 0);
	const max = Math.max(1, ...sorted.map((r) => r.totals.occurrences));

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-trigger-types"
			role="figure"
			aria-label="Runs by Cue trigger type"
		>
			<h3 className="text-sm font-medium mb-3" style={{ color: theme.colors.textMain }}>
				By Trigger Type
			</h3>
			{sorted.length === 0 ? (
				<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
					No trigger data in this range.
				</div>
			) : (
				<div className="space-y-2">
					{sorted.map((row, idx) => {
						const runs = row.totals.occurrences;
						const sharePct = total > 0 ? Math.round((runs / total) * 100) : 0;
						return (
							<div
								key={row.key}
								className="flex items-center gap-3"
								style={{ height: 28 }}
								data-testid="cue-stats-trigger-row"
							>
								<div
									className="text-xs truncate"
									style={{ width: 140, color: theme.colors.textDim }}
									title={row.label}
								>
									{row.label}
								</div>
								<div className="flex-1 relative" style={{ height: 20 }}>
									<div
										className="absolute inset-y-0 left-0 rounded"
										style={{
											width: `${(runs / max) * 100}%`,
											backgroundColor: getSeriesColor(idx, theme, colorBlindMode),
										}}
									/>
								</div>
								<div
									className="text-xs font-mono"
									style={{ width: 80, textAlign: 'right', color: theme.colors.textMain }}
								>
									{formatNumber(runs)}
									<span className="ml-1" style={{ color: theme.colors.textDim }}>
										({sharePct}%)
									</span>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});
