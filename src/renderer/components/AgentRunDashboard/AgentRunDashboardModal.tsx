import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ListChecks, RefreshCw, Search, X } from 'lucide-react';
import { AGENT_RUN_STATUSES, KNOWN_AGENT_RUN_PROVIDERS } from '../../../shared/agent-run';
import type { CampaignTask } from '../../../shared/campaign';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useAgentRun } from '../../hooks/agentRun/useAgentRun';
import {
	CAMPAIGN_LIMIT,
	RUN_LIMIT,
	campaignSearchText,
	runSearchText,
	type ProviderFilter,
	type StatusFilter,
	type ViewMode,
} from './dashboardHelpers';
import { ToolbarButton } from './dashboardPrimitives';
import { RunDetail } from './RunDetail';
import { CampaignDetail } from './CampaignDetail';
import { RunList } from './RunList';
import { CampaignList } from './CampaignList';

interface AgentRunDashboardModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
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
		cancelRun,
		retryRun,
		resolveFinding,
		mergeRun,
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
						<RunList theme={theme} runs={filteredRuns} onSelectRun={(id) => void selectRun(id)} />
						<CampaignList
							theme={theme}
							campaigns={filteredCampaigns}
							onSelectCampaign={(id) => void selectCampaign(id)}
						/>
					</aside>

					<section className="min-h-0 overflow-y-auto p-5">
						{viewMode === 'runs' ? (
							<RunDetail
								theme={theme}
								run={selectedRun}
								events={selectedRunEvents}
								onRefreshEvents={() => selectedRun && void loadRunEvents(selectedRun.id)}
								onNavigateToSession={onNavigateToSession}
								onCancel={(runId) => void cancelRun(runId)}
								onRetry={(runId) => void retryRun(runId)}
								onMerge={(runId) => void mergeRun(runId)}
								onResolveFinding={(runId, findingIndex, status) =>
									void resolveFinding(runId, findingIndex, status)
								}
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
