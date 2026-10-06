/**
 * Pianola orchestrator - one iteration of the multi-agent coordination loop.
 *
 * This is the pure coordinator that drives a task DAG to completion, the sibling
 * of the watcher (pianola-watcher.ts). It consumes the DAG primitives in
 * pianola-tasks.ts (it never reimplements readiness, status transitions, blocked
 * propagation, or progress) and the verdict in pianola-completion-detector.ts to
 * decide whether a running task finished. One call advances the plan by a single
 * tick: it polls running tasks, settles done/failed, cascades blocked, then fills
 * free concurrency slots with newly-ready work.
 *
 * All side effects are injected through OrchestratorDeps, so the engine is
 * unit-testable without a desktop app, network, or filesystem, and the same logic
 * can back the CLI shell and a future in-app daemon. The CLI shell is the only
 * thing that loops: it calls runOrchestratorIteration, persists the returned
 * plan, sleeps, and stops when `done` flips true.
 *
 * Immutable by contract: the plan is rebuilt via markTaskStatus / propagateBlocked
 * on every change; the input state is never mutated. Audit-style failure handling:
 * an expected agent or dispatch failure is logged and the task is left pending to
 * retry next iteration; only genuinely unexpected errors propagate.
 *
 * Runtime-agnostic: no fs, no Electron, no Node, no app state, no renderer types.
 */

import type { AgentRunState } from './pianola-completion-detector';
import { detectTaskOutcome } from './pianola-completion-detector';
import type { PianolaPlan, PianolaPlanProgress, PianolaTask } from './pianola-tasks';
import { computeReadyTasks, markTaskStatus, planProgress, propagateBlocked } from './pianola-tasks';
import type { PianolaMessage } from './types';

export type { AgentRunState } from './pianola-completion-detector';

/** Bounded auto-fix attempts before a needs_review task escalates (F8 / ISC-8.8). */
const MAX_FIX_ATTEMPTS = 3;

/**
 * The carried state of an orchestration run: the live plan plus the last observed
 * run state per task id. prevStates is what lets the completion detector see a
 * working-to-idle transition across iterations (a busy task that has since gone
 * idle is a completion signal).
 */
export interface OrchestratorState {
	plan: PianolaPlan;
	prevStates: Record<string, AgentRunState>;
}

/** Seed orchestration state from a plan, with no prior run states observed yet. */
export function initialOrchestratorState(plan: PianolaPlan): OrchestratorState {
	return { plan, prevStates: {} };
}

/**
 * The ledger view of a task's captured run (F8 / ISC-8.3). Lets the engine
 * settle a task on real checks/reviews/merge instead of busy-to-idle alone
 * (ISC-8.4). All fields optional so a run with no producers still resolves.
 */
export interface PianolaTaskLedger {
	runId?: string;
	checksPassed?: boolean;
	openCriticalOrHighFindings?: number;
	openFindings?: number;
	pullRequestUrl?: string;
	merged?: boolean;
}

/** Injected side effects. Everything the engine touches that is not pure data. */
export interface OrchestratorDeps {
	/** Observe an agent's current run state for a dispatched (running) task. */
	getRunState: (task: PianolaTask) => Promise<AgentRunState>;
	/** Read the tail of a running task's transcript, chronological (oldest first). */
	getRecentMessages: (task: PianolaTask) => Promise<readonly PianolaMessage[]>;
	/** Reuse task.agentId or create an agent for the task. Returns the bound id/type or an error. */
	ensureAgent: (
		task: PianolaTask
	) => Promise<{ agentId: string; agentType?: string } | { error: string }>;
	/** Send the task's prompt to the bound agent, returning success and the tab it landed in. */
	dispatch: (
		task: PianolaTask,
		agentId: string
	) => Promise<{ success: boolean; tabId?: string; error?: string }>;
	/** Persist the updated plan once per iteration (called at the end with the final plan). */
	persist: (plan: PianolaPlan) => void;
	/** Human-readable progress line. */
	log: (line: string) => void;
	/** Push a failure notification to the user's attention. Optional. */
	notify?: (event: { kind: 'task_failed'; task: PianolaTask }) => void | Promise<void>;
	/**
	 * F8 reactive loop master gate (ISC-8.12/8.13). Read fresh each iteration by
	 * the CLI (encore.pianola && encore.autopilot). When absent or false, the
	 * engine runs NO auto-fix/auto-merge and behaves as the current supervisor.
	 */
	reactiveEnabled?: () => boolean;
	/**
	 * F8: read the captured AgentRun ledger for a task (checks/reviews/merge).
	 * Optional: when absent the engine falls back to busy-to-idle detection.
	 */
	getRunLedger?: (task: PianolaTask) => Promise<PianolaTaskLedger | undefined>;
	/**
	 * F8 reactive loop (optional, gated by the CLI on encore/autopilot): dispatch
	 * a bounded fix agent for a task whose run needs review. Returns success.
	 */
	dispatchFix?: (
		task: PianolaTask,
		ledger: PianolaTaskLedger
	) => Promise<{ success: boolean; error?: string }>;
	/**
	 * F8 reactive loop (optional, gated + risk-rated + audited): request a merge
	 * for a green task's run. Returns whether the merge was requested.
	 */
	requestMerge?: (
		task: PianolaTask,
		ledger: PianolaTaskLedger
	) => Promise<{ merged: boolean; error?: string }>;
}

