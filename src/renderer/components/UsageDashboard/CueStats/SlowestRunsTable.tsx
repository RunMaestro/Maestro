import { memo, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { TimerReset } from 'lucide-react';
import type { Theme } from '../../../types';
import type { CueSlowRun } from '../../../../shared/cue-stats-types';
import {
	formatDurationHuman,
	formatNumber,
	formatTokensCompact,
} from '../../../../shared/formatters';
import { getAgentDisplayName } from '../../../../shared/agentMetadata';
import { SortableTh } from '../../ui/SortableTh';
import { useTableSort } from '../../../hooks/ui/useTableSort';

/** Rows shown before "Show more". */
export const SLOWEST_RUNS_PAGE_SIZE = 10;

type SlowRunSortKey = 'subscription' | 'provider' | 'status' | 'started' | 'duration' | 'tokens';

const COLUMNS: Array<[SlowRunSortKey, string]> = [
	['subscription', 'Subscription'],
	['provider', 'Provider'],
	['status', 'Status'],
	['started', 'Started'],
	['duration', 'Duration'],
	['tokens', 'Tokens'],
];

const providerLabel = (run: CueSlowRun) =>
	run.agentType ? getAgentDisplayName(run.agentType) : '-';

function compareRuns(a: CueSlowRun, b: CueSlowRun, key: SlowRunSortKey): number {
	switch (key) {
		case 'subscription':
			return a.subscriptionName.localeCompare(b.subscriptionName);
		case 'provider':
			return providerLabel(a).localeCompare(providerLabel(b));
		case 'status':
			return a.status.localeCompare(b.status);
		case 'started':
			return a.startedAtMs - b.startedAtMs;
		case 'duration':
			return a.durationMs - b.durationMs;
		case 'tokens':
			return a.tokens - b.tokens;
	}
}

const defaultDirectionFor = (key: SlowRunSortKey) =>
	key === 'subscription' || key === 'provider' || key === 'status' ? 'asc' : 'desc';

/**
 * The slowest finished runs in the window (ranked in main, any terminal
 * status). A run the engine-start sweep settled after a crash is not listed:
 * its span is downtime, not run time.
 */
export const SlowestRunsTable = memo(function SlowestRunsTable({
	runs,
	theme,
}: {
	runs: CueSlowRun[];
	theme: Theme;
}) {
	const { sortKey, direction, isDescending, toggleSort } = useTableSort<SlowRunSortKey>(
		'duration',
		{ defaultDirectionFor }
	);
	const [visible, setVisible] = useState(SLOWEST_RUNS_PAGE_SIZE);
	const sorted = useMemo(() => {
		const copy = [...runs];
		copy.sort((a, b) => {
			const diff = compareRuns(a, b, sortKey);
			if (diff !== 0) return isDescending ? -diff : diff;
			return b.durationMs - a.durationMs;
		});
		return copy;
	}, [runs, sortKey, isDescending]);
	const rows = sorted.slice(0, visible);
	const hidden = sorted.length - rows.length;

	const headerClass =
		'text-left text-xs font-medium uppercase tracking-wider px-3 py-2 border-b select-none';
	const headerStyle = { color: theme.colors.textDim, borderColor: theme.colors.border };
	const statusColor = (status: string) =>
		status === 'completed' ? theme.colors.success : theme.colors.error;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-slowest-runs"
			role="region"
			aria-label="Slowest Cue runs in the selected range"
		>
			<div className="flex items-center gap-2 mb-3">
				<TimerReset className="w-4 h-4" style={{ color: theme.colors.accent }} />
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Slowest Runs
				</h3>
			</div>

			{runs.length === 0 ? (
				<div className="text-sm py-2" style={{ color: theme.colors.textDim }}>
					No finished runs in this range.
				</div>
			) : (
				<>
					<div className="overflow-x-auto">
						<table
							className="w-full text-sm"
							style={{ borderCollapse: 'separate', borderSpacing: 0 }}
						>
							<thead>
								<tr>
									{COLUMNS.map(([key, label]) => (
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
											testId={`cue-stats-slow-sort-${key}`}
										/>
									))}
								</tr>
							</thead>
							<tbody>
								{rows.map((run, idx) => (
									<tr
										key={run.eventId}
										data-testid="cue-stats-slow-run"
										style={{
											backgroundColor: idx % 2 === 0 ? 'transparent' : `${theme.colors.border}10`,
										}}
									>
										<td className="px-3 py-2" style={{ color: theme.colors.textMain }}>
											{run.subscriptionName}
										</td>
										<td className="px-3 py-2" style={{ color: theme.colors.textDim }}>
											{providerLabel(run)}
										</td>
										<td className="px-3 py-2 text-xs" style={{ color: statusColor(run.status) }}>
											{run.status}
										</td>
										<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
											{format(new Date(run.startedAtMs), 'MMM d HH:mm')}
										</td>
										<td
											className="px-3 py-2 font-mono font-semibold"
											style={{ color: theme.colors.textMain }}
										>
											{formatDurationHuman(run.durationMs)}
										</td>
										<td className="px-3 py-2 font-mono" style={{ color: theme.colors.textDim }}>
											{formatTokensCompact(run.tokens)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{hidden > 0 && (
						<div className="flex justify-center mt-3">
							<button
								type="button"
								onClick={() => setVisible((n) => n + SLOWEST_RUNS_PAGE_SIZE)}
								className="px-3 py-1 rounded text-xs border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								data-testid="cue-stats-slow-show-more"
							>
								Show {formatNumber(Math.min(hidden, SLOWEST_RUNS_PAGE_SIZE))} more (
								{formatNumber(hidden)} hidden)
							</button>
						</div>
					)}
				</>
			)}
		</div>
	);
});
