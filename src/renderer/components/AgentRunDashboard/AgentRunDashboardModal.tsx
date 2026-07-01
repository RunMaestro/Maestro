import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, GitBranch, ListChecks, RefreshCw, Search, X } from 'lucide-react';
import type { AgentRun, AgentRunEvent, AgentRunStatus } from '../../../shared/agent-run';
import { AGENT_RUN_STATUSES, KNOWN_AGENT_RUN_PROVIDERS } from '../../../shared/agent-run';
import type { Campaign, CampaignTask } from '../../../shared/campaign';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useAgentRun } from '../../hooks/agentRun/useAgentRun';

interface AgentRunDashboardModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
}

type ViewMode = 'runs' | 'campaigns';

type StatusFilter = 'all' | AgentRunStatus;

type ProviderFilter = 'all' | string;

const RUN_LIMIT = 200;
const CAMPAIGN_LIMIT = 100;

function formatTime(value?: number): string {
	if (!value) return 'unknown';
	return new Date(value).toLocaleString();
}

function summarize(text?: string, fallback = 'No prompt recorded'): string {
	if (!text?.trim()) return fallback;
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed.length > 140 ? `${collapsed.slice(0, 137)}...` : collapsed;
}

function metadataLabel(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (!value) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function campaignSourceLabel(campaign: Campaign): string {
	if (typeof campaign.source === 'string') return campaign.source;
	if (campaign.source && typeof campaign.source === 'object') {
		const adapter = campaign.source.adapter;
		if (typeof adapter === 'string') return adapter;
	}
	return campaign.id.startsWith('pianola:') ? 'pianola' : 'native';
}

function isPianolaCampaign(campaign: Campaign): boolean {
	return campaign.id.startsWith('pianola:') || campaignSourceLabel(campaign) === 'pianola';
}

function statusTone(status: string, theme: Theme): string {
	if (['completed', 'complete', 'passed', 'merged', 'done'].includes(status))
		return theme.colors.success;
	if (['failed', 'blocked', 'cancelled', 'discarded'].includes(status))
		return theme.colors.error ?? '#ef4444';
	if (['waiting', 'needs_review', 'queued', 'pending'].includes(status))
		return theme.colors.warning;
	return theme.colors.accent;
}

function runSearchText(run: AgentRun): string {
	return [
		run.id,
		run.provider,
		run.model,
		run.agentName,
		run.agentId,
		run.sessionId,
		run.tabId,
		run.cwd,
		run.repo,
		run.worktreePath,
		run.branch,
		run.baseBranch,
		run.prompt,
		run.source,
		run.nextAction,
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

function campaignSearchText(campaign: Campaign): string {
	return [
		campaign.id,
		campaign.title,
		campaign.objective,
		campaign.status,
		campaignSourceLabel(campaign),
		...campaign.tasks.flatMap((task) => [
			task.id,
			task.title,
			task.prompt,
			task.agentType,
			task.cwd,
			task.tabId,
		]),
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

function DetailLine({ label, value }: { label: string; value: unknown }) {
	const rendered = metadataLabel(value);
	if (!rendered) return null;
	return (
		<div className="min-w-0">
			<div className="text-[10px] uppercase tracking-[0.16em] opacity-60">{label}</div>
			<div className="text-xs break-words">{rendered}</div>
		</div>
	);
}

function Pill({ theme, children, tone }: { theme: Theme; children: ReactNode; tone?: string }) {
	return (
		<span
			className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium"
			style={{
				borderColor: tone ?? theme.colors.border,
				color: tone ?? theme.colors.textDim,
				backgroundColor: `${tone ?? theme.colors.border}18`,
			}}
		>
			{children}
		</span>
	);
}

function ToolbarButton({
	theme,
	active,
	children,
	onClick,
}: {
	theme: Theme;
	active?: boolean;
	children: ReactNode;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="rounded-md border px-2.5 py-1 text-xs transition-colors"
			style={{
				borderColor: active ? theme.colors.accent : theme.colors.border,
				backgroundColor: active ? `${theme.colors.accent}22` : 'transparent',
				color: active ? theme.colors.textMain : theme.colors.textDim,
			}}
		>
			{children}
		</button>
	);
}

function EventTimeline({
	theme,
	events,
	onRefresh,
}: {
	theme: Theme;
	events: AgentRunEvent[];
	onRefresh: () => void;
}) {
	return (
		<section className="rounded-xl border" style={{ borderColor: theme.colors.border }}>
			<div
				className="flex items-center justify-between border-b px-3 py-2"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2 text-sm font-semibold">
					<Activity className="h-4 w-4" />
					Event timeline
				</div>
				<button
					type="button"
					onClick={onRefresh}
					className="text-xs"
					style={{ color: theme.colors.accent }}
				>
					Reload events
				</button>
			</div>
			{events.length === 0 ? (
				<div className="px-3 py-6 text-sm" style={{ color: theme.colors.textDim }}>
					No events recorded yet.
				</div>
			) : (
				<div className="space-y-3 p-3">
					{events.map((event) => (
						<div
							key={event.id}
							className="border-l-2 pl-3"
							style={{ borderColor: statusTone(event.status ?? event.type, theme) }}
						>
							<div className="flex flex-wrap items-center gap-2 text-xs">
								<span className="font-semibold" style={{ color: theme.colors.textMain }}>
									{event.type}
								</span>
								{event.status && (
									<Pill theme={theme} tone={statusTone(event.status, theme)}>
										{event.status}
									</Pill>
								)}
								<span style={{ color: theme.colors.textDim }}>{formatTime(event.timestamp)}</span>
							</div>
							{event.message && <div className="mt-1 text-sm">{event.message}</div>}
							{(event.data || event.metadata) && (
								<pre
									className="mt-2 max-h-28 overflow-auto rounded p-2 text-[11px]"
									style={{ backgroundColor: theme.colors.bgSidebar, color: theme.colors.textDim }}
								>
									{JSON.stringify({ data: event.data, metadata: event.metadata }, null, 2)}
								</pre>
							)}
						</div>
					))}
				</div>
			)}
		</section>
	);
}

function RunDetail({
	theme,
	run,
	events,
	onRefreshEvents,
	onNavigateToSession,
}: {
	theme: Theme;
	run: AgentRun | null;
	events: AgentRunEvent[];
	onRefreshEvents: () => void;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
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
				<DetailBox
					theme={theme}
					title="Reviews"
					values={run.reviews.map((review) => review.message)}
					empty="No review findings recorded."
				/>
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

function DetailBox({
	theme,
	title,
	values,
	empty,
}: {
	theme: Theme;
	title: string;
	values: string[];
	empty: string;
}) {
	return (
		<div className="rounded-xl border p-3" style={{ borderColor: theme.colors.border }}>
			<h4 className="text-sm font-semibold">{title}</h4>
			{values.length === 0 ? (
				<p className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
					{empty}
				</p>
			) : (
				<ul className="mt-2 space-y-1 text-xs">
					{values.map((value, index) => (
						<li key={`${value}-${index}`} className="break-words">
							{value}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function JsonBox({ theme, title, value }: { theme: Theme; title: string; value: unknown }) {
	if (!value)
		return (
			<DetailBox
				theme={theme}
				title={title}
				values={[]}
				empty={`No ${title.toLowerCase()} recorded.`}
			/>
		);
	return (
		<div className="rounded-xl border p-3" style={{ borderColor: theme.colors.border }}>
			<h4 className="text-sm font-semibold">{title}</h4>
			<pre
				className="mt-2 max-h-44 overflow-auto rounded p-2 text-[11px]"
				style={{ backgroundColor: theme.colors.bgSidebar, color: theme.colors.textDim }}
			>
				{JSON.stringify(value, null, 2)}
			</pre>
		</div>
	);
}

function CampaignDetail({
	theme,
	campaign,
	onSelectTaskRun,
	missingRunMessage,
}: {
	theme: Theme;
	campaign: Campaign | null;
	onSelectTaskRun: (task: CampaignTask) => void;
	missingRunMessage: string | null;
}) {
	if (!campaign) {
		return (
			<div
				className="rounded-xl border p-4 text-sm"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				Select a campaign to inspect its tasks and linked runs.
			</div>
		);
	}

	return (
		<section className="rounded-xl border" style={{ borderColor: theme.colors.border }}>
			<div className="border-b p-4" style={{ borderColor: theme.colors.border }}>
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="text-base font-semibold">{campaign.title}</h3>
					<Pill theme={theme} tone={statusTone(campaign.status, theme)}>
						{campaign.status}
					</Pill>
					<Pill theme={theme}>{campaignSourceLabel(campaign)}</Pill>
					{isPianolaCampaign(campaign) && (
						<Pill theme={theme} tone={theme.colors.accent}>
							Pianola
						</Pill>
					)}
				</div>
				<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
					{campaign.id} · {campaign.runIds.length} runs · {campaign.tasks.length} tasks · updated{' '}
					{formatTime(campaign.updatedAt)}
				</p>
				{campaign.objective && <p className="mt-2 text-sm">{campaign.objective}</p>}
				{missingRunMessage && (
					<p
						className="mt-2 rounded-md border px-2 py-1 text-xs"
						style={{ borderColor: theme.colors.warning, color: theme.colors.warning }}
					>
						{missingRunMessage}
					</p>
				)}
			</div>
			<div className="divide-y" style={{ borderColor: theme.colors.border }}>
				{campaign.tasks.length === 0 ? (
					<div className="p-4 text-sm" style={{ color: theme.colors.textDim }}>
						No campaign tasks recorded.
					</div>
				) : (
					campaign.tasks.map((task) => (
						<button
							type="button"
							key={task.id}
							onClick={() => onSelectTaskRun(task)}
							className="block w-full p-3 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
							disabled={!task.runId}
						>
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-sm font-medium">{task.title}</span>
								<Pill theme={theme} tone={statusTone(task.status, theme)}>
									{task.status}
								</Pill>
								{task.runId && <Pill theme={theme}>run: {task.runId}</Pill>}
							</div>
							<p className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
								{task.dependsOn.length
									? `depends on ${task.dependsOn.join(', ')}`
									: 'no dependencies'}
								{task.agentType ? ` · ${task.agentType}` : ''}
								{task.tabId ? ` · tab ${task.tabId}` : ''}
							</p>
							{task.prompt && <p className="mt-1 text-xs">{summarize(task.prompt)}</p>}
							{task.error && (
								<p className="mt-1 text-xs" style={{ color: theme.colors.error ?? '#ef4444' }}>
									{task.error}
								</p>
							)}
						</button>
					))
				)}
			</div>
		</section>
	);
}

function AgentRunDashboardBody({
	theme,
	onClose,
	onNavigateToSession,
}: Omit<AgentRunDashboardModalProps, 'isOpen'>) {
	useModalLayer(MODAL_PRIORITIES.AGENT_RUN_DASHBOARD, 'AgentRun Dashboard', onClose);
	const [viewMode, setViewMode] = useState<ViewMode>('runs');
	const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
	const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all');
	const [campaignFilter, setCampaignFilter] = useState('all');
	const [search, setSearch] = useState('');
	const [missingRunMessage, setMissingRunMessage] = useState<string | null>(null);
	const {
		runs,
		campaigns,
		selectedRun,
		selectedRunEvents,
		selectedCampaign,
		loading,
		error,
		refreshRuns,
		refreshCampaigns,
		showRun,
		loadRunEvents,
		showCampaign,
	} = useAgentRun({ runs: { limit: RUN_LIMIT }, campaigns: { limit: CAMPAIGN_LIMIT } });

	const normalizedSearch = search.trim().toLowerCase();
	const providerOptions = useMemo(() => {
		const providers = new Set<string>(KNOWN_AGENT_RUN_PROVIDERS);
		for (const run of runs) providers.add(run.provider);
		return ['all', ...Array.from(providers).sort()] as const;
	}, [runs]);

	const filteredRuns = useMemo(() => {
		return runs.filter((run) => {
			if (statusFilter !== 'all' && run.status !== statusFilter) return false;
			if (providerFilter !== 'all' && run.provider !== providerFilter) return false;
			if (campaignFilter !== 'all') {
				const campaign = campaigns.find((entry) => entry.id === campaignFilter);
				const campaignRunIds = new Set([
					...(campaign?.runIds ?? []),
					...(campaign?.tasks.flatMap((task) => (task.runId ? [task.runId] : [])) ?? []),
				]);
				if (
					!campaignRunIds.has(run.id) &&
					run.source !== campaignFilter &&
					run.metadata?.campaignId !== campaignFilter
				)
					return false;
			}
			return !normalizedSearch || runSearchText(run).includes(normalizedSearch);
		});
	}, [campaignFilter, campaigns, normalizedSearch, providerFilter, runs, statusFilter]);

	const filteredCampaigns = useMemo(() => {
		return campaigns.filter((campaign) => {
			if (campaignFilter !== 'all' && campaign.id !== campaignFilter) return false;
			return !normalizedSearch || campaignSearchText(campaign).includes(normalizedSearch);
		});
	}, [campaignFilter, campaigns, normalizedSearch]);

	const refreshAll = useCallback(async () => {
		await Promise.all([
			refreshRuns({ limit: RUN_LIMIT }),
			refreshCampaigns({ limit: CAMPAIGN_LIMIT }),
			selectedRun ? showRun(selectedRun.id) : Promise.resolve(null),
			selectedRun ? loadRunEvents(selectedRun.id) : Promise.resolve([]),
			selectedCampaign ? showCampaign(selectedCampaign.id) : Promise.resolve(null),
		]);
	}, [
		loadRunEvents,
		refreshCampaigns,
		refreshRuns,
		selectedCampaign,
		selectedRun,
		showCampaign,
		showRun,
	]);

	const selectRun = useCallback(
		async (runId: string) => {
			setMissingRunMessage(null);
			await Promise.all([showRun(runId), loadRunEvents(runId)]);
			setViewMode('runs');
		},
		[loadRunEvents, showRun]
	);

	const selectCampaign = useCallback(
		async (campaignId: string) => {
			setMissingRunMessage(null);
			await showCampaign(campaignId);
			setViewMode('campaigns');
		},
		[showCampaign]
	);

	const selectTaskRun = useCallback(
		async (task: CampaignTask) => {
			if (!task.runId) return;
			const run = await showRun(task.runId);
			if (!run) {
				setMissingRunMessage(
					`Run record ${task.runId} is not recorded yet. The campaign task is still visible.`
				);
				return;
			}
			setMissingRunMessage(null);
			await loadRunEvents(task.runId);
			setViewMode('runs');
		},
		[loadRunEvents, showRun]
	);

	return createPortal(
		<div className="fixed inset-0 z-[542] flex items-center justify-center bg-black/60 p-4">
			<div
				className="flex h-[86vh] w-[min(1500px,96vw)] flex-col overflow-hidden rounded-2xl border shadow-2xl"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			>
				<header
					className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4"
					style={{ borderColor: theme.colors.border }}
				>
					<div>
						<div className="flex items-center gap-2">
							<ListChecks className="h-5 w-5" style={{ color: theme.colors.accent }} />
							<h2 className="text-lg font-semibold">AgentRun Dashboard</h2>
						</div>
						<p className="mt-1 text-sm" style={{ color: theme.colors.textDim }}>
							Neutral ledger for agent work, campaigns, reviews, files, and Pianola-linked tasks.
						</p>
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={refreshAll}
							className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							<RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
							Refresh
						</button>
						<button
							type="button"
							onClick={onClose}
							className="rounded-md p-2 hover:bg-white/5"
							aria-label="Close AgentRun dashboard"
						>
							<X className="h-5 w-5" />
						</button>
					</div>
				</header>

				<div className="border-b px-5 py-3" style={{ borderColor: theme.colors.border }}>
					<div className="flex flex-wrap items-center gap-2">
						<ToolbarButton
							theme={theme}
							active={viewMode === 'runs'}
							onClick={() => setViewMode('runs')}
						>
							Runs ({filteredRuns.length})
						</ToolbarButton>
						<ToolbarButton
							theme={theme}
							active={viewMode === 'campaigns'}
							onClick={() => setViewMode('campaigns')}
						>
							Campaigns ({filteredCampaigns.length})
						</ToolbarButton>
						<div
							className="ml-auto flex min-w-[260px] items-center gap-2 rounded-md border px-2 py-1"
							style={{ borderColor: theme.colors.border }}
						>
							<Search className="h-4 w-4" style={{ color: theme.colors.textDim }} />
							<input
								aria-label="Search AgentRun records"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								placeholder="Search prompt, agent, repo, branch"
								className="w-full bg-transparent text-sm outline-none"
								style={{ color: theme.colors.textMain }}
							/>
						</div>
					</div>
					<div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
						<select
							aria-label="Run status filter"
							value={statusFilter}
							onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
							className="rounded-md border bg-transparent px-2 py-1"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							<option value="all">all statuses</option>
							{AGENT_RUN_STATUSES.map((status) => (
								<option key={status} value={status}>
									status: {status}
								</option>
							))}
						</select>
						<select
							aria-label="Provider filter"
							value={providerFilter}
							onChange={(event) => setProviderFilter(event.target.value)}
							className="rounded-md border bg-transparent px-2 py-1"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							{providerOptions.map((provider) => (
								<option key={provider} value={provider}>
									{provider === 'all' ? 'all providers' : provider}
								</option>
							))}
						</select>
						<select
							aria-label="Campaign filter"
							value={campaignFilter}
							onChange={(event) => setCampaignFilter(event.target.value)}
							className="rounded-md border bg-transparent px-2 py-1"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							<option value="all">all campaigns</option>
							{campaigns.map((campaign) => (
								<option key={campaign.id} value={campaign.id}>
									{campaign.title} — {campaign.id}
								</option>
							))}
						</select>
						{error && (
							<span
								role="alert"
								className="rounded-md border px-2 py-1"
								style={{
									borderColor: theme.colors.error ?? '#ef4444',
									color: theme.colors.error ?? '#ef4444',
								}}
							>
								{error}
							</span>
						)}
					</div>
				</div>

				<main className="grid min-h-0 flex-1 grid-cols-[minmax(300px,390px)_1fr] gap-0 overflow-hidden">
					<aside
						className="min-h-0 overflow-y-auto border-r"
						style={{ borderColor: theme.colors.border }}
					>
						<div
							className="border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
							style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						>
							Runs
						</div>
						{filteredRuns.length === 0 ? (
							<div className="p-5 text-sm" style={{ color: theme.colors.textDim }}>
								No agent runs yet.
							</div>
						) : (
							filteredRuns.map((run) => (
								<button
									key={run.id}
									type="button"
									onClick={() => void selectRun(run.id)}
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
						<div
							className="border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
							style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						>
							Campaigns
						</div>
						{filteredCampaigns.length === 0 ? (
							<div className="p-5 text-sm" style={{ color: theme.colors.textDim }}>
								No campaigns yet.
							</div>
						) : (
							filteredCampaigns.map((campaign) => (
								<button
									key={campaign.id}
									type="button"
									onClick={() => void selectCampaign(campaign.id)}
									className="block w-full border-b p-4 text-left transition-colors hover:bg-white/5"
									style={{ borderColor: theme.colors.border }}
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-sm font-semibold">{campaign.title}</span>
										<Pill theme={theme} tone={statusTone(campaign.status, theme)}>
											{campaign.status}
										</Pill>
										{isPianolaCampaign(campaign) && (
											<Pill theme={theme} tone={theme.colors.accent}>
												Pianola
											</Pill>
										)}
									</div>
									<p className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
										{campaign.runIds.length} runs · {campaign.tasks.length} tasks ·{' '}
										{campaignSourceLabel(campaign)}
									</p>
									{campaign.objective && (
										<p className="mt-1 text-sm">{summarize(campaign.objective)}</p>
									)}
								</button>
							))
						)}
					</aside>

					<section className="min-h-0 overflow-y-auto p-5">
						{viewMode === 'runs' ? (
							<RunDetail
								theme={theme}
								run={selectedRun}
								events={selectedRunEvents}
								onRefreshEvents={() => selectedRun && void loadRunEvents(selectedRun.id)}
								onNavigateToSession={onNavigateToSession}
							/>
						) : (
							<CampaignDetail
								theme={theme}
								campaign={selectedCampaign}
								onSelectTaskRun={selectTaskRun}
								missingRunMessage={missingRunMessage}
							/>
						)}
					</section>
				</main>
			</div>
		</div>,
		document.body
	);
}

export function AgentRunDashboardModal({
	isOpen,
	onClose,
	theme,
	onNavigateToSession,
}: AgentRunDashboardModalProps) {
	if (!isOpen) return null;
	return (
		<AgentRunDashboardBody
			theme={theme}
			onClose={onClose}
			onNavigateToSession={onNavigateToSession}
		/>
	);
}

export type { AgentRunDashboardModalProps };