/** Structured outcome of a single orchestration tick. */
export interface OrchestratorIterationResult {
	state: OrchestratorState;
	progress: PianolaPlanProgress;
	/** Tasks that settled to 'done' this iteration. */
	completedTaskIds: string[];
	/** Tasks that settled to 'failed' this iteration. */
	failedTaskIds: string[];
	/** Tasks that were dispatched (moved to 'running') this iteration. */
	dispatchedTaskIds: string[];
	/** True when nothing can still run (every task terminal or blocked). */
	done: boolean;
}

/** Fire a failure notification, swallowing errors so a notify failure never breaks the loop. */
async function safeNotify(deps: OrchestratorDeps, task: PianolaTask): Promise<void> {
	if (!deps.notify) return;
	try {
		await deps.notify({ kind: 'task_failed', task });
	} catch {
		// A failed toast must not crash autonomous orchestration; the plan stands.
	}
}

/**
 * Run one orchestration tick. Pure aside from the injected deps: it polls running
 * tasks, settles done/failed, cascades blocked, dispatches up to the concurrency
 * limit, persists once, and reports progress. Never throws for an expected agent
 * or dispatch failure - those are logged and the task is left pending to retry.
 */
export async function runOrchestratorIteration(
	state: OrchestratorState,
	deps: OrchestratorDeps,
	options: { concurrencyLimit: number }
): Promise<OrchestratorIterationResult> {
	let plan = state.plan;
	const completedTaskIds: string[] = [];
	const failedTaskIds: string[] = [];
	const dispatchedTaskIds: string[] = [];

	// 1. Poll running tasks. Carry forward only the run states we actually observe
	//    this tick, keyed by task id, so prevStates reflects reality next iteration.
	const prevStates: Record<string, AgentRunState> = {};
	// Poll running AND fixing tasks: a fix agent is a live run whose completion is
	// detected the same way (F8). When a fixing task finishes it settles via the
	// same ledger gate below, re-entering needs_review or done.
	const running = plan.tasks.filter(
		(task) => task.status === 'running' || task.status === 'fixing'
	);
	for (const task of running) {
		const currentState = await deps.getRunState(task);
		const recentMessages = await deps.getRecentMessages(task);
		prevStates[task.id] = currentState;
		const { outcome, reason } = detectTaskOutcome({
			previousState: state.prevStates[task.id],
			currentState,
			recentMessages,
		});
		if (outcome === 'done') {
			// F8 (ISC-8.4): settle on the ledger, not busy-to-idle alone. Open
			// critical/high findings route the task to needs_review instead of done.
			const ledger = deps.getRunLedger ? await deps.getRunLedger(task) : undefined;
			if (ledger && (ledger.openCriticalOrHighFindings ?? 0) > 0) {
				plan = markTaskStatus(plan, task.id, 'needs_review', { runId: ledger.runId });
				deps.log(
					`[orchestrator] task "${task.id}" needs_review (${ledger.openCriticalOrHighFindings} open findings)`
				);
			} else if (ledger && ledger.checksPassed === false) {
				plan = markTaskStatus(plan, task.id, 'needs_review', { runId: ledger.runId });
				deps.log(`[orchestrator] task "${task.id}" needs_review (checks failing)`);
			} else {
				plan = markTaskStatus(plan, task.id, 'done', { runId: ledger?.runId });
				completedTaskIds.push(task.id);
				deps.log(`[orchestrator] task "${task.id}" done (${reason})`);
			}
		} else if (outcome === 'failed') {
			plan = markTaskStatus(plan, task.id, 'failed', { error: reason });
			failedTaskIds.push(task.id);
			deps.log(`[orchestrator] task "${task.id}" failed (${reason})`);
			// Notify against the failed task as it now stands in the rebuilt plan.
			const failedTask = plan.tasks.find((t) => t.id === task.id) ?? task;
			await safeNotify(deps, failedTask);
		}
		// 'working': leave it running; its current state is recorded for next tick.
	}

	// 2. Cascade blocked: any task whose dependency just failed (or was already
	//    blocked) becomes blocked, to a fixed point.
	plan = propagateBlocked(plan);

	// 2b. F8 reactive loop: drive needs_review tasks through a bounded fix cycle,
	//     and settle green tasks. The whole pass is gated by reactiveEnabled
	//     (ISC-8.12/8.13): with it off (or absent), Pianola behaves exactly as the
	//     current supervisor - no auto-fix, no auto-merge. Risk-rating + audit live
	//     in the dep implementations (ISC-8.9/8.10).
	if (deps.reactiveEnabled?.() === true) {
		for (const task of plan.tasks.filter((t) => t.status === 'needs_review')) {
			const ledger = deps.getRunLedger ? await deps.getRunLedger(task) : undefined;
			// Fully green (zero open findings of ANY severity AND checks passed): the
			// review work succeeded. Attempt a merge ONCE, then settle to done
			// regardless of the merge outcome (recorded on the run) so the task
			// leaves needs_review and does not re-attempt every tick. Anything less
			// than fully green falls through to the fix cycle below.
			if (ledger && (ledger.openFindings ?? 0) === 0 && ledger.checksPassed === true) {
				if (deps.requestMerge) {
					const merge = await deps.requestMerge(task, ledger);
					deps.log(
						merge.merged
							? `[orchestrator] task "${task.id}" merged + done`
							: `[orchestrator] task "${task.id}" done (merge not performed: ${merge.error ?? 'n/a'})`
					);
				} else {
					deps.log(`[orchestrator] task "${task.id}" done (review resolved, no merger wired)`);
				}
				plan = markTaskStatus(plan, task.id, 'done', { runId: ledger.runId });
				completedTaskIds.push(task.id);
				continue;
			}
			// Still needs work: dispatch a bounded fix, or escalate when capped.
			const attempts = task.fixAttempts ?? 0;
			if (attempts >= MAX_FIX_ATTEMPTS) {
				plan = markTaskStatus(plan, task.id, 'failed', {
					error: `fix loop exhausted after ${attempts} attempts; escalated to user`,
				});
				failedTaskIds.push(task.id);
				await safeNotify(deps, plan.tasks.find((t) => t.id === task.id) ?? task);
				deps.log(`[orchestrator] task "${task.id}" escalated (fix loop exhausted)`);
				continue;
			}
			if (deps.dispatchFix && ledger) {
				const fix = await deps.dispatchFix(task, ledger);
				if (fix.success) {
					plan = markTaskStatus(plan, task.id, 'fixing', {
						runId: ledger.runId,
						fixAttempts: attempts + 1,
					});
					deps.log(`[orchestrator] task "${task.id}" fixing (attempt ${attempts + 1})`);
				} else {
					deps.log(
						`[orchestrator] task "${task.id}" fix dispatch failed (${fix.error ?? 'unknown'})`
					);
				}
			}
		}
	}

	// 3. Dispatch newly-ready work into free concurrency slots. Re-check the running
	//    count as we go so we never exceed concurrencyLimit within one iteration.
	// Both running and fixing tasks occupy a concurrency slot (each is a live agent).
	let runningCount = plan.tasks.filter(
		(task) => task.status === 'running' || task.status === 'fixing'
	).length;
	const ready = computeReadyTasks(plan);
	for (const task of ready) {
		if (runningCount >= options.concurrencyLimit) break;

		const agentResult = await deps.ensureAgent(task);
		if ('error' in agentResult) {
			// Expected failure: no agent available yet. Leave pending; retry next tick.
			deps.log(`[orchestrator] task "${task.id}" pending (ensureAgent: ${agentResult.error})`);
			continue;
		}

		const res = await deps.dispatch(task, agentResult.agentId);
		if (!res.success) {
			// Expected failure: dispatch did not land. Persist the agent we just
			// bound onto the still-pending task so the retry next tick REUSES it via
			// ensureAgent's `task.agentId` short-circuit, instead of creating (and
			// orphaning) a fresh session every iteration. The slot is not consumed,
			// so another ready task can take it.
			plan = markTaskStatus(plan, task.id, 'pending', {
				agentId: agentResult.agentId,
				agentType: agentResult.agentType,
			});
			deps.log(
				`[orchestrator] task "${task.id}" pending (dispatch failed: ${res.error ?? 'unknown error'})`
			);
			continue;
		}

		plan = markTaskStatus(plan, task.id, 'running', {
			agentId: agentResult.agentId,
			agentType: agentResult.agentType,
			tabId: res.tabId,
		});
		// Seed the just-dispatched task as 'connecting' (its honest just-spun-up
		// state) so the next iteration's poll can detect the working-to-idle
		// transition. Without this seed, a task that shows idle on its very first
		// post-dispatch poll has no prior working state to compare against and would
		// never be detected as done.
		prevStates[task.id] = 'connecting';
		dispatchedTaskIds.push(task.id);
		runningCount += 1;
		deps.log(`[orchestrator] task "${task.id}" dispatched to agent "${agentResult.agentId}"`);
	}

	// 4. Persist the final plan for this iteration, once.
	deps.persist(plan);

	// 5. Report progress and the new carried state.
	const progress = planProgress(plan);
	return {
		state: { plan, prevStates },
		progress,
		completedTaskIds,
		failedTaskIds,
		dispatchedTaskIds,
		done: progress.complete,
	};
}
