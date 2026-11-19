/**
 * Row Mapper Functions
 *
 * Converts snake_case SQLite row objects to camelCase TypeScript interfaces.
 * Centralizes the mapping logic that was previously duplicated across CRUD methods.
 */

import {
	isAutoRunFailureKind,
	normalizeAutoRunKind,
	normalizeAutoRunLaunchSource,
	normalizeAutoRunOutcomeStatus,
	type QueryEvent,
	type AutoRunFailure,
	type AutoRunSession,
	type AutoRunTask,
	type SessionLifecycleEvent,
} from '../../shared/stats-types';
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
	is_worktree: number | null;
	user_name: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_creation_tokens: number | null;
	cost_usd: number | null;
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
	/** Added in v15; null only if a row somehow bypassed the column DEFAULT. */
	kind: string | null;
	/** Added in v17, like the five columns after it; absent when selected from an older file. */
	playbook_id?: string | null;
	playbook_local_id?: string | null;
	playbook_version?: string | null;
	launch_source?: string | null;
	status?: string | null;
	documents_stalled?: number | null;
}

export interface AutoRunFailureRow {
	id: string;
	auto_run_session_id: string;
	document_filename: string | null;
	task_index: number | null;
	kind: string;
	agent_type: string;
	created_at: number;
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
	is_worktree: number | null;
}

export interface MigrationRecordRow {
	version: number;
	description: string;
	applied_at: number;
	status: 'success' | 'failed';
	error_message: string | null;
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
		isWorktree: row.is_worktree !== null ? row.is_worktree === 1 : undefined,
		userName: row.user_name ?? undefined,
		// NULL stays undefined rather than collapsing to 0 - a turn with no
		// reported usage is not a turn that used nothing.
		inputTokens: row.input_tokens ?? undefined,
		outputTokens: row.output_tokens ?? undefined,
		cacheReadTokens: row.cache_read_tokens ?? undefined,
		cacheCreationTokens: row.cache_creation_tokens ?? undefined,
		costUsd: row.cost_usd ?? undefined,
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
		kind: normalizeAutoRunKind(row.kind),
		playbookId: row.playbook_id ?? undefined,
		playbookLocalId: row.playbook_local_id ?? undefined,
		playbookVersion: row.playbook_version ?? undefined,
		launchSource: normalizeAutoRunLaunchSource(row.launch_source) ?? undefined,
		status: normalizeAutoRunOutcomeStatus(row.status) ?? undefined,
		documentsStalled: row.documents_stalled ?? undefined,
	};
}

export function mapAutoRunFailureRow(row: AutoRunFailureRow): AutoRunFailure {
	return {
		id: row.id,
		autoRunSessionId: row.auto_run_session_id,
		documentFilename: row.document_filename ?? undefined,
		taskIndex: row.task_index ?? undefined,
		// The column's CHECK admits only known kinds; a row from a newer build reads as an error.
		kind: isAutoRunFailureKind(row.kind) ? row.kind : 'error',
		agentType: row.agent_type,
		createdAt: row.created_at,
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
		isWorktree: row.is_worktree !== null ? row.is_worktree === 1 : undefined,
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
