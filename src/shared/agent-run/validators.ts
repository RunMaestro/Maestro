import {
	AGENT_RUN_CHECK_STATUSES,
	AGENT_RUN_MERGE_STATUSES,
	AGENT_RUN_REVIEW_SEVERITIES,
	AGENT_RUN_REVIEW_STATUSES,
	AGENT_RUN_STATUSES,
	type AgentRun,
	type AgentRunArtifact,
	type AgentRunCheck,
	type AgentRunEvent,
	type AgentRunFile,
	type AgentRunMergeOutcome,
	type AgentRunMetadata,
	type AgentRunPullRequest,
	type AgentRunReviewFinding,
	type AgentRunSummary,
	type AgentRunProvider,
	type AgentRunStatus,
} from './types';

const AGENT_RUN_STATUS_SET: ReadonlySet<string> = new Set(AGENT_RUN_STATUSES);
const AGENT_RUN_CHECK_STATUS_SET: ReadonlySet<string> = new Set(AGENT_RUN_CHECK_STATUSES);
const AGENT_RUN_REVIEW_SEVERITY_SET: ReadonlySet<string> = new Set(AGENT_RUN_REVIEW_SEVERITIES);
const AGENT_RUN_REVIEW_STATUS_SET: ReadonlySet<string> = new Set(AGENT_RUN_REVIEW_STATUSES);
const AGENT_RUN_MERGE_STATUS_SET: ReadonlySet<string> = new Set(AGENT_RUN_MERGE_STATUSES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function readOptionalString(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	return typeof value === 'string' ? value : undefined;
}

function readOptionalFiniteNumber(raw: Record<string, unknown>, key: string): number | undefined {
	const value = raw[key];
	return isFiniteNumber(value) ? value : undefined;
}

function readOptionalMetadata(
	raw: Record<string, unknown>,
	key: string
): AgentRunMetadata | undefined {
	const value = raw[key];
	return isPlainObject(value) ? { ...value } : undefined;
}

function hasInvalidOptionalStrings(raw: Record<string, unknown>, keys: string[]): boolean {
	return keys.some((key) => raw[key] !== undefined && typeof raw[key] !== 'string');
}

function hasInvalidOptionalNumbers(raw: Record<string, unknown>, keys: string[]): boolean {
	return keys.some((key) => raw[key] !== undefined && !isFiniteNumber(raw[key]));
}

function hasInvalidOptionalMetadata(raw: Record<string, unknown>, keys: string[]): boolean {
	return keys.some((key) => raw[key] !== undefined && !isPlainObject(raw[key]));
}

function hasInvalidOptionalBooleans(raw: Record<string, unknown>, keys: string[]): boolean {
	return keys.some((key) => raw[key] !== undefined && typeof raw[key] !== 'boolean');
}

function hasInvalidOptionalFields(
	raw: Record<string, unknown>,
	options: {
		strings?: string[];
		numbers?: string[];
		metadata?: string[];
		booleans?: string[];
	}
): boolean {
	return (
		hasInvalidOptionalStrings(raw, options.strings ?? []) ||
		hasInvalidOptionalNumbers(raw, options.numbers ?? []) ||
		hasInvalidOptionalMetadata(raw, options.metadata ?? []) ||
		hasInvalidOptionalBooleans(raw, options.booleans ?? [])
	);
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
	return typeof value === 'string' && AGENT_RUN_STATUS_SET.has(value);
}

function validateArtifact(
	raw: unknown,
	options: { strictOptional: boolean }
): AgentRunArtifact | null {
	if (!isPlainObject(raw)) return null;
	if (
		options.strictOptional &&
		hasInvalidOptionalFields(raw, {
			strings: ['name', 'path', 'url', 'kind'],
			metadata: ['metadata'],
		})
	) {
		return null;
	}

	const artifact: AgentRunArtifact = {};
	const name = readOptionalString(raw, 'name');
	const path = readOptionalString(raw, 'path');
	const url = readOptionalString(raw, 'url');
	const kind = readOptionalString(raw, 'kind');
	const metadata = readOptionalMetadata(raw, 'metadata');

	if (name !== undefined) artifact.name = name;
	if (path !== undefined) artifact.path = path;
	if (url !== undefined) artifact.url = url;
	if (kind !== undefined) artifact.kind = kind;
	if (metadata !== undefined) artifact.metadata = metadata;

	return artifact;
}

function validateCheck(raw: unknown, options: { strictOptional: boolean }): AgentRunCheck | null {
	if (!isPlainObject(raw)) return null;
	if (!isNonEmptyString(raw.name)) return null;
	if (typeof raw.status !== 'string' || !AGENT_RUN_CHECK_STATUS_SET.has(raw.status)) return null;
	if (
		options.strictOptional &&
		hasInvalidOptionalFields(raw, {
			strings: ['command', 'url', 'summary'],
			numbers: ['startedAt', 'completedAt'],
			metadata: ['metadata'],
		})
	) {
		return null;
	}

	const check: AgentRunCheck = {
		name: raw.name,
		status: raw.status as AgentRunCheck['status'],
	};
	const command = readOptionalString(raw, 'command');
	const startedAt = readOptionalFiniteNumber(raw, 'startedAt');
	const completedAt = readOptionalFiniteNumber(raw, 'completedAt');
	const url = readOptionalString(raw, 'url');
	const summary = readOptionalString(raw, 'summary');
	const metadata = readOptionalMetadata(raw, 'metadata');

	if (command !== undefined) check.command = command;
	if (startedAt !== undefined) check.startedAt = startedAt;
	if (completedAt !== undefined) check.completedAt = completedAt;
	if (url !== undefined) check.url = url;
	if (summary !== undefined) check.summary = summary;
	if (metadata !== undefined) check.metadata = metadata;

	return check;
}

function validateReviewFinding(
	raw: unknown,
	options: { strictOptional: boolean }
): AgentRunReviewFinding | null {
	if (!isPlainObject(raw)) return null;
	if (typeof raw.severity !== 'string' || !AGENT_RUN_REVIEW_SEVERITY_SET.has(raw.severity))
		return null;
	if (!isNonEmptyString(raw.category)) return null;
	if (!isNonEmptyString(raw.message)) return null;
	if (typeof raw.status !== 'string' || !AGENT_RUN_REVIEW_STATUS_SET.has(raw.status)) return null;
	if (
		options.strictOptional &&
		hasInvalidOptionalFields(raw, {
			strings: ['file', 'suggestedFix'],
			numbers: ['line', 'confidence'],
			metadata: ['metadata'],
		})
	) {
		return null;
	}

	const finding: AgentRunReviewFinding = {
		severity: raw.severity as AgentRunReviewFinding['severity'],
		category: raw.category,
		message: raw.message,
		status: raw.status as AgentRunReviewFinding['status'],
	};
	const file = readOptionalString(raw, 'file');
	const line = readOptionalFiniteNumber(raw, 'line');
	const confidence = readOptionalFiniteNumber(raw, 'confidence');
	const suggestedFix = readOptionalString(raw, 'suggestedFix');
	const metadata = readOptionalMetadata(raw, 'metadata');

	if (file !== undefined) finding.file = file;
	if (line !== undefined) finding.line = line;
	if (confidence !== undefined) finding.confidence = confidence;
	if (suggestedFix !== undefined) finding.suggestedFix = suggestedFix;
	if (metadata !== undefined) finding.metadata = metadata;

	return finding;
}

function validatePullRequest(
	raw: unknown,
	options: { strictOptional: boolean }
): AgentRunPullRequest | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (
		options.strictOptional &&
		hasInvalidOptionalFields(raw, {
			strings: ['url', 'state', 'headBranch', 'baseBranch'],
			numbers: ['number'],
			booleans: ['mergeable'],
			metadata: ['metadata'],
		})
	) {
		return undefined;
	}

	const pullRequest: AgentRunPullRequest = {};
	const number = readOptionalFiniteNumber(raw, 'number');
	const url = readOptionalString(raw, 'url');
	const state = readOptionalString(raw, 'state');
	const mergeable = typeof raw.mergeable === 'boolean' ? raw.mergeable : undefined;
	const headBranch = readOptionalString(raw, 'headBranch');
	const baseBranch = readOptionalString(raw, 'baseBranch');
	const metadata = readOptionalMetadata(raw, 'metadata');

	if (number !== undefined) pullRequest.number = number;
	if (url !== undefined) pullRequest.url = url;
	if (state !== undefined) pullRequest.state = state;
	if (mergeable !== undefined) pullRequest.mergeable = mergeable;
	if (headBranch !== undefined) pullRequest.headBranch = headBranch;
	if (baseBranch !== undefined) pullRequest.baseBranch = baseBranch;
	if (metadata !== undefined) pullRequest.metadata = metadata;

	return pullRequest;
}

