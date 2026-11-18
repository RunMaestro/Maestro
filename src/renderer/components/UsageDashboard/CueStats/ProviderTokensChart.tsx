import { memo, useMemo } from 'react';
import type { Theme } from '../../../types';
import type { CueStatsByGroup } from '../../../../shared/cue-stats-types';
import { formatTokensCompact } from '../../../../shared/formatters';
import { getSeriesColor } from '../chartUtils';
import { totalTokens } from './cueStatsUtils';

/**
 * Tokens per PROVIDER (Claude Code, Codex, ...). `cue_events` knows the agent
 * that ran each job only by id, and the aggregation keys this rollup by the
 * agent's provider type (labelled with its display name in main), so the
 * panel says provider, not agent.
 */
export const ProviderTokensChart = memo(function ProviderTokensChart({
	rows,
	theme,
	colorBlindMode,
}: {
	rows: CueStatsByGroup[];
	theme: Theme;
	colorBlindMode: boolean;
}) {
	const sorted = useMemo(
		() => [...rows].sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals)),
		[rows]
	);
	const max = Math.max(1, ...sorted.map((r) => totalTokens(r.totals)));

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-agent-chart"
			role="figure"
			aria-label="Total tokens by provider"
		>
			<h3 className="text-sm font-medium mb-3" style={{ color: theme.colors.textMain }}>
				Tokens by Provider
			</h3>
			{sorted.length === 0 ? (
				<div className="text-sm py-4" style={{ color: theme.colors.textDim }}>
					No provider data.
				</div>
			) : (
				<div className="space-y-2">
					{sorted.map((row, idx) => {
						const tokens = totalTokens(row.totals);
						return (
							<div key={row.key} className="flex items-center gap-3" style={{ height: 28 }}>
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
											width: `${(tokens / max) * 100}%`,
											backgroundColor: getSeriesColor(idx, theme, colorBlindMode),
										}}
									/>
								</div>
								<div
									className="text-xs font-mono"
									style={{ width: 64, textAlign: 'right', color: theme.colors.textMain }}
								>
									{formatTokensCompact(tokens)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
});
