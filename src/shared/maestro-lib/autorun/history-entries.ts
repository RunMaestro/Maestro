/**
 * The History rows an Auto Run writes: per task, per loop, the run's final summary, and the
 * goal-driven start, iteration, and final rows.
 *
 * Pure builders. The engine decides when a row is written; the wording lives here so the CLI and
 * the runtime cannot drift. Two strings are contracts with `autoRunHistoryReconciliation.ts`:
 * a summary beginning `Auto Run ` is the run boundary the next run's totals scan back to, and
 * the `Loop N (final) completed` and `Goal ...` wordings are control rows it skips.
 */

import type { GoalExitReason } from '../../goalDriven/types';
import { formatElapsedTime } from '../../formatters';
import type { FinalSummaryTotals } from '../../autoRunHistoryReconciliation';
import type { HistoryEntry, UsageStats } from '../../types';
import { generateUUID } from '../../uuid';

/** The agent fields a row names. */
interface RowAgent {
	id: string;
	cwd: string;
}

/**
 * A cumulative total as a usage record. `contextWindow` is 0: these are sums across turns, not
 * one turn's context size. Absent when nothing was spent.
 */
export function summaryUsageStats(
	inputTokens: number,
	outputTokens: number,
	totalCostUsd: number
): UsageStats | undefined {
	if (inputTokens <= 0 && outputTokens <= 0) return undefined;
	return {
		inputTokens,
		outputTokens,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd,
		contextWindow: 0,
	};
}

export interface LoopTotals {
	tasksCompleted: number;
	elapsedMs: number;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}

/** The row for a task that ran, with its checkbox count so a restart can rebuild exact totals. */
export function buildTaskHistoryEntry(
	agent: RowAgent,
	fields: {
		now: number;
		summary: string;
		fullResponse: string;
		agentSessionId?: string;
		success: boolean;
		usageStats?: UsageStats;
		elapsedMs: number;
		completedTaskCount: number;
	}
): HistoryEntry {
	return {
		id: generateUUID(),
		type: 'AUTO',
		timestamp: fields.now,
		summary: fields.summary,
		fullResponse: fields.fullResponse,
		agentSessionId: fields.agentSessionId,
		projectPath: agent.cwd,
		sessionId: agent.id,
		success: fields.success,
		usageStats: fields.usageStats,
		elapsedTimeMs: fields.elapsedMs,
		completedTaskCount: fields.completedTaskCount,
	};
}

/** The closing row of the last loop, with the reason the loop ended. */
export function buildFinalLoopEntry(
	agent: RowAgent,
	now: number,
	loopNumber: number,
	totals: LoopTotals,
	exitReason: string
): HistoryEntry {
	const tasks = totals.tasksCompleted;
	const hasTokens = totals.inputTokens > 0 || totals.outputTokens > 0;
	const details = [
		`**Loop ${loopNumber} (final) Summary**`,
		'',
		`- **Tasks Accomplished:** ${tasks}`,
		`- **Duration:** ${formatElapsedTime(totals.elapsedMs)}`,
		hasTokens
			? `- **Tokens:** ${(totals.inputTokens + totals.outputTokens).toLocaleString()} (${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out)`
			: '',
		totals.cost > 0 ? `- **Cost:** $${totals.cost.toFixed(4)}` : '',
		`- **Exit Reason:** ${exitReason}`,
	]
		.filter((line) => line !== '')
		.join('\n');

	return {
		id: generateUUID(),
		type: 'AUTO',
		timestamp: now,
		summary: `Loop ${loopNumber} (final) completed: ${tasks} task${tasks !== 1 ? 's' : ''} accomplished`,
		fullResponse: details,
		projectPath: agent.cwd,
		sessionId: agent.id,
		success: true,
		elapsedTimeMs: totals.elapsedMs,
		usageStats: summaryUsageStats(totals.inputTokens, totals.outputTokens, totals.cost),
	};
}

/** The row between two loops. */
export function buildLoopEntry(
	agent: RowAgent,
	now: number,
	loopNumber: number,
	tasksCompleted: number,
	elapsedMs: number,
	usageStats: UsageStats | undefined
): HistoryEntry {
	return {
		id: generateUUID(),
		type: 'AUTO',
		timestamp: now,
		summary: `Loop ${loopNumber} completed: ${tasksCompleted} tasks accomplished`,
		projectPath: agent.cwd,
		sessionId: agent.id,
		success: true,
		elapsedTimeMs: elapsedMs,
		usageStats,
	};
}

/**
 * The run's own summary. Written for EVERY run, and it is the BOUNDARY the next run's
 * aggregation scans back to, so its wording must keep matching `FINAL_AUTORUN_SUMMARY_RE` in
 * `autoRunHistoryReconciliation.ts`.
 */