function validateMergeOutcome(
	raw: unknown,
	options: { strictOptional: boolean }
): AgentRunMergeOutcome | undefined {
	if (!isPlainObject(raw)) return undefined;
	if (typeof raw.status !== 'string' || !AGENT_RUN_MERGE_STATUS_SET.has(raw.status))
		return undefined;
	if (
		options.strictOptional &&
		hasInvalidOptionalFields(raw, {
			strings: ['commit', 'error'],
			metadata: ['metadata'],
		})
	) {
		return undefined;
	}

	const merge: AgentRunMergeOutcome = {
		status: raw.status as AgentRunMergeOutcome['status'],
	};
	const commit = readOptionalString(raw, 'commit');
	const error = readOptionalString(raw, 'error');
	const metadata = readOptionalMetadata(raw, 'metadata');

	if (commit !== undefined) merge.commit = commit;
	if (error !== undefined) merge.error = error;
	if (metadata !== undefined) merge.metadata = metadata;

	return merge;
}

function validateRequiredArray(raw: Record<string, unknown>, key: string): unknown[] | null {
	const value = raw[key];
	return Array.isArray(value) ? value : null;
}

function validateAgentRunWithOptions(
	raw: unknown,
	options: { strictChildren: boolean }
): AgentRun | null {
	if (!isPlainObject(raw)) return null;
	if (!isNonEmptyString(raw.id)) return null;
	if (!isFiniteNumber(raw.createdAt)) return null;
	if (!isFiniteNumber(raw.updatedAt)) return null;
	if (!isNonEmptyString(raw.provider)) return null;
	if (!isAgentRunStatus(raw.status)) return null;

	const rawArtifacts = validateRequiredArray(raw, 'artifacts');
	const rawTouchedFiles = validateRequiredArray(raw, 'touchedFiles');
	const rawChecks = validateRequiredArray(raw, 'checks');
	const rawReviews = validateRequiredArray(raw, 'reviews');
	if (!rawArtifacts || !rawTouchedFiles || !rawChecks || !rawReviews) return null;
	const childOptions = { strictOptional: options.strictChildren };

	const artifacts = rawArtifacts.flatMap((artifact) => {
		const validated = validateArtifact(artifact, childOptions);
		return validated ? [validated] : [];
	});
	const touchedFiles = rawTouchedFiles.filter(isNonEmptyString);
	const checks = rawChecks.flatMap((check) => {
		const validated = validateCheck(check, childOptions);
		return validated ? [validated] : [];
	});
	const reviews = rawReviews.flatMap((review) => {
		const validated = validateReviewFinding(review, childOptions);
		return validated ? [validated] : [];
	});
	if (
		options.strictChildren &&
		(artifacts.length !== rawArtifacts.length ||
			touchedFiles.length !== rawTouchedFiles.length ||
			checks.length !== rawChecks.length ||
			reviews.length !== rawReviews.length)
	) {
		return null;
	}
	if (
		options.strictChildren &&
		hasInvalidOptionalFields(raw, {
			strings: [
				'model',
				'agentId',
				'agentName',
				'sessionId',
				'tabId',
				'cwd',
				'repo',
				'worktreePath',
				'branch',
				'baseBranch',
				'prompt',
				'nextAction',
				'source',
			],
			metadata: ['permissions', 'policy', 'usage', 'metadata'],
		})
	) {
		return null;
	}

	const run: AgentRun = {
		id: raw.id,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
		provider: raw.provider as AgentRunProvider,
		status: raw.status,
		artifacts,
		touchedFiles,
		checks,
		reviews,
	};

	const model = readOptionalString(raw, 'model');
	const agentId = readOptionalString(raw, 'agentId');
	const agentName = readOptionalString(raw, 'agentName');
	const sessionId = readOptionalString(raw, 'sessionId');
	const tabId = readOptionalString(raw, 'tabId');
	const cwd = readOptionalString(raw, 'cwd');
	const repo = readOptionalString(raw, 'repo');
	const worktreePath = readOptionalString(raw, 'worktreePath');
	const branch = readOptionalString(raw, 'branch');
	const baseBranch = readOptionalString(raw, 'baseBranch');
	const prompt = readOptionalString(raw, 'prompt');
	const permissions = readOptionalMetadata(raw, 'permissions');
	const policy = readOptionalMetadata(raw, 'policy');
	const usage = readOptionalMetadata(raw, 'usage');
	const pullRequest = validatePullRequest(raw.pullRequest, childOptions);
	const merge = validateMergeOutcome(raw.merge, childOptions);
	const nextAction = readOptionalString(raw, 'nextAction');
	const source = readOptionalString(raw, 'source');
	const metadata = readOptionalMetadata(raw, 'metadata');
	if (
		options.strictChildren &&
		((raw.pullRequest !== undefined && pullRequest === undefined) ||
			(raw.merge !== undefined && merge === undefined))
	) {
		return null;
	}

	if (model !== undefined) run.model = model;
	if (agentId !== undefined) run.agentId = agentId;
	if (agentName !== undefined) run.agentName = agentName;
	if (sessionId !== undefined) run.sessionId = sessionId;
	if (tabId !== undefined) run.tabId = tabId;
	if (cwd !== undefined) run.cwd = cwd;
	if (repo !== undefined) run.repo = repo;
	if (worktreePath !== undefined) run.worktreePath = worktreePath;
	if (branch !== undefined) run.branch = branch;
	if (baseBranch !== undefined) run.baseBranch = baseBranch;
	if (prompt !== undefined) run.prompt = prompt;
	if (permissions !== undefined) run.permissions = permissions;
	if (policy !== undefined) run.policy = policy;
	if (usage !== undefined) run.usage = usage;
	if (pullRequest !== undefined) run.pullRequest = pullRequest;
	if (merge !== undefined) run.merge = merge;
	if (nextAction !== undefined) run.nextAction = nextAction;
	if (source !== undefined) run.source = source;
	if (metadata !== undefined) run.metadata = metadata;

	return run;
}

