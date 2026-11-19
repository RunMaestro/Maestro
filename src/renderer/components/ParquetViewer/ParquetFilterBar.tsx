/**
 * ParquetFilterBar - the Parquet viewer's filter box.
 *
 * The input, completion, problem underline, and syntax popover are the shared
 * `<FilterExpressionBar>` (the SQLite table view uses it too). What is Parquet's
 * own is here: the examples (relative time works because columns carry real
 * types), the column type labels, and the pushdown readout - the number that
 * explains why a filter over a multi-GB file came back instantly.
 */

import { forwardRef, useMemo } from 'react';
import { Zap } from 'lucide-react';

import type {
	ParquetColumnInfo,
	ParquetFilterProblem,
	ParquetScanStats,
} from '../../../shared/parquet/types';
import type { Theme } from '../../types';
import { formatCount, formatSize } from '../../../shared/formatters';
import {
	FilterExpressionBar,
	type FilterExpressionBarHandle,
	type FilterExpressionExample,
} from '../ui/FilterExpressionBar';

/** Examples shown in the help popover, in ascending order of sophistication. */
const SYNTAX_EXAMPLES: readonly FilterExpressionExample[] = [
	{ expression: 'acme', description: 'any column contains "acme"' },
	{ expression: 'status = active', description: 'exact match' },
	{ expression: 'price > 100 and qty <= 5', description: 'combine with and / or / not' },
	{ expression: 'region in (us, eu)', description: 'set membership' },
	{ expression: 'id between 100 and 200', description: 'inclusive range' },
	{ expression: 'ts >= now-7d', description: 'relative time (s, m, h, d, w)' },
	{ expression: 'ts >= 2024-01-15 10:30', description: 'absolute date or datetime' },
	{ expression: 'name ~ smith', description: 'contains (case-insensitive)' },
	{ expression: 'name ~ /^acme-\\d+$/', description: 'regular expression' },
	{ expression: 'path ^= /var/log', description: 'starts with ( $= ends with )' },
	{ expression: 'notes is null', description: 'null tests' },
	{ expression: '[order id] = 42', description: 'bracket names with spaces' },
];

const FOOTNOTE = (
	<>
		Terms sitting next to each other are combined with <code>and</code>. Comparisons use the
		column&apos;s real type, so <code>ts &gt; now-1h</code> compares instants and{' '}
		<code>price &gt; 9.99</code> compares numbers.
	</>
);

/** Imperative handle so the file preview can route Cmd+F here. */
export type ParquetFilterBarHandle = FilterExpressionBarHandle;

interface ParquetFilterBarProps {
	value: string;
	onChange: (value: string) => void;
	columns: ParquetColumnInfo[];
	problem?: ParquetFilterProblem;
	stats?: ParquetScanStats;
	/** True while a scan is running, for the busy affordance. */
	busy: boolean;
	theme: Theme;
}

export const ParquetFilterBar = forwardRef<ParquetFilterBarHandle, ParquetFilterBarProps>(
	function ParquetFilterBar({ value, onChange, columns, problem, stats, busy, theme }, ref) {
		const completions = useMemo(
			() =>
				columns.map((column) => ({
					name: column.name,
					detail: column.logicalType ?? column.physicalType ?? column.kind,
				})),
			[columns]
		);

		const pruned = stats ? stats.rowGroupsPruned : 0;
		const prunedShare = stats && stats.rowGroupsTotal > 0 ? pruned / stats.rowGroupsTotal : 0;

		return (
			<FilterExpressionBar
				ref={ref}
				value={value}
				onChange={onChange}
				columns={completions}
				problem={problem}
				busy={busy}
				busyLabel="scanning…"
				placeholder="Filter rows: try  status = active and price > 100"
				examples={SYNTAX_EXAMPLES}
				footnote={FOOTNOTE}
				testIdPrefix="parquet"
				theme={theme}
			>
				{/* Pushdown readout: why a filter over a multi-GB file came back instantly. */}
				{stats && (
					<div
						className="px-3 pb-2 flex items-center gap-3 text-xs-plus flex-wrap"
						style={{ color: theme.colors.textDim }}
						data-testid="parquet-pushdown-stats"
					>
						{pruned > 0 && (
							<span className="flex items-center gap-1" style={{ color: theme.colors.success }}>
								<Zap className="w-3 h-3" />
								skipped {formatCount(pruned)} of {formatCount(stats.rowGroupsTotal)} row groups
								{prunedShare > 0 ? ` (${Math.round(prunedShare * 100)}%)` : ''}
							</span>
						)}
						<span>read {formatSize(stats.bytesRead)}</span>
						<span>{formatCount(stats.rowsExamined)} rows examined</span>
						<span title="The predicate was fully expressible as parquet-level pruning, so no row-by-row pass was needed to prove it.">
							{stats.fullyPushedDown ? 'fully pushed down' : 'partial pushdown'}
						</span>
					</div>
				)}
			</FilterExpressionBar>
		);
	}
);
