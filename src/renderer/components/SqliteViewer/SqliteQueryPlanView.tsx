/**
 * SqliteQueryPlanView - Query mode's result when the Plan toggle is on: the
 * statement's `EXPLAIN QUERY PLAN` as the tree the `sqlite3` shell draws.
 *
 * The steps come from `sqliteQueryPlanSteps()` (src/shared/sqlite/plan.ts),
 * which `maestro-cli sqlite query --plan` prints too, so the panel and the
 * CLI draw the same tree. Each step is colored by what it costs: a full
 * SCAN and a temporary sort in the warning color, an index SEARCH in the
 * success color, structure (subqueries, CTEs) plain. Hovering a step says
 * what its kind means, and a legend under the tree explains the kinds it holds.
 */

import { memo } from 'react';

import {
	SQLITE_QUERY_PLAN_KIND_HINTS,
	type SqliteQueryPlanStep,
	type SqliteQueryPlanStepKind,
} from '../../../shared/sqlite/plan';
import type { Theme } from '../../types';

interface SqliteQueryPlanViewProps {
	steps: readonly SqliteQueryPlanStep[];
	theme: Theme;
}

/** Kinds the legend explains, in the order it lists them. */
const LEGEND_KINDS: readonly SqliteQueryPlanStepKind[] = ['scan', 'sort', 'search'];

function kindColor(kind: SqliteQueryPlanStepKind, theme: Theme): string {
	if (kind === 'scan' || kind === 'sort') return theme.colors.warning;
	if (kind === 'search') return theme.colors.success;
	return theme.colors.textMain;
}

export const SqliteQueryPlanView = memo(function SqliteQueryPlanView({
	steps,
	theme,
}: SqliteQueryPlanViewProps) {
	if (steps.length === 0) {
		return (
			<div
				className="flex items-center justify-center h-full text-sm select-none"
				style={{ color: theme.colors.textDim }}
				data-testid="sqlite-query-plan-empty"
			>
				SQLite reports no plan steps for this statement.
			</div>
		);
	}
	const legend = LEGEND_KINDS.filter((kind) => steps.some((step) => step.kind === kind));
	return (
		<div className="h-full overflow-auto px-4 py-3 select-text" data-testid="sqlite-query-plan">
			<div className="font-mono text-xs leading-5" role="tree" aria-label="Query plan">
				<div style={{ color: theme.colors.textDim }}>QUERY PLAN</div>
				{steps.map((step, index) => (
					<div
						key={`${step.id}-${index}`}
						className="whitespace-pre"
						role="treeitem"
						aria-level={step.depth + 1}
						title={SQLITE_QUERY_PLAN_KIND_HINTS[step.kind]}
						data-testid="sqlite-query-plan-step"
						data-kind={step.kind}
					>
						<span style={{ color: theme.colors.textDim }}>{step.prefix}</span>
						<span style={{ color: kindColor(step.kind, theme) }}>{step.detail}</span>
					</div>
				))}
			</div>
			{legend.length > 0 && (
				<ul
					className="mt-4 flex flex-col gap-1 text-xs select-none"
					style={{ color: theme.colors.textDim }}
					data-testid="sqlite-query-plan-legend"
				>
					{legend.map((kind) => (
						<li key={kind} className="flex gap-2">
							<span
								className="shrink-0 w-2 h-2 mt-1 rounded-full"
								style={{ backgroundColor: kindColor(kind, theme) }}
								aria-hidden
							/>
							{SQLITE_QUERY_PLAN_KIND_HINTS[kind]}
						</li>
					))}
				</ul>
			)}
		</div>
	);
});