export function validateAgentRun(raw: unknown): AgentRun | null {
	return validateAgentRunWithOptions(raw, { strictChildren: false });
}

export function validateAgentRunStrict(raw: unknown): AgentRun | null {
	return validateAgentRunWithOptions(raw, { strictChildren: true });
}
function validateAgentRunEventWithOptions(
	raw: unknown,
	options: { strictOptional: boolean }
): AgentRunEvent | null {
	if (!isPlainObject(raw)) return null;
	if (!isNonEmptyString(raw.id)) return null;
	if (!isNonEmptyString(raw.runId)) return null;
	if (!isFiniteNumber(raw.timestamp)) return null;
	if (!isNonEmptyString(raw.type)) return null;
	if (raw.status !== undefined && !isAgentRunStatus(raw.status)) return null;
	if (
		options.strictOptional &&
		hasInvalidOptionalFields(raw, {
			strings: ['message'],
			metadata: ['data', 'metadata'],
		})
	) {
		return null;
	}

	const event: AgentRunEvent = {
		id: raw.id,
		runId: raw.runId,
		timestamp: raw.timestamp,
		type: raw.type,
	};
	const message = readOptionalString(raw, 'message');
	const data = readOptionalMetadata(raw, 'data');
	const metadata = readOptionalMetadata(raw, 'metadata');

	if (message !== undefined) event.message = message;
	if (raw.status !== undefined) event.status = raw.status;
	if (data !== undefined) event.data = data;
	if (metadata !== undefined) event.metadata = metadata;

	return event;
}

