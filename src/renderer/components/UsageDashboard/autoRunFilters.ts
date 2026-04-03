export type AutoRunPromptProfile = 'full' | 'compact-code' | 'compact-doc';
export type AutoRunAgentStrategy = 'single' | 'plan-execute-verify';
export type AutoRunWorktreeMode =
	| 'disabled'
	| 'managed'
	| 'existing-open'
	| 'existing-closed'
	| 'create-new';
export type AutoRunSchedulerMode = 'sequential' | 'dag';

export interface AutoRunAnalyticsFilters {
	playbookName: string;
	promptProfile: AutoRunPromptProfile | '';
	agentStrategy: AutoRunAgentStrategy | '';
	worktreeMode: AutoRunWorktreeMode | '';
	schedulerMode: AutoRunSchedulerMode | '';
}

export const DEFAULT_AUTORUN_ANALYTICS_FILTERS: AutoRunAnalyticsFilters = {
	playbookName: '',
	promptProfile: '',
	agentStrategy: '',
	worktreeMode: '',
	schedulerMode: '',
};

export function hasActiveAutoRunFilters(filters: AutoRunAnalyticsFilters): boolean {
	return Object.values(filters).some(Boolean);
}

export function formatPromptProfile(promptProfile?: AutoRunPromptProfile | ''): string {
	switch (promptProfile) {
		case 'compact-code':
			return 'Code';
		case 'compact-doc':
			return 'Doc';
		case 'full':
			return 'Full';
		default:
			return '—';
	}
}

export function formatPromptProfileLong(promptProfile?: AutoRunPromptProfile | ''): string {
	switch (promptProfile) {
		case 'compact-code':
			return 'Compact Code';
		case 'compact-doc':
			return 'Compact Doc';
		case 'full':
			return 'Full';
		default:
			return '—';
	}
}

export function formatAgentStrategy(agentStrategy?: AutoRunAgentStrategy | ''): string {
	switch (agentStrategy) {
		case 'plan-execute-verify':
			return 'PEV';
		case 'single':
			return 'Single';
		default:
			return '—';
	}
}

export function formatAgentStrategyLong(agentStrategy?: AutoRunAgentStrategy | ''): string {
	switch (agentStrategy) {
		case 'plan-execute-verify':
			return 'Plan / Execute / Verify';
		case 'single':
			return 'Single Pass';
		default:
			return '—';
	}
}

export function formatWorktreeMode(worktreeMode?: AutoRunWorktreeMode | ''): string {
	switch (worktreeMode) {
		case 'existing-open':
			return 'Open';
		case 'existing-closed':
			return 'Closed';
		case 'create-new':
			return 'New';
		case 'managed':
			return 'Managed';
		case 'disabled':
			return 'Off';
		default:
			return '—';
	}
}

export function formatWorktreeModeLong(worktreeMode?: AutoRunWorktreeMode | ''): string {
	switch (worktreeMode) {
		case 'existing-open':
			return 'Existing Open';
		case 'existing-closed':
			return 'Existing Closed';
		case 'create-new':
			return 'Create New';
		case 'managed':
			return 'Managed';
		case 'disabled':
			return 'Disabled';
		default:
			return '—';
	}
}

export function formatSchedulerMode(schedulerMode?: AutoRunSchedulerMode | ''): string {
	switch (schedulerMode) {
		case 'dag':
			return 'DAG';
		case 'sequential':
			return 'Sequential';
		default:
			return '—';
	}
}
