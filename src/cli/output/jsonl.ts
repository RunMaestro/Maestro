// JSONL output helper for CLI
// Outputs machine-parseable JSON lines to stdout

import type { UsageStats } from '../../shared/types';

// Base event interface - all events have a type and timestamp
export interface JsonlEvent {
	type: string;
	timestamp: number;
	[key: string]: unknown;
}

// Event types for playbook execution
export interface StartEvent extends JsonlEvent {
	type: 'start';
	playbook: {
		id: string;
		name: string;
	};
	session: {
		id: string;
		name: string;
		cwd: string;
	};
}

export interface DocumentStartEvent extends JsonlEvent {
	type: 'document_start';
	document: string;
	index: number;
	taskCount: number;
}

export interface TaskStartEvent extends JsonlEvent {
	type: 'task_start';
	document: string;
	taskIndex: number;
}

export interface TaskCompleteEvent extends JsonlEvent {
	type: 'task_complete';
	document: string;
	taskIndex: number;
	success: boolean;
	summary: string;
	fullResponse?: string;
	elapsedMs: number;
	usageStats?: UsageStats;
	agentSessionId?: string;
}

export interface DocumentCompleteEvent extends JsonlEvent {
	type: 'document_complete';
	document: string;
	tasksCompleted: number;
}

export interface LoopCompleteEvent extends JsonlEvent {
	type: 'loop_complete';
	iteration: number;
	tasksCompleted: number;
	elapsedMs: number;
	usageStats?: UsageStats;
}

export interface CompleteEvent extends JsonlEvent {
	type: 'complete';
	success: boolean;
	totalTasksCompleted: number;
	totalElapsedMs: number;
	totalCost?: number;
}

export interface ErrorEvent extends JsonlEvent {
	type: 'error';
	message: string;
	code?: string;
}

// List command events
export interface GroupEvent extends JsonlEvent {
	type: 'group';
	id: string;
	name: string;
	emoji: string;
	collapsed: boolean;
}

export interface AgentEvent extends JsonlEvent {
	type: 'agent';
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	groupId?: string;
	autoRunFolderPath?: string;
}

export interface PlaybookEvent extends JsonlEvent {
	type: 'playbook';
	id: string;
	name: string;
	sessionId: string;
	documents: string[];
	loopEnabled: boolean;
	maxLoops?: number | null;
}

// Union type of all events
export type CliEvent =
	| StartEvent
	| DocumentStartEvent
	| TaskStartEvent
	| TaskCompleteEvent
	| DocumentCompleteEvent
	| LoopCompleteEvent
	| CompleteEvent
	| ErrorEvent
	| GroupEvent
	| AgentEvent
	| PlaybookEvent;

/**
 * Emit a JSONL event to stdout
 */
export function emitJsonl(event: { type: string; [key: string]: unknown }): void {
	const fullEvent = {
		...event,
		timestamp: Date.now(),
	};
	console.log(JSON.stringify(fullEvent));
}

/**
 * Emit an error event
 */
export function emitError(message: string, code?: string): void {
	emitJsonl({ type: 'error', message, code });
}

/**
 * Emit a start event
 */
export function emitStart(
	playbook: { id: string; name: string },
	session: { id: string; name: string; cwd: string }
): void {
	emitJsonl({ type: 'start', playbook, session });
}

/**
 * Emit a document start event
 */
export function emitDocumentStart(document: string, index: number, taskCount: number): void {
	emitJsonl({ type: 'document_start', document, index, taskCount });
}

/**
 * Emit a task start event
 */
export function emitTaskStart(document: string, taskIndex: number): void {
	emitJsonl({ type: 'task_start', document, taskIndex });
}

/**
 * Emit a task complete event
 */
export function emitTaskComplete(
	document: string,
	taskIndex: number,
	success: boolean,
	summary: string,
	elapsedMs: number,
	options?: {
		fullResponse?: string;
		usageStats?: UsageStats;
		agentSessionId?: string;
	}
): void {
	emitJsonl({
		type: 'task_complete',
		document,
		taskIndex,
		success,
		summary,
		elapsedMs,
		...options,
	});
}

/**
 * Emit a document complete event
 */
export function emitDocumentComplete(document: string, tasksCompleted: number): void {
	emitJsonl({ type: 'document_complete', document, tasksCompleted });
}

/**
 * Emit a loop complete event
 */
export function emitLoopComplete(
	iteration: number,
	tasksCompleted: number,
	elapsedMs: number,
	usageStats?: UsageStats
): void {
	emitJsonl({ type: 'loop_complete', iteration, tasksCompleted, elapsedMs, usageStats });
}

/**
 * Emit a complete event
 */
export function emitComplete(
	success: boolean,
	totalTasksCompleted: number,
	totalElapsedMs: number,
	totalCost?: number
): void {
	emitJsonl({ type: 'complete', success, totalTasksCompleted, totalElapsedMs, totalCost });
}

/**
 * Emit a group event (for list groups)
 */
export function emitGroup(group: {
	id: string;
	name: string;
	emoji: string;
	collapsed: boolean;
}): void {
	emitJsonl({ type: 'group', ...group });
}

/**
 * Emit an agent event (for list agents)
 */
export function emitAgent(agent: {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	groupId?: string;
	autoRunFolderPath?: string;
}): void {
	emitJsonl({ type: 'agent', ...agent });
}

/**
 * Emit a playbook event (for list playbooks)
 */
export function emitPlaybook(playbook: {
	id: string;
	name: string;
	sessionId: string;
	documents: string[];
	loopEnabled: boolean;
	maxLoops?: number | null;
}): void {
	emitJsonl({ type: 'playbook', ...playbook });
}