export function validateAgentRunEvent(raw: unknown): AgentRunEvent | null {
	return validateAgentRunEventWithOptions(raw, { strictOptional: false });
}

export function validateAgentRunEventStrict(raw: unknown): AgentRunEvent | null {
	return validateAgentRunEventWithOptions(raw, { strictOptional: true });
}

export function validateAgentRunFile(raw: unknown): AgentRunFile {
	if (!isPlainObject(raw) || !Array.isArray(raw.runs)) {
		return { runs: [] };
	}

	return {
		runs: raw.runs.flatMap((run) => {
			const validated = validateAgentRun(run);
			return validated ? [validated] : [];
		}),
	};
}

export function validateAgentRunEvents(rawLines: string[]): AgentRunEvent[] {
	return rawLines.flatMap((line) => {
		const trimmed = line.trim();
		if (trimmed.length === 0) return [];

		try {
			const parsed = JSON.parse(trimmed) as unknown;
			const event = validateAgentRunEvent(parsed);
			return event ? [event] : [];
		} catch {
			return [];
		}
	});
}

export function summarizeAgentRun(run: AgentRun): AgentRunSummary {
	const pendingCheckCount = run.checks.filter((check) => check.status === 'pending').length;
	const runningCheckCount = run.checks.filter((check) => check.status === 'running').length;
	const passedCheckCount = run.checks.filter((check) => check.status === 'passed').length;
	const failedCheckCount = run.checks.filter((check) => check.status === 'failed').length;
	const skippedCheckCount = run.checks.filter((check) => check.status === 'skipped').length;
	const openReviewFindingCount = run.reviews.filter((review) => review.status === 'open').length;
	const fixedReviewFindingCount = run.reviews.filter((review) => review.status === 'fixed').length;
	const dismissedReviewFindingCount = run.reviews.filter(
		(review) => review.status === 'dismissed'
	).length;
	const criticalReviewFindingCount = run.reviews.filter(
		(review) => review.severity === 'critical'
	).length;
	const highReviewFindingCount = run.reviews.filter((review) => review.severity === 'high').length;

	const summary: AgentRunSummary = {
		id: run.id,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		provider: run.provider,
		status: run.status,
		touchedFileCount: run.touchedFiles.length,
		artifactCount: run.artifacts.length,
		checkCount: run.checks.length,
		pendingCheckCount,
		runningCheckCount,
		passedCheckCount,
		failedCheckCount,
		skippedCheckCount,
		reviewFindingCount: run.reviews.length,
		openReviewFindingCount,
		fixedReviewFindingCount,
		dismissedReviewFindingCount,
		criticalReviewFindingCount,
		highReviewFindingCount,
	};

	if (run.model !== undefined) summary.model = run.model;
	if (run.agentName !== undefined) summary.agentName = run.agentName;
	if (run.branch !== undefined) summary.branch = run.branch;
	if (run.baseBranch !== undefined) summary.baseBranch = run.baseBranch;
	if (run.pullRequest?.url !== undefined) summary.pullRequestUrl = run.pullRequest.url;

	return summary;
}
