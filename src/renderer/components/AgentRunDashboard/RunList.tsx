import { GitBranch } from 'lucide-react';
import type { AgentRun } from '../../../shared/agent-run';
import type { Theme } from '../../types';
import { formatTime, statusTone, summarize } from './dashboardHelpers';
import { Pill } from './dashboardPrimitives';

export function RunList({
	theme,
	runs,
	onSelectRun,
}: {
	theme: Theme;
	runs: AgentRun[];
	onSelectRun: (runId: string) => void;
}) {
	return (
		<>
			<div
				className="border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				Runs
			</div>
			{runs.length === 0 ? (
				<div className="p-5 text-sm" style={{ color: theme.colors.textDim }}>
					No agent runs yet.
				</div>
			) : (
				runs.map((run) => (
					<button
						key={run.id}
						type="button"
						onClick={() => onSelectRun(run.id)}
						className="block w-full border-b p-4 text-left transition-colors hover:bg-white/5"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="flex items-center justify-between gap-2">
							<span className="text-sm font-semibold">{run.agentName ?? run.provider}</span>
							<Pill theme={theme} tone={statusTone(run.status, theme)}>
								{run.status}
							</Pill>
						</div>
						<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
							{run.provider}
							{run.model ? ` · ${run.model}` : ''}
						</p>
						<p className="mt-2 text-sm">{summarize(run.prompt, run.id)}</p>
						<p
							className="mt-2 flex items-center gap-1 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							<GitBranch className="h-3 w-3" />
							{run.branch ?? run.repo ?? run.cwd ?? 'no branch context'} ·{' '}
							{formatTime(run.updatedAt)}
						</p>
					</button>
				))
			)}
		</>
	);
}
