/**
 * The goal-driven Auto Run engine: loop a fresh agent at a goal until it is met, deadlocked,
 * stalled, or out of iterations, and yield events.
 *
 * The CLI's goal runner moved into the library (`Plans/maestro-tui-autorun-engine.md`, AE1). It
 * drives the same pure goal rules the desktop's `useGoalRunner` hook does (`src/shared/goalDriven/`):
 * each iteration runs a fresh agent with the `autorun-goal` prompt (goal, exit criteria, and
 * iteration number substituted in), parses the agent's self-reported progress markers, records
 * the iteration, and asks the exit evaluator whether to continue. This file supplies the loop and
 * the ports it runs on; the decisions are shared so the surfaces behave alike.
 */

import { hasCapability } from '../providers/capabilities';
import { GOAL_RUN_HARD_ITERATION_CAP } from '../../goalDriven/types';
import type { GoalExitReason, GoalIterationRecord, GoalRunConfig } from '../../goalDriven/types';
import { evaluateGoalExit } from '../../goalDriven/goalExitEvaluator';
import {
	GOAL_SYNOPSIS_REQUEST_PROMPT,
	formatPredecessorHandoff,
	sanitizeHandoffBlurb,
} from '../../goalDriven/goalHandoff';
import { parseGoalMarkers, stripMaestroMarkers } from '../../goalDriven/goalMarkers';
import { formatGoalRunDocumentPath } from '../../goalDriven/goalRunLabel';
import { prependNewSessionMessage } from '../../newSessionMessage';
import { PROMPT_IDS } from '../../promptDefinitions';
import { substituteTemplateVariables, type TemplateContext } from '../../templateVariables';
import type { SessionInfo, UsageStats } from '../../types';
import type { AutoRunDeps, AutoRunEvent } from './engine-types';
import {
	buildGoalFinalEntry,
	buildGoalIterationEntry,
	buildGoalStartEntry,
	summaryUsageStats,
} from './history-entries';

export interface RunGoalOptions {
	/** Write per-iteration + summary entries to History. Default true. */
	writeHistory?: boolean;
	/** Emit a `verbose` event carrying the full per-iteration prompt. */
	verbose?: boolean;
	/**
	 * Run-scoped model override. Wins over `session.customModel` for every spawn
	 * this run makes; the stored session is never modified.
	 */
	model?: string;
	/** Run-scoped reasoning effort override (same contract as `model`). */
	effort?: string;
	/**
	 * Stop the run. The iteration in flight is aborted and the run ends with
	 * `stopped-by-user` (never as a failed iteration).
	 */
	signal?: AbortSignal;
}

/**
 * Derive a short, marker-free synopsis from an iteration's agent output: the
 * first non-empty line of the response with Maestro control markers stripped.
 */
function iterationSynopsis(response: string | undefined, iteration: number): string {
	const cleaned = stripMaestroMarkers(response ?? '').trim();
	const firstLine = cleaned.split('\n').find((line) => line.trim().length > 0);
	return firstLine?.trim() || `Iteration ${iteration}`;
}

/**
 * Resume a just-finished iteration's session and ask it for a short handoff note
 * for the next iteration (which starts with a fresh context window). Best-effort:
 * any failure resolves to an empty blurb so the loop simply carries the previous
 * note (or none) forward. Returns the note plus the resume call's usage so the
 * run's cumulative token/cost accounting stays accurate.
 */
async function requestHandoffBlurb(
	session: SessionInfo,
	agentSessionId: string,
	deps: AutoRunDeps,
	runOverrides: { model?: string; effort?: string; signal?: AbortSignal } = {}
): Promise<{ blurb: string; usageStats?: UsageStats }> {
	try {
		const result = await deps.turns.run({
			purpose: 'goal-handoff',
			prompt: GOAL_SYNOPSIS_REQUEST_PROMPT,
			resumeSessionId: agentSessionId,
			model: runOverrides.model ?? session.customModel,
			effort: runOverrides.effort ?? session.customEffort,
			signal: runOverrides.signal,
		});
		if (result.success) {
			return { blurb: sanitizeHandoffBlurb(result.response), usageStats: result.usageStats };
		}
	} catch (err) {
		deps.log.warn('[GoalRunner] Handoff synopsis request failed', undefined, err);
	}
	return { blurb: '' };
}

/**
 * Run a Goal-Driven Auto Run for an agent, yielding events.
 *
 * Each iteration runs a FRESH agent (no session resume) so it approaches the
 * goal with clean context, exactly like the desktop runner. SSH and per-agent
 * overrides (model/effort/args/env) are the turn runner's to thread into every
 * spawn.
 */
