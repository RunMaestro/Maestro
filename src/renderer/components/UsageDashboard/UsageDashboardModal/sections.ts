import type { UsageDashboardViewMode as ViewMode } from '../../../types';

export const OVERVIEW_SECTIONS = [
	'year-in-pixels',
	'summary-cards',
	'query-percentiles',
	'agent-comparison',
	'provider-trends',
	'source-distribution',
	'location-distribution',
	'radial-activity',
] as const;

export const AGENTS_SECTIONS = ['agent-overview-cards'] as const;
export const AGENT_OVERVIEW_SECTIONS = [
	'session-stats',
	'agent-efficiency',
	'agent-usage',
] as const;
export const AGENT_OVERVIEW_WITH_WORKTREE_SECTIONS = [
	'session-stats',
	'worktree-analytics',
	'agent-efficiency',
	'agent-usage',
] as const;
export const ACTIVITY_SECTIONS = [
	'activity-heatmap',
	'weekday-comparison',
	'duration-trends',
] as const;
export const AUTORUN_SECTIONS = [
	'autorun-stats',
	'autorun-task-percentiles',
	'tasks-by-hour',
	'longest-autoruns',
] as const;
export const ANTHROPIC_USAGE_SECTIONS = ['anthropic-usage'] as const;
export const CODEX_USAGE_SECTIONS = ['codex-usage'] as const;

export type SectionId =
	| (typeof OVERVIEW_SECTIONS)[number]
	| (typeof AGENTS_SECTIONS)[number]
	| (typeof AGENT_OVERVIEW_SECTIONS)[number]
	| (typeof AGENT_OVERVIEW_WITH_WORKTREE_SECTIONS)[number]
	| (typeof ACTIVITY_SECTIONS)[number]
	| (typeof AUTORUN_SECTIONS)[number]
	| (typeof ANTHROPIC_USAGE_SECTIONS)[number]
	| (typeof CODEX_USAGE_SECTIONS)[number];

const SECTION_LABELS: Record<SectionId, string> = {
	'year-in-pixels': 'Past Year Activity Strip',
	'summary-cards': 'Summary Cards',
	'query-percentiles': 'Query Duration Percentiles',
	'autorun-task-percentiles': 'Auto Run Task Duration Percentiles',
	'agent-overview-cards': 'Active Agents Overview',
	'session-stats': 'Agent Statistics',
	'worktree-analytics': 'Worktree Analytics',
	'anthropic-usage': 'Anthropic Usage',
	'codex-usage': 'OpenAI Usage',
	'agent-efficiency': 'Agent Efficiency Chart',
	'agent-comparison': 'Provider Comparison Chart',
	'provider-trends': 'Provider Trends Over Time',
	'agent-usage': 'Agent Usage Chart',
	'source-distribution': 'Session Type Chart',
	'location-distribution': 'Location Distribution Chart',
	'radial-activity': 'Activity by Hour and Day of Week',
	'activity-heatmap': 'Activity Heatmap',
	'weekday-comparison': 'Weekday vs Weekend Chart',
	'duration-trends': 'Duration Trends Chart',
	'autorun-stats': 'Auto Run Statistics',
	'tasks-by-hour': 'Tasks by Time of Day Chart',
	'longest-autoruns': 'Top 25 Longest Auto Runs',
};

interface SectionOptions {
	hasWorktreeAnalytics?: boolean;
}

export function getSectionsForViewMode(
	viewMode: ViewMode,
	options: SectionOptions = {}
): readonly SectionId[] {
	switch (viewMode) {
		case 'overview':
			return OVERVIEW_SECTIONS;
		case 'agents':
			return AGENTS_SECTIONS;
		case 'agent-overview':
			return options.hasWorktreeAnalytics
				? AGENT_OVERVIEW_WITH_WORKTREE_SECTIONS
				: AGENT_OVERVIEW_SECTIONS;
		case 'activity':
			return ACTIVITY_SECTIONS;
		case 'autorun':
			return AUTORUN_SECTIONS;
		case 'anthropic-usage':
			return ANTHROPIC_USAGE_SECTIONS;
		case 'codex-usage':
			return CODEX_USAGE_SECTIONS;
		case 'cue':
		case 'shortcuts':
			return [];
		default:
			return OVERVIEW_SECTIONS;
	}
}

export function getSectionLabel(sectionId: SectionId): string {
	return SECTION_LABELS[sectionId] || sectionId;
}
