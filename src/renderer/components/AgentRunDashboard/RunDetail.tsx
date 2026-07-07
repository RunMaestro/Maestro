import type { AgentRun, AgentRunEvent } from '../../../shared/agent-run';
import type { Theme } from '../../types';
import { formatTime, statusTone, summarize } from './dashboardHelpers';
import { DetailBox, DetailLine, JsonBox, Pill } from './dashboardPrimitives';
import { EventTimeline } from './EventTimeline';
import { openInSystemBrowser } from '../../utils/openUrl';

export function RunDetail({
	theme,
	run,
	events,
	onRefreshEvents,
	onNavigateToSession,
	onCancel,
	onRetry,
	onMerge,
	onResolveFinding,
}: {
	theme: Theme;
	run: AgentRun | null;
	events: AgentRunEvent[];
	onRefreshEvents: () => void;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
	onCancel?: (runId: string) => void;
	onRetry?: (runId: string) => void;
	onMerge?: (runId: string) => void;
	onResolveFinding?: (runId: string, findingIndex: number, status: 'fixed' | 'dismissed') => void;
}) {
	if (!run) {
		return (
			<div
				className="flex h-full items-center justify-center rounded-xl border p-8 text-center text-sm"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				Select a run to inspect its files, checks, review findings, and timeline.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<section className="rounded-xl border p-4" style={{ borderColor: theme.colors.border }}>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h3 className="text-base font-semibold">{run.agentName ?? run.id}</h3>
						<p className="mt-1 text-sm" style={{ color: theme.colors.textDim }}>
							{summarize(run.prompt)}
						</p>
					</div>
					<Pill theme={theme} tone={statusTone(run.status, theme)}>
						{run.status}
					</Pill>
					{run.sessionId && onNavigateToSession && (
						<button
							type="button"
							onClick={() => onNavigateToSession(run.sessionId!, run.tabId)}
							className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-white/5"
							style={{ borderColor: theme.colors.border, color: theme.colors.accent }}
						>
							Jump to session{run.tabId ? '/tab' : ''}
						</button>
					)}
				</div>
				<div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
					<DetailLine label="run id" value={run.id} />
					<DetailLine label="provider" value={run.provider} />
					<DetailLine label="model" value={run.model} />
					<DetailLine label="session" value={run.sessionId} />
					<DetailLine label="tab" value={run.tabId} />
					<DetailLine label="branch" value={run.branch} />
					<DetailLine label="repo" value={run.repo} />
					<DetailLine label="cwd" value={run.cwd} />
					<DetailLine label="worktree" value={run.worktreePath} />
					<DetailLine label="source" value={run.source} />
					<DetailLine label="next action" value={run.nextAction} />
					<DetailLine label="updated" value={formatTime(run.updatedAt)} />
				</div>
			</section>

			<section
				className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
					Actions
				</span>
				{onCancel && (
					<ActionButton
						theme={theme}
						label="Cancel"
						disabled={run.status !== 'running'}
						onClick={() => onCancel(run.id)}
					/>
				)}
				{onRetry && (
					<ActionButton
						theme={theme}
						label="Retry"
						disabled={run.status !== 'failed'}
						onClick={() => onRetry(run.id)}
					/>
				)}
				{onMerge && (
					<ActionButton
						theme={theme}
						label="Trigger merge"
						disabled={run.status !== 'completed' && run.status !== 'needs_review'}
						onClick={() => onMerge(run.id)}
					/>
				)}
				<ActionButton
					theme={theme}
					label="Open PR"
					disabled={!run.pullRequest?.url}
					onClick={() => run.pullRequest?.url && openInSystemBrowser(run.pullRequest.url)}
				/>
			</section>

			<section className="grid gap-3 md:grid-cols-2">
				<DetailBox
					theme={theme}
					title="Touched files"
					values={run.touchedFiles}
					empty="No touched files recorded."
				/>
				<DetailBox
					theme={theme}
					title="Artifacts"
					values={run.artifacts.map(
						(artifact) =>
							artifact.name ??
							artifact.path ??
							artifact.url ??
							artifact.kind ??
							JSON.stringify(artifact)
					)}
					empty="No artifacts recorded."
				/>
				<DetailBox
					theme={theme}
					title="Checks"
					values={run.checks.map(
						(check) => `${check.status}: ${check.name}${check.summary ? ` — ${check.summary}` : ''}`
					)}
					empty="No checks recorded."
				/>
				<ReviewFindings theme={theme} run={run} onResolveFinding={onResolveFinding} />
			</section>

			<section className="grid gap-3 md:grid-cols-2">
				<JsonBox theme={theme} title="Pull request" value={run.pullRequest} />
				<JsonBox theme={theme} title="Merge outcome" value={run.merge} />
				<JsonBox theme={theme} title="Usage" value={run.usage} />
				<JsonBox theme={theme} title="Metadata" value={run.metadata} />
			</section>

			<EventTimeline theme={theme} events={events} onRefresh={onRefreshEvents} />
		</div>
	);
}

function ActionButton({
	theme,
	label,
	disabled,
	onClick,
}: {
	theme: Theme;
	label: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors enabled:hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
			style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
		>
			{label}
		</button>
	);
}

function ReviewFindings({
	theme,
	run,
	onResolveFinding,
}: {
	theme: Theme;
	run: AgentRun;
	onResolveFinding?: (runId: string, findingIndex: number, status: 'fixed' | 'dismissed') => void;
}) {
	return (
		<div className="rounded-xl border p-3" style={{ borderColor: theme.colors.border }}>
			<h4
				className="text-xs font-semibold uppercase tracking-wide"
				style={{ color: theme.colors.textDim }}
			>
				Reviews
			</h4>
			{run.reviews.length === 0 ? (
				<p className="mt-2 text-sm" style={{ color: theme.colors.textDim }}>
					No review findings recorded.
				</p>
			) : (
				<ul className="mt-2 space-y-2">
					{run.reviews.map((finding, index) => (
						<li
							key={`${finding.category}-${index}`}
							className="rounded-md border p-2 text-sm"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span>
									[{finding.severity}] {finding.message}
								</span>
								<Pill theme={theme} tone={statusTone(finding.status, theme)}>
									{finding.status}
								</Pill>
							</div>
							{onResolveFinding && finding.status === 'open' && (
								<div className="mt-2 flex gap-2">
									<ActionButton
										theme={theme}
										label="Mark fixed"
										onClick={() => onResolveFinding(run.id, index, 'fixed')}
									/>
									<ActionButton
										theme={theme}
										label="Dismiss"
										onClick={() => onResolveFinding(run.id, index, 'dismissed')}
									/>
								</div>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