export async function* runGoal(
	session: SessionInfo,
	goalConfig: GoalRunConfig,
	options: RunGoalOptions,
	deps: AutoRunDeps
): AsyncGenerator<AutoRunEvent> {
	const {
		writeHistory = true,
		verbose = false,
		model: runModel,
		effort: runEffort,
		signal,
	} = options;
	const { clock, log } = deps;
	const runStartTime = clock.now();

	const gitBranch = await deps.environment.gitBranch(session.cwd);
	const isGit = await deps.environment.isGitRepo(session.cwd);
	const groupName = await deps.environment.groupName(session.groupId);

	// Surface this run to the desktop app and other processes as busy.
	deps.activity.begin({
		agentId: session.id,
		playbookId: 'goal-run',
		playbookName: formatGoalRunDocumentPath(goalConfig.goal),
		startedAt: runStartTime,
	});

	try {
		const goalPromptTemplate = await deps.prompts.get(PROMPT_IDS.AUTORUN_GOAL);
		await deps.turns.prepare?.();

		yield {
			type: 'goal_start',
			timestamp: runStartTime,
			goal: goalConfig.goal,
			exitCriteria: goalConfig.exitCriteria,
			maxIterations: goalConfig.maxIterations,
			session: { id: session.id, name: session.name, cwd: session.cwd },
		};

		// Immediate start marker (mirrors the desktop start-of-run History entry):
		// captures the driving prompts up front, even if the run is killed early.
		if (writeHistory) {
			await deps.history.append(buildGoalStartEntry(session, runStartTime, goalConfig));
		}

		const history: GoalIterationRecord[] = [];
		let iteration = 0;
		// Handoff note carried from the previous iteration's session into the next
		// (fresh-context) iteration's prompt. Empty for the first iteration.
		let predecessorBlurb = '';
		let finalProgress = 0;
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCost = 0;
		let exitReason: GoalExitReason = 'stopped-by-user';
		let exitDetail = 'Stopped before any iteration completed.';

		while (true) {
			// Absolute safety bound for infinite runs (matches the desktop cap).
			if (goalConfig.maxIterations === null && iteration >= GOAL_RUN_HARD_ITERATION_CAP) {
				exitReason = 'max-iterations';
				exitDetail = `Safety limit reached: stopped after ${GOAL_RUN_HARD_ITERATION_CAP} iterations without completion, deadlock, or stall.`;
				break;
			}

			// The operator stopped the run between iterations.
			if (signal?.aborted) {
				exitReason = 'stopped-by-user';
				if (iteration > 0) exitDetail = `Stopped by the operator after iteration ${iteration}.`;
				break;
			}

			iteration++;

			const templateContext: TemplateContext = {
				session,
				gitBranch: isGit ? gitBranch : undefined,
				groupName,
				groupId: session.groupId,
				autoRunFolder: session.autoRunFolderPath,
				loopNumber: iteration,
				goal: goalConfig.goal,
				goalExitCriteria: goalConfig.exitCriteria,
				predecessorHandoff: formatPredecessorHandoff(predecessorBlurb),
			};
			// Each goal iteration spawns a fresh provider session, so prefix the
			// agent's New Session Message onto every spawn (matches interactive behavior).
			const prompt = prependNewSessionMessage(
				substituteTemplateVariables(goalPromptTemplate, templateContext),
				session.newSessionMessage
			);

			if (verbose) {
				yield {
					type: 'verbose',
					timestamp: clock.now(),
					category: 'prompt',
					iteration,
					prompt,
				};
			}

			yield { type: 'goal_iteration_start', timestamp: clock.now(), iteration };

			const iterationStart = clock.now();
			const result = await deps.turns.run({
				purpose: 'goal-iteration',
				prompt,
				model: runModel ?? session.customModel,
				effort: runEffort ?? session.customEffort,
				signal,
			});
			const elapsedMs = clock.now() - iterationStart;

			if (result.usageStats) {
				totalInputTokens += result.usageStats.inputTokens || 0;
				totalOutputTokens += result.usageStats.outputTokens || 0;
				totalCost += result.usageStats.totalCostUsd || 0;
			}

			// Interrupted mid-iteration: there is no self-report to parse, and
			// recording "Iteration N failed" would misdescribe a deliberate stop.
			if (result.outcome === 'interrupted') {
				exitReason = 'stopped-by-user';
				exitDetail = `Stopped by the operator during iteration ${iteration}.`;
				break;
			}

			// Parse the agent's self-report. A missing marker carries the previous
			// raw value forward (0 on the first iteration).
			const markers = parseGoalMarkers(result.response ?? '');
			const reportedProgress =
				markers.progress ?? (history.length > 0 ? history[history.length - 1].progress : 0);
			// Displayed progress is a monotonic high-water mark; the exit evaluator
			// below uses the RAW reported value so a single dip can't freeze a stall.
			const displayProgress = Math.max(finalProgress, reportedProgress);
			finalProgress = displayProgress;

			history.push({
				iteration,
				progress: reportedProgress,
				rationale: markers.rationale,
				complete: markers.complete,
				deadlock: markers.deadlock,
				deadlockReason: markers.deadlockReason,
			});

			const synopsis = result.success
				? iterationSynopsis(result.response, iteration)
				: result.error || `Iteration ${iteration} failed`;
			const rationaleText = markers.rationale?.trim();
			const iterationSummary = `Goal progress: ${displayProgress}% - ${rationaleText || synopsis}`;

			if (writeHistory) {
				await deps.history.append(
					buildGoalIterationEntry(session, {
						now: clock.now(),
						summary: iterationSummary,
						// Strip internal `<!-- maestro:... -->` control markers before storing
						// so they never enter history or leak into any render surface.
						fullResponse: stripMaestroMarkers(
							result.success
								? result.response || synopsis
								: result.error || result.response || synopsis
						),
						agentSessionId: result.agentSessionId,
						success: result.success,
						usageStats: result.usageStats,
						elapsedMs,
					})
				);
			}

			yield {
				type: 'goal_iteration_complete',
				timestamp: clock.now(),
				iteration,
				progress: displayProgress,
				reportedProgress,
				rationale: markers.rationale ?? undefined,
				complete: markers.complete,
				deadlock: markers.deadlock,
				success: result.success,
				summary: iterationSummary,
				elapsedMs,
				usageStats: result.usageStats,
			};

			// Pure decision: completion / deadlock / max-iterations / stall.
			const decision = evaluateGoalExit(history, goalConfig);
			if (decision.action === 'stop') {
				exitReason = decision.reason;
				exitDetail = decision.detail;
				break;
			}

			// Continuing: resume this iteration's session to capture a handoff note
			// for the next (fresh-context) iteration. Gated on the agent supporting
			// resume - without it the resumed "session" has no context and the note
			// would be worthless, so we'd rather carry nothing forward. A successful
			// iteration with no session id (shouldn't happen for resumable agents)
			// also skips it.
			if (
				result.success &&
				result.agentSessionId &&
				hasCapability(session.toolType, 'supportsResume')
			) {
				if (verbose) {
					yield {
						type: 'verbose',
						timestamp: clock.now(),
						category: 'handoff-prompt',
						iteration,
						prompt: GOAL_SYNOPSIS_REQUEST_PROMPT,
					};
				}
				const handoff = await requestHandoffBlurb(session, result.agentSessionId, deps, {
					model: runModel,
					effort: runEffort,
					signal,
				});
				if (handoff.usageStats) {
					totalInputTokens += handoff.usageStats.inputTokens || 0;
					totalOutputTokens += handoff.usageStats.outputTokens || 0;
					totalCost += handoff.usageStats.totalCostUsd || 0;
				}
				// Only overwrite when we got something usable; otherwise keep the
				// previous note rather than blanking the next iteration's handoff.
				if (handoff.blurb) {
					predecessorBlurb = handoff.blurb;
				}
			}
		}

		const totalElapsedMs = clock.now() - runStartTime;
		const isSuccess = exitReason === 'completed';
		const usageStats = summaryUsageStats(totalInputTokens, totalOutputTokens, totalCost);

		if (writeHistory) {
			await deps.history.append(
				buildGoalFinalEntry(session, clock.now(), {
					exitReason,
					exitDetail,
					finalProgress,
					iterations: iteration,
					totalElapsedMs,
					goal: goalConfig.goal,
					usageStats,
				})
			);
		}

		log.autorun(`Goal-Driven Auto Run finished: ${exitReason}`, session.name, {
			iterations: iteration,
			finalProgress,
			exitReason,
		});

		yield {
			type: 'goal_complete',
			timestamp: clock.now(),
			success: isSuccess,
			exitReason,
			exitDetail,
			finalProgress,
			iterations: iteration,
			totalElapsedMs,
			totalCost,
			usageStats,
		};
	} finally {
		deps.activity.end(session.id);
	}
}
