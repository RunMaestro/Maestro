import { memo, useMemo } from 'react';
import type { Theme } from '../../../types';
import type { CueStatsByGroup } from '../../../../shared/cue-stats-types';
import {
	formatCost,
	formatDurationHuman,
	formatNumber,
	formatTokensCompact,
} from '../../../../shared/formatters';
import { SortableTh } from '../../ui/SortableTh';
import { useTableSort } from '../../../hooks/ui/useTableSort';
import { averageRunMs, formatPercent, successRate, totalTokens } from './cueStatsUtils';

type GroupSortKey = 'runs' | 'success' | 'avgDuration' | 'totalDuration' | 'tokens' | 'cost';

const COLUMNS: Array<[GroupSortKey, string]> = [
	['runs', 'Runs'],
	['success', 'Success Rate'],
	['avgDuration', 'Avg Run Time'],
	['totalDuration', 'Run Time'],
	['tokens', 'Total Tokens'],
	['cost', 'Total Cost'],
];

function sortValue(row: CueStatsByGroup, key: GroupSortKey): number {
	switch (key) {
		case 'runs':
			return row.totals.occurrences;
		case 'success':
			return successRate(row.totals);
		case 'avgDuration':
			return averageRunMs(row.totals);
		case 'totalDuration':
			return row.totals.totalDurationMs;
		case 'tokens':
			return totalTokens(row.totals);
		case 'cost':
			return row.totals.totalCostUsd ?? 0;
	}
}

/**
 * A sortable rollup table (by pipeline). Run time and its average cover
 * completed runs only; the average divides by those runs, not by every run.
 */
export const GroupTable = memo(function GroupTable({
	title,
	rows,
	theme,
	testId,
	keyLabel,
	hideTokenColumns = false,
}: {
	title: string;
	rows: CueStatsByGroup[];
	theme: Theme;
	testId: string;
	keyLabel: string;
	/** Drop the token and cost columns when the range has no token data. */
	hideTokenColumns?: boolean;
}) {
	// Every column is a magnitude, so switching columns starts descending
	// (biggest first); clicking the active column flips it.
	const { sortKey, direction, isDescending, toggleSort } = useTableSort<GroupSortKey>('runs', {
		defaultDirectionFor: () => 'desc',
	});

	const sorted = useMemo(() => {
		const copy = [...rows];
		copy.sort((a, b) => {
			const diff = sortValue(a, sortKey) - sortValue(b, sortKey);
			return isDescending ? -diff : diff;
		});
		return copy;
	}, [rows, sortKey, isDescending]);

	const headerClass =
		'text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b select-none';
	const headerStyle = { color: theme.colors.textDim, borderColor: theme.colors.border };
	const columns = COLUMNS.filter(
		([key]) => !hideTokenColumns || (key !== 'tokens' && key !== 'cost')
	);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid={testId}
			role="region"
			aria-label={title}
		>
			<h3 className="text-sm font-medium mb-3" style={{ color: theme.colors.textMain }}>
				{title}
			</h3>
			{rows.length === 0 ? (
				<div className="text-sm py-4" style={{ color: theme.colors.textDim }}>
					No data.
				</div>
			) : (
				<div className="overflow-x-auto">
					<table
						className="w-full text-sm"
						style={{ borderCollapse: 'separate', borderSpacing: 0 }}
					>
						<thead>
							<tr>
								<th className={headerClass} style={headerStyle}>
									{keyLabel}
								</th>
								{columns.map(([key, label]) => (
									<SortableTh
										key={key}
										columnKey={key}
										label={label}
										sortKey={sortKey}
										direction={direction}
										onSort={toggleSort}
										theme={theme}
										className={headerClass}
										style={headerStyle}
										title={`Sort by ${label}`}
									/>
								))}
							</tr>
						</thead>
						<tbody>
							{sorted.map((row, idx) => (
								<tr
									key={row.key}
									style={{
										backgroundColor: idx % 2 === 0 ? 'transparent' : `${theme.colors.border}10`,
									}}
								>
									<td className="px-3 py-2" style={{ color: theme.colors.textMain }}>
										{row.label}
									</td>
									<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textMain }}>
										{formatNumber(row.totals.occurrences)}
									</td>
									<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
										{formatPercent(successRate(row.totals))}
									</td>
									<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
										{row.totals.timedRunCount > 0
											? formatDurationHuman(averageRunMs(row.totals))
											: '-'}
									</td>
									<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
										{formatDurationHuman(row.totals.totalDurationMs)}
									</td>
									{!hideTokenColumns && (
										<>
											<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
												{formatTokensCompact(totalTokens(row.totals))}
											</td>
											<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
												{row.totals.totalCostUsd != null
													? formatCost(row.totals.totalCostUsd)
													: '-'}
											</td>
										</>
									)}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
});
