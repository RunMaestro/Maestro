export type CampaignStatus =
	| 'queued'
	| 'running'
	| 'needs_review'
	| 'blocked'
	| 'complete'
	| 'archived';

export type CampaignTaskStatus =
	| 'queued'
	| 'running'
	| 'waiting'
	| 'needs_review'
	| 'fixing'
	| 'passed'
	| 'failed'
	| 'blocked'
	| 'merged'
	| 'discarded'
	| 'skipped';

export type CampaignMetadata = Record<string, unknown>;
export type CampaignSource = string | CampaignMetadata;
export type CampaignSummaryValue = string | CampaignMetadata;

export interface CampaignTask {
	id: string;
	title: string;
	status: CampaignTaskStatus;
	runId?: string;
	dependsOn: string[];
	worktreePath?: string;
	branch?: string;
	pullRequestUrl?: string;
	prompt?: string;
	agentType?: string;
	cwd?: string;
	tabId?: string;
	error?: string;
	checkSummary?: CampaignSummaryValue;
	reviewSummary?: CampaignSummaryValue;
	mergeSummary?: CampaignSummaryValue;
	metadata?: CampaignMetadata;
}

export interface Campaign {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	status: CampaignStatus;
	objective?: string;
	runIds: string[];
	tasks: CampaignTask[];
	source?: CampaignSource;
	metadata?: CampaignMetadata;
}

export type CampaignTaskStatusCounts = Record<CampaignTaskStatus, number>;

export interface CampaignSummary {
	id: string;
	title: string;
	status: CampaignStatus;
	objective?: string;
	createdAt: number;
	updatedAt: number;
	runCount: number;
	totalTasks: number;
	runnableTaskIds: string[];
	statusCounts: CampaignTaskStatusCounts;
}
