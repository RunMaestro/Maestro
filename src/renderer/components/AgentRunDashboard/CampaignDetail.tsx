import type { Campaign, CampaignTask } from '../../../shared/campaign';
import type { Theme } from '../../types';
import {
	campaignSourceLabel,
	formatTime,
	isPianolaCampaign,
	statusTone,
	summarize,
} from './dashboardHelpers';
import { Pill } from './dashboardPrimitives';

export function CampaignDetail({
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
