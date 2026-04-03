/**
 * Row Mapper Functions
 *
 * Converts snake_case SQLite row objects to camelCase TypeScript interfaces.
 * Centralizes the mapping logic that was previously duplicated across CRUD methods.
 */

import type {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
} from '../../shared/stats-types';
import type {
	AutoRunSchedulerMode,
	AutoRunSchedulerOutcome,
	PlaybookAgentStrategy,
	PlaybookPromptProfile,
} from '../../shared/types';
import type { MigrationRecord } from './types';

// ============================================================================
// Raw Row Types (snake_case from SQLite)
// ============================================================================

export interface QueryEventRow {
	id: string;
	session_id: string;
	agent_type: string;
	source: 'user' | 'auto';
	start_time: number;
	duration: number;
	project_path: string | null;
	tab_id: string | null;
	is_remote: number | null;
}

export interface AutoRunSessionRow {
	id: string;
	session_id: string;
	agent_type: string;
	document_path: string | null;
	start_time: number;
	duration: number;
	tasks_total: number | null;
	tasks_completed: number | null;
	project_path: string | null;
	playbook_id: string | null;
	playbook_name: string | null;
	prompt_profile: string | null;
	agent_strategy: string | null;
	worktree_mode: string | null;
	scheduler_mode: string | null;
	max_parallelism: number | null;
}

export interface AutoRunTaskRow {
	id: string;
	auto_run_session_id: string;
	session_id: string;
	agent_type: string;
	task_index: number;
	task_content: string | null;
	start_time: number;
	duration: number;
	success: number;
	document_path: string | null;
	verifier_verdict: 'PASS' | 'WARN' | 'FAIL' | null;
	prompt_profile: string | null;
	agent_strategy: string | null;
	worktree_mode: string | null;
	scheduler_outcome: string | null;
	queue_wait_ms: number | null;
	retry_count: number | null;
	timed_out: number | null;
}

export interface SessionLifecycleRow {
	id: string;
	session_id: string;
	agent_type: string;
	project_path: string | null;
	created_at: number;
	closed_at: number | null;
	duration: number | null;
	is_remote: number | null;
}

export interface MigrationRecordRow {
	version: number;
	description: string;
	applied_at: number;
	status: 'success' | 'failed';
	error_message: string | null;
}

const PLAYBOOK_PROMPT_PROFILES = new Set<PlaybookPromptProfile>([
	'full',
	'compact-code',
	'compact-doc',
]);
const PLAYBOOK_AGENT_STRATEGIES = new Set<PlaybookAgentStrategy>(['single', 'plan-execute-verify']);
const AUTORUN_WORKTREE_MODES = new Set([
	'disabled',
	'managed',
	'existing-open',
	'existing-closed',
	'create-new',
] as const);
const AUTORUN_SCHEDULER_MODES = new Set<AutoRunSchedulerMode>(['sequential', 'dag']);
const AUTORUN_SCHEDULER_OUTCOMES = new Set<AutoRunSchedulerOutcome>([
	'completed',
	'failed',
	'timed_out',
]);

function parseEnumValue<T extends string>(
	value: string | null,
	allowed: ReadonlySet<T>
): T | undefined {
	if (value && allowed.has(value as T)) {
		return value as T;
	}
	return undefined;
}

// ============================================================================
// Mapper Functions
// ============================================================================

export function mapQueryEventRow(row: QueryEventRow): QueryEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		source: row.source,
		startTime: row.start_time,
		duration: row.duration,
		projectPath: row.project_path ?? undefined,
		tabId: row.tab_id ?? undefined,
		isRemote: row.is_remote !== null ? row.is_remote === 1 : undefined,
	};
}

export function mapAutoRunSessionRow(row: AutoRunSessionRow): AutoRunSession {
	return {
		id: row.id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		documentPath: row.document_path ?? undefined,
		startTime: row.start_time,
		duration: row.duration,
		tasksTotal: row.tasks_total ?? undefined,
		tasksCompleted: row.tasks_completed ?? undefined,
		projectPath: row.project_path ?? undefined,
		playbookId: row.playbook_id ?? undefined,
		playbookName: row.playbook_name ?? undefined,
		promptProfile: parseEnumValue(row.prompt_profile, PLAYBOOK_PROMPT_PROFILES),
		agentStrategy: parseEnumValue(row.agent_strategy, PLAYBOOK_AGENT_STRATEGIES),
		worktreeMode: parseEnumValue(row.worktree_mode, AUTORUN_WORKTREE_MODES),
		schedulerMode: parseEnumValue(row.scheduler_mode, AUTORUN_SCHEDULER_MODES),
		maxParallelism: row.max_parallelism ?? undefined,
	};
}

export function mapAutoRunTaskRow(row: AutoRunTaskRow): AutoRunTask {
	return {
		id: row.id,
		autoRunSessionId: row.auto_run_session_id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		taskIndex: row.task_index,
		taskContent: row.task_content ?? undefined,
		startTime: row.start_time,
		duration: row.duration,
		success: row.success === 1,
		documentPath: row.document_path ?? undefined,
		verifierVerdict: row.verifier_verdict ?? undefined,
		promptProfile: parseEnumValue(row.prompt_profile, PLAYBOOK_PROMPT_PROFILES),
		agentStrategy: parseEnumValue(row.agent_strategy, PLAYBOOK_AGENT_STRATEGIES),
		worktreeMode: parseEnumValue(row.worktree_mode, AUTORUN_WORKTREE_MODES),
		schedulerOutcome: parseEnumValue(row.scheduler_outcome, AUTORUN_SCHEDULER_OUTCOMES),
		queueWaitMs: row.queue_wait_ms ?? undefined,
		retryCount: row.retry_count ?? undefined,
		timedOut: row.timed_out !== null ? row.timed_out === 1 : undefined,
	};
}

export function mapSessionLifecycleRow(row: SessionLifecycleRow): SessionLifecycleEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		projectPath: row.project_path ?? undefined,
		createdAt: row.created_at,
		closedAt: row.closed_at ?? undefined,
		duration: row.duration ?? undefined,
		isRemote: row.is_remote !== null ? row.is_remote === 1 : undefined,
	};
}

export function mapMigrationRecordRow(row: MigrationRecordRow): MigrationRecord {
	return {
		version: row.version,
		description: row.description,
		appliedAt: row.applied_at,
		status: row.status,
		errorMessage: row.error_message ?? undefined,
	};
}