export function buildAutoRunSummaryEntry(
	agent: RowAgent,
	now: number,
	reconciled: FinalSummaryTotals,
	loopsCompleted: number,
	outcome?: string
): HistoryEntry {
	const summary = outcome
		? `Auto Run ${outcome}`
		: `Auto Run completed: ${reconciled.totalCompletedTasks} tasks in ${loopsCompleted} loop${loopsCompleted !== 1 ? 's' : ''}`;
	const hasTokens = reconciled.totalInputTokens > 0 || reconciled.totalOutputTokens > 0;
	const details = [
		`**Auto Run Summary**`,
		'',
		`- **Total Tasks Completed:** ${reconciled.totalCompletedTasks}`,
		`- **Loops Completed:** ${loopsCompleted}`,
		`- **Total Duration:** ${formatElapsedTime(reconciled.totalElapsedMs)}`,
		hasTokens
			? `- **Total Tokens:** ${(reconciled.totalInputTokens + reconciled.totalOutputTokens).toLocaleString()} (${reconciled.totalInputTokens.toLocaleString()} in / ${reconciled.totalOutputTokens.toLocaleString()} out)`
			: '',
		reconciled.totalCost > 0 ? `- **Total Cost:** $${reconciled.totalCost.toFixed(4)}` : '',
	]
		.filter((line) => line !== '')
		.join('\n');

	return {
		id: generateUUID(),
		type: 'AUTO',
		timestamp: now,
		summary,
		fullResponse: details,
		projectPath: agent.cwd,
		sessionId: agent.id,
		success: true,
		elapsedTimeMs: reconciled.totalElapsedMs,
		usageStats: summaryUsageStats(
			reconciled.totalInputTokens,
			reconciled.totalOutputTokens,
			reconciled.totalCost
		),
	};
}

/**
 * The row an error pause leaves, so a run parked overnight explains itself in History. `Auto Run
 * error:` is a control row (`CONTROL_SUMMARY_PREFIXES`), so it never counts as a task.
 */
export function buildErrorPauseEntry(
	agent: RowAgent,
	now: number,
	fields: { title: string; where: string; message: string }
): HistoryEntry {
	return {
		id: generateUUID(),
		type: 'AUTO',
		timestamp: now,
		summary: `Auto Run error: ${fields.title} (${fields.where})`,
		fullResponse: [`**Auto Run Paused On An Error**`, ``, fields.message].join('\n'),
		projectPath: agent.cwd,
		sessionId: agent.id,
		success: false,
	};
}

/** Human label for a goal run's exit reason. */
export function goalExitReasonLabel(reason: GoalExitReason): string {
	switch (reason) {
		case 'completed':
			return 'Goal completed';
		case 'deadlock':
			return 'Goal run deadlocked';
		case 'max-iterations':
			return 'Goal run hit iteration limit';
		case 'stalled':
			return 'Goal run stalled';
		case 'stopped-by-user':
			return 'Goal run stopped';
	}
}

/** The immediate marker at the start of a goal run: the driving prompts, even if the run dies early. */
export function buildGoalStartEntry(
	agent: RowAgent,
	startedAt: number,
	goal: { goal: string; exitCriteria: string; maxIterations: number | null }
): HistoryEntry {
	const trimmedExit = goal.exitCriteria.trim();
	return {
		id: generateUUID(),
		type: 'AUTO',
		timestamp: startedAt,
		summary: 'Goal-Driven Auto Run started',
		fullResponse: [
			`**Goal-Driven Auto Run Started**`,
			``,
			`- **Goal:** ${goal.goal}`,
			`- **Exit Criteria:** ${trimmedExit || '_(none specified)_'}`,
			`- **Iteration Limit:** ${goal.maxIterations ?? 'Infinite'}`,
			`- **Started:** ${new Date(startedAt).toLocaleString()}`,
		].join('\n'),
		projectPath: agent.cwd,
		sessionId: agent.id,
	};
}

/** The row for one goal iteration. */
export function buildGoalIterationEntry(
	agent: RowAgent,
	fields: {
		now: number;
		summary: string;
		fullResponse: string;
		agentSessionId?: string;
		success: boolean;
		usageStats?: UsageStats;
		elapsedMs: number;
	}
): HistoryEntry {
	return {
		id: generateUUID(),
		type: 'AUTO',
		timestamp: fields.now,
		summary: fields.summary,
		fullResponse: fields.fullResponse,
		agentSessionId: fields.agentSessionId,
		projectPath: agent.cwd,
		sessionId: agent.id,
		success: fields.success,
		usageStats: fields.usageStats,
		elapsedTimeMs: fields.elapsedMs,
	};
}

/** The closing row of a goal run. */
export function buildGoalFinalEntry(
	agent: RowAgent,
	now: number,
	fields: {
		exitReason: GoalExitReason;
		exitDetail: string;
		finalProgress: number;
		iterations: number;
		totalElapsedMs: number;
		goal: string;
		usageStats?: UsageStats;
	}
): HistoryEntry {
	const label = goalExitReasonLabel(fields.exitReason);
	return {
		id: generateUUID(),
		type: 'AUTO',
		timestamp: now,
		summary: `${label} (${fields.finalProgress}%)`,
		fullResponse: [
			`**Goal-Driven Auto Run Summary**`,
			``,
			`- **Status:** ${label}`,
			`- **Reason:** ${fields.exitDetail}`,
			`- **Final Progress:** ${fields.finalProgress}%`,
			`- **Iterations:** ${fields.iterations}`,
			`- **Total Duration:** ${formatElapsedTime(fields.totalElapsedMs)}`,
			`- **Goal:** ${fields.goal}`,
		].join('\n'),
		projectPath: agent.cwd,
		sessionId: agent.id,
		success: fields.exitReason === 'completed',
		elapsedTimeMs: fields.totalElapsedMs,
		usageStats: fields.usageStats,
	};
}
