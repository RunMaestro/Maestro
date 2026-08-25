/**
 * Agent task list extraction.
 *
 * Several agents expose an internal checklist through a tool call: Claude Code
 * and OpenCode emit `TodoWrite` with a `todos` array, Codex emits `update_plan`
 * with a `plan` array. The shapes differ slightly but they all boil down to
 * "list of items, each with a label and a pending/in-progress/completed state".
 *
 * This module normalizes those shapes so the chat history can render one
 * agent-agnostic task list card instead of a per-agent special case. Detection
 * is driven by the payload shape, not the tool name, so a new agent that emits
 * the same structure gets the richer rendering for free.
 */

import type { LogEntry } from '../types';

/** Normalized task state shared by every agent's checklist format. */
export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentTask {
	/** Label shown in the list (the task's own wording, unmodified). */
	content: string;
	status: AgentTaskStatus;
	/**
	 * Present-tense phrasing for the active task when the agent supplies one
	 * (Claude Code's `activeForm`). Used for the collapsed one-line summary.
	 */
	activeForm?: string;
}

export interface AgentTaskList {
	tasks: AgentTask[];
	/** Number of tasks in the `completed` state. */
	completed: number;
	/** First task in the `in_progress` state, if any. */
	inProgress: AgentTask | null;
}

/** Keys whose array value may hold a checklist, in priority order. */
const TASK_ARRAY_KEYS = ['todos', 'plan', 'tasks'] as const;

/** Keys that may hold an individual task's label, in priority order. */
const CONTENT_KEYS = ['content', 'step', 'title', 'task', 'description', 'text'] as const;

/**
 * Map an agent-supplied status onto the three normalized states. Unknown or
 * missing values fall back to `pending` so a task is never silently dropped.
 */
function normalizeStatus(value: unknown): AgentTaskStatus {
	if (typeof value !== 'string') return 'pending';
	const normalized = value.toLowerCase().replace(/[\s-]/g, '_');
	if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') {
		return 'completed';
	}
	if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'active') {
		return 'in_progress';
	}
	return 'pending';
}

/** Pull the first non-empty string among CONTENT_KEYS off a task-ish object. */
function extractContent(item: Record<string, unknown>): string | null {
	for (const key of CONTENT_KEYS) {
		const value = item[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

/**
 * Normalize a raw array into a task list. Returns null when the array does not
 * look like a checklist, so callers can fall back to generic tool rendering.
 */
function normalizeTaskArray(value: unknown): AgentTaskList | null {
	if (!Array.isArray(value) || value.length === 0) return null;

	const tasks: AgentTask[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
		const item = raw as Record<string, unknown>;
		const content = extractContent(item);
		// Every entry must carry a label - a partial list would misreport progress.
		if (!content) return null;
		const activeForm = typeof item.activeForm === 'string' ? item.activeForm.trim() : '';
		tasks.push({
			content,
			status: normalizeStatus(item.status),
			...(activeForm ? { activeForm } : {}),
		});
	}

	return {
		tasks,
		completed: tasks.filter((t) => t.status === 'completed').length,
		inProgress: tasks.find((t) => t.status === 'in_progress') ?? null,
	};
}

/**
 * Extract a normalized task list from a tool call's input payload, or null when
 * the payload isn't a checklist.
 */
export function extractAgentTaskList(input: unknown): AgentTaskList | null {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
	const record = input as Record<string, unknown>;
	for (const key of TASK_ARRAY_KEYS) {
		const list = normalizeTaskArray(record[key]);
		if (list) return list;
	}
	return null;
}

/**
 * One-line summary of a task list: the active task (preferring its present-tense
 * `activeForm`) plus a completed/total count. Falls back to the first task when
 * nothing is in progress.
 */
export function summarizeAgentTaskList(list: AgentTaskList): string {
	const { tasks, completed, inProgress } = list;
	const label = inProgress?.activeForm || inProgress?.content || tasks[0]?.content;
	if (!label) return `${tasks.length} tasks`;
	return `${label} (${completed}/${tasks.length})`;
}

/** A checklist plus the log entry it came from. */
export interface LatestAgentTaskList {
	/**
	 * Id of the tool entry the checklist was read from. The docked bar keys its
	 * dismissal off this, so dismissing hides that one list and the next
	 * checklist the agent writes brings the bar back.
	 */
	entryId: string;
	list: AgentTaskList;
}

/**
 * Newest checklist in a tab's conversation, or null when the agent has not
 * written one. Agents rewrite the whole list on every update, so the last
 * checklist-shaped tool call in the log IS the current state - there is nothing
 * to merge across entries.
 *
 * Checklists written INSIDE a subagent (`metadata.parentToolUseId`) are skipped.
 * A delegated worker keeps its own private plan, and it is written last, so
 * without this guard a Task tool call would replace the plan the user is
 * actually following with a scratch list they never asked to see.
 */
export function findLatestAgentTaskList(
	logs: readonly LogEntry[] | undefined
): LatestAgentTaskList | null {
	if (!logs) return null;
	for (let i = logs.length - 1; i >= 0; i--) {
		const entry = logs[i];
		if (entry.metadata?.parentToolUseId) continue;
		const toolState = entry.metadata?.toolState;
		if (!toolState || toolState.input === undefined) continue;
		const list = extractAgentTaskList(toolState.input);
		if (list) return { entryId: entry.id, list };
	}
	return null;
}
