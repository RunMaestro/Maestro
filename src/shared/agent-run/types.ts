export const AGENT_RUN_STATUSES = [
	'queued',
	'running',
	'waiting',
	'needs_review',
	'fixing',
	'completed',
	'failed',
	'cancelled',
	'merged',
	'discarded',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const KNOWN_AGENT_RUN_PROVIDERS = [
	'claude-code',
	'codex',
	'opencode',
	'factory-droid',
	'copilot-cli',
	'qwen-coder',
	'omp',
	'cursor',
	'unknown',
] as const;

export type KnownAgentRunProvider = (typeof KNOWN_AGENT_RUN_PROVIDERS)[number];
export type AgentRunProvider = KnownAgentRunProvider | (string & {});

export const AGENT_RUN_REVIEW_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;

export type AgentRunReviewSeverity = (typeof AGENT_RUN_REVIEW_SEVERITIES)[number];

export const AGENT_RUN_REVIEW_STATUSES = ['open', 'fixed', 'dismissed'] as const;

export type AgentRunReviewStatus = (typeof AGENT_RUN_REVIEW_STATUSES)[number];

export const AGENT_RUN_CHECK_STATUSES = [
	'pending',
	'running',
	'passed',
	'failed',
	'skipped',
] as const;

export type AgentRunCheckStatus = (typeof AGENT_RUN_CHECK_STATUSES)[number];

export const AGENT_RUN_MERGE_STATUSES = [
	'not_attempted',
	'merged',
	'conflict',
	'failed',
	'skipped',
] as const;

export type AgentRunMergeStatus = (typeof AGENT_RUN_MERGE_STATUSES)[number];

export type AgentRunMetadata = Record<string, unknown>;

export interface AgentRunArtifact {
	name?: string;
	path?: string;
	url?: string;
	kind?: string;
	metadata?: AgentRunMetadata;
}

export interface AgentRunReviewFinding {
	file?: string;
	line?: number;
	severity: AgentRunReviewSeverity;
	category: string;
	message: string;
	confidence?: number;
	status: AgentRunReviewStatus;
	suggestedFix?: string;
	metadata?: AgentRunMetadata;
}

export interface AgentRunCheck {
	name: string;
	status: AgentRunCheckStatus;
	command?: string;
	startedAt?: number;
	completedAt?: number;
	url?: string;
	summary?: string;
	metadata?: AgentRunMetadata;
}

export interface AgentRunPullRequest {
	number?: number;
	url?: string;
	state?: string;
	mergeable?: boolean;
	headBranch?: string;
	baseBranch?: string;
	metadata?: AgentRunMetadata;
}

export interface AgentRunMergeOutcome {
	status: AgentRunMergeStatus;
	commit?: string;
	error?: string;
	metadata?: AgentRunMetadata;
}

export interface AgentRun {
	id: string;
	createdAt: number;
	updatedAt: number;
	provider: AgentRunProvider;
	model?: string;
	agentId?: string;
	agentName?: string;
	sessionId?: string;
	tabId?: string;
	cwd?: string;
	repo?: string;
	worktreePath?: string;
	branch?: string;
	baseBranch?: string;
	prompt?: string;
	status: AgentRunStatus;
	permissions?: AgentRunMetadata;
	policy?: AgentRunMetadata;
	usage?: AgentRunMetadata;
	artifacts: AgentRunArtifact[];
	touchedFiles: string[];
	checks: AgentRunCheck[];
	reviews: AgentRunReviewFinding[];
	pullRequest?: AgentRunPullRequest;
	merge?: AgentRunMergeOutcome;
	nextAction?: string;
	source?: string;
	metadata?: AgentRunMetadata;
}

export interface AgentRunEvent {
	id: string;
	runId: string;
	timestamp: number;
	type: string;
	/** Monotonic per-run sequence stamped at append time for stable ordering/dedup. */
	seq?: number;
	message?: string;
	status?: AgentRunStatus;
	data?: AgentRunMetadata;
	metadata?: AgentRunMetadata;
}

export interface AgentRunFile {
	runs: AgentRun[];
}

export interface AgentRunSummary {
	id: string;
	createdAt: number;
	updatedAt: number;
	provider: AgentRunProvider;
	status: AgentRunStatus;
	model?: string;
	agentName?: string;
	branch?: string;
	baseBranch?: string;
	pullRequestUrl?: string;
	touchedFileCount: number;
	artifactCount: number;
	checkCount: number;
	pendingCheckCount: number;
	runningCheckCount: number;
	passedCheckCount: number;
	failedCheckCount: number;
	skippedCheckCount: number;
	reviewFindingCount: number;
	openReviewFindingCount: number;
	fixedReviewFindingCount: number;
	dismissedReviewFindingCount: number;
	criticalReviewFindingCount: number;
	highReviewFindingCount: number;
}
