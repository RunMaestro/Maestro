import type { AgentRun, AgentRunStatus } from '../../../shared/agent-run';
import type { Campaign } from '../../../shared/campaign';
import type { Theme } from '../../types';

export type ViewMode = 'runs' | 'campaigns';

export type StatusFilter = 'all' | AgentRunStatus;

export type ProviderFilter = 'all' | string;

export const RUN_LIMIT = 200;
export const CAMPAIGN_LIMIT = 100;

export function formatTime(value?: number): string {
	if (!value) return 'unknown';
	return new Date(value).toLocaleString();
}

export function summarize(text?: string, fallback = 'No prompt recorded'): string {
	if (!text?.trim()) return fallback;
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return collapsed.length > 140 ? `${collapsed.slice(0, 137)}...` : collapsed;
}

export function metadataLabel(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (!value) return '';
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function campaignSourceLabel(campaign: Campaign): string {
	if (typeof campaign.source === 'string') return campaign.source;
	if (campaign.source && typeof campaign.source === 'object') {
		const adapter = campaign.source.adapter;
		if (typeof adapter === 'string') return adapter;
	}
	return campaign.id.startsWith('pianola:') ? 'pianola' : 'native';
}

export function isPianolaCampaign(campaign: Campaign): boolean {
	return campaign.id.startsWith('pianola:') || campaignSourceLabel(campaign) === 'pianola';
}

export function statusTone(status: string, theme: Theme): string {
	if (['completed', 'complete', 'passed', 'merged', 'done'].includes(status))
		return theme.colors.success;
	if (['failed', 'blocked', 'cancelled', 'discarded'].includes(status))
		return theme.colors.error ?? '#ef4444';
	if (['waiting', 'needs_review', 'queued', 'pending'].includes(status))
		return theme.colors.warning;
	return theme.colors.accent;
}

export function runSearchText(run: AgentRun): string {
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

export function campaignSearchText(campaign: Campaign): string {
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
