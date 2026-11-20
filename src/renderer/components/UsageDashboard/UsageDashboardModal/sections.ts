import type { UsageDashboardViewMode as ViewMode } from '../../../types';

export const OVERVIEW_SECTIONS = [
	'year-in-pixels',
	'summary-cards',
	'token-speed',
	'delegation-score',
	'query-percentiles',
	'agent-comparison',
	'provider-trends',
	'source-distribution',
	'location-distribution',
	'radial-activity',
] as const;
/** Overview without the location donut: drawn only when some query ran over SSH. */
export const OVERVIEW_LOCAL_ONLY_SECTIONS = OVERVIEW_SECTIONS.filter(
	(id) => id !== 'location-distribution'
);

export const AGENTS_SECTIONS = ['agent-overview-cards'] as const;
export const GROUPS_SECTIONS = ['group-overview-cards'] as const;
export const AGENT_OVERVIEW_SECTIONS = [
	'session-stats',
	'agent-count-trend',
	'agent-usage',
] as const;
export const AGENT_OVERVIEW_WITH_WORKTREE_SECTIONS = [
	'session-stats',
	'agent-count-trend',
	'worktree-analytics',
	'agent-usage',
] as const;
export const TOKENS_SECTIONS = ['token-stats', 'resilience'] as const;
export const ACTIVITY_SECTIONS = [
	'prompt-cadence',
	'delegation-trend',
	'activity-heatmap',
	'duration-trends',
] as const;
export const AUTORUN_SECTIONS = [
	'autorun-stats',
	'wizard-stats',
	'autorun-task-percentiles',
	'tasks-by-hour',
	'longest-autoruns',
] as const;
export const CUE_SECTIONS = ['cue-stats'] as const;
export const SHORTCUTS_SECTIONS = ['keyboard-stats'] as const;
export const ANTHROPIC_USAGE_SECTIONS = ['anthropic-usage'] as const;
export const CODEX_USAGE_SECTIONS = ['codex-usage'] as const;

export type SectionId =
	| (typeof OVERVIEW_SECTIONS)[number]
	| (typeof AGENTS_SECTIONS)[number]
	| (typeof GROUPS_SECTIONS)[number]
	| (typeof AGENT_OVERVIEW_SECTIONS)[number]
	| (typeof AGENT_OVERVIEW_WITH_WORKTREE_SECTIONS)[number]
	| (typeof TOKENS_SECTIONS)[number]
	| (typeof ACTIVITY_SECTIONS)[number]
	| (typeof CUE_SECTIONS)[number]
	| (typeof SHORTCUTS_SECTIONS)[number]
	| (typeof AUTORUN_SECTIONS)[number]
	| (typeof ANTHROPIC_USAGE_SECTIONS)[number]
	| (typeof CODEX_USAGE_SECTIONS)[number];

const SECTION_LABELS: Record<SectionId, string> = {
	'year-in-pixels': 'Activity Strip',
	'summary-cards': 'Summary Cards',
	'token-speed': 'Tokens per Second',
	'delegation-score': 'Delegation Score',
	'prompt-cadence': 'Prompts',
	'delegation-trend': 'Interactive vs Delegated Trend',
	'query-percentiles': 'Query Duration Percentiles',
	'autorun-task-percentiles': 'Auto Run Agent Turn Duration Percentiles',
	'agent-overview-cards': 'Agent Cards',
	'group-overview-cards': 'Group Usage Overview',
	'session-stats': 'Agent Statistics',
	'token-stats': 'Token Usage',
	resilience: 'Resilience',
	'cue-stats': 'Cue Statistics',
	'keyboard-stats': 'Keyboard Shortcuts',
	'agent-count-trend': 'Agents Over Time',
	'worktree-analytics': 'Worktree Analytics',
	'anthropic-usage': 'Anthropic Usage',
	'codex-usage': 'OpenAI Usage',
	'agent-comparison': 'Provider Comparison Chart',
	'provider-trends': 'Provider Trends Over Time',
	'agent-usage': 'Agent Usage Chart',
	'source-distribution': 'Query Source Chart',
	'location-distribution': 'Query Location Chart',
	'radial-activity': 'Activity by Hour and Day of Week',
	'activity-heatmap': 'Activity Heatmap',
	'duration-trends': 'Duration Trends Chart',
	'autorun-stats': 'Auto Run Statistics',
	'wizard-stats': 'Auto Run Wizard Statistics',
	'tasks-by-hour': 'Agent Turns by Time of Day Chart',
	'longest-autoruns': 'Longest Auto Runs',
};

interface SectionOptions {
	hasWorktreeAnalytics?: boolean;
	/** Whether any query in range ran on an SSH remote (draws the location donut). */
	hasRemoteQueries?: boolean;
}

export function getSectionsForViewMode(
	viewMode: ViewMode,
	options: SectionOptions = {}
): readonly SectionId[] {
	switch (viewMode) {
		case 'overview':
			return options.hasRemoteQueries ? OVERVIEW_SECTIONS : OVERVIEW_LOCAL_ONLY_SECTIONS;
		case 'agents':
			return AGENTS_SECTIONS;
		case 'groups':
			return GROUPS_SECTIONS;
		case 'agent-overview':
			return options.hasWorktreeAnalytics
				? AGENT_OVERVIEW_WITH_WORKTREE_SECTIONS
				: AGENT_OVERVIEW_SECTIONS;
		case 'tokens':
			return TOKENS_SECTIONS;
		case 'activity':
			return ACTIVITY_SECTIONS;
		case 'autorun':
			return AUTORUN_SECTIONS;
		case 'anthropic-usage':
			return ANTHROPIC_USAGE_SECTIONS;
		case 'codex-usage':
			return CODEX_USAGE_SECTIONS;
		// Panels that load for themselves have no fixed section list to walk:
		// what they draw comes and goes with their own data.
		case 'cue':
			return CUE_SECTIONS;
		case 'shortcuts':
			return SHORTCUTS_SECTIONS;
		case 'models':
			return [];
		default:
			return OVERVIEW_SECTIONS;
	}
}

export function getSectionLabel(sectionId: SectionId): string {
	return SECTION_LABELS[sectionId] || sectionId;
}
