import type { Campaign } from '../../../shared/campaign';
import type { Theme } from '../../types';
import { campaignSourceLabel, isPianolaCampaign, statusTone, summarize } from './dashboardHelpers';
import { Pill } from './dashboardPrimitives';

export function CampaignList({
	theme,
	campaigns,
	onSelectCampaign,
}: {
	theme: Theme;
	campaigns: Campaign[];
	onSelectCampaign: (campaignId: string) => void;
}) {
	return (
		<>
			<div
				className="border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em]"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				Campaigns
			</div>
			{campaigns.length === 0 ? (
				<div className="p-5 text-sm" style={{ color: theme.colors.textDim }}>
					No campaigns yet.
				</div>
			) : (
				campaigns.map((campaign) => (
					<button
						key={campaign.id}
						type="button"
						onClick={() => onSelectCampaign(campaign.id)}
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
						{campaign.objective && <p className="mt-1 text-sm">{summarize(campaign.objective)}</p>}
					</button>
				))
			)}
		</>
	);
}
