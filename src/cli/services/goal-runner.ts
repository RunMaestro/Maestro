// Goal-Driven Auto Run engine for the CLI.
//
// The CLI counterpart to the desktop `useGoalRunner` hook
// (src/renderer/hooks/batch/internal/useGoalRunner.ts). Both drive the SAME pure
// goal engine in src/shared/goalDriven/*: each iteration spawns a fresh agent
// with the `autorun-goal` prompt (goal + exit criteria + iteration number
// substituted in), parses the agent's self-reported progress markers, records
// the iteration, and asks the pure exit evaluator whether to continue. This file
// supplies the CLI's spawn/loop/IO primitives; the decision logic is shared so
// CLI and desktop behave identically.

import type { SessionInfo, HistoryEntry, UsageStats } from '../../shared/types';
import type { JsonlEvent } from '../output/jsonl';
import type {
	GoalRunConfig,
	GoalIterationRecord,
	GoalExitReason,
} from '../../shared/goalDriven/types';
import { GOAL_RUN_HARD_ITERATION_CAP } from '../../shared/goalDriven/types';
import { parseGoalMarkers, stripMaestroMarkers } from '../../shared/goalDriven/goalMarkers';
import { evaluateGoalExit } from '../../shared/goalDriven/goalExitEvaluator';
import { formatGoalRunDocumentPath } from '../../shared/goalDriven/goalRunLabel';
import {
	GOAL_SYNOPSIS_REQUEST_PROMPT,
	formatPredecessorHandoff,
	sanitizeHandoffBlurb,
} from '../../shared/goalDriven/goalHandoff';
import { hasCapability } from '../../main/agents/capabilities';
import { substituteTemplateVariables, TemplateContext } from '../../shared/templateVariables';
import { prependNewSessionMessage } from '../../shared/newSessionMessage';
import { spawnAgent } from './agent-spawner';
import { captureCliRun } from './agent-run-capture';
import { addHistoryEntry, readGroups } from './storage';
import { getCliPrompt } from './prompt-loader';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { getGitBranch, isGitRepo } from './git-utils';
import { prepareMaestroSystemPromptCli } from './system-prompt';
import { registerCliActivity, unregisterCliActivity } from '../../shared/cli-activity';
import { generateUUID } from '../../shared/uuid';
import { formatElapsedTime } from '../../shared/formatters';
import { logger } from '../../main/utils/logger';

export interface RunGoalOptions {
	/** Write per-iteration + summary entries to History. Default true. */
	writeHistory?: boolean;
	/** Emit a `verbose` event carrying the full per-iteration prompt. */
	verbose?: boolean;
}

/** Human label for a goal run's exit reason (mirrors the desktop wording). */
function exitReasonLabel(reason: GoalExitReason): string {
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
	appendSystemPrompt: string | undefined
): Promise<{ blurb: string; usageStats?: UsageStats }> {
	try {
		const result = await captureCliRun(
			{
				sessionId: agentSessionId ?? session.id,
				toolType: session.toolType,
				cwd: session.cwd,
				prompt: GOAL_SYNOPSIS_REQUEST_PROMPT,
				source: 'cli:goal-synopsis',
			},
			() =>
				spawnAgent(session.toolType, session.cwd, GOAL_SYNOPSIS_REQUEST_PROMPT, agentSessionId, {
					customModel: session.customModel,
					customEffort: session.customEffort,
					customArgs: session.customArgs,
					customEnvVars: session.customEnvVars,
					sshRemoteConfig: session.sessionSshRemoteConfig,
					appendSystemPrompt,
				}),
			(r) => (r.success ? 0 : 1)
		);
		if (result.success) {
			return { blurb: sanitizeHandoffBlurb(result.response), usageStats: result.usageStats };
		}
	} catch (err) {
		logger.warn('[GoalRunner] Handoff synopsis request failed', undefined, err);
	}
	return { blurb: '' };
}

/**
 * Run a Goal-Driven Auto Run for a session, yielding JSONL events.
 *
 * Each iteration spawns a FRESH agent (no session resume) so it approaches the
 * goal with clean context, exactly like the desktop runner. SSH and per-session
 * agent overrides (model/effort/args/env) are threaded into every spawn for
 * parity with `batch-processor`.
 */
export async function* runGoal(
	session: SessionInfo,
	goalConfig: GoalRunConfig,
	options: RunGoalOptions = {}
): AsyncGenerator<JsonlEvent> {
	const { writeHistory = true, verbose = false } = options;
	const runStartTime = Date.now();

	const gitBranch = getGitBranch(session.cwd);
	const isGit = isGitRepo(session.cwd);
	const groups = readGroups();
	const groupName = groups.find((g) => g.id === session.groupId)?.name;

	// Surface this run to the desktop app / other CLI instances as busy.
	registerCliActivity({
		sessionId: session.id,
		playbookId: 'goal-run',
		playbookName: formatGoalRunDocumentPath(goalConfig.goal),
		startedAt: runStartTime,
		pid: process.pid,
	});

	try {
		const goalPromptTemplate = await getCliPrompt(PROMPT_IDS.AUTORUN_GOAL);
		const appendSystemPrompt = await prepareMaestroSystemPromptCli(session);

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
			const trimmedExit = goalConfig.exitCriteria.trim();
			addHistoryEntry({
				id: generateUUID(),
				type: 'AUTO',
				timestamp: runStartTime,
				summary: 'Goal-Driven Auto Run started',
				fullResponse: [
					`**Goal-Driven Auto Run Started**`,
					``,
					`- **Goal:** ${goalConfig.goal}`,
					`- **Exit Criteria:** ${trimmedExit || '_(none specified)_'}`,
					`- **Iteration Limit:** ${goalConfig.maxIterations ?? 'Infinite'}`,
					`- **Started:** ${new Date(runStartTime).toLocaleString()}`,
				].join('\n'),
				projectPath: session.cwd,
				sessionId: session.id,
			});
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
				yield { type: 'verbose', timestamp: Date.now(), category: 'prompt', iteration, prompt };
			}

			yield { type: 'goal_iteration_start', timestamp: Date.now(), iteration };

			const iterationStart = Date.now();
			const result = await captureCliRun(
				{
					sessionId: session.id,
					toolType: session.toolType,
					cwd: session.cwd,
					prompt,
					source: 'cli:goal',
				},
				() =>
					spawnAgent(session.toolType, session.cwd, prompt, undefined, {
						permissionMode: 'full',
						customModel: session.customModel,
						customEffort: session.customEffort,
						customArgs: session.customArgs,
						customEnvVars: session.customEnvVars,
						sshRemoteConfig: session.sessionSshRemoteConfig,
						appendSystemPrompt,
					}),
				(r) => (r.success ? 0 : 1)
			);
			const elapsedMs = Date.now() - iterationStart;

			if (result.usageStats) {
				totalInputTokens += result.usageStats.inputTokens || 0;
				totalOutputTokens += result.usageStats.outputTokens || 0;
				totalCost += result.usageStats.totalCostUsd || 0;
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
				addHistoryEntry({
					id: generateUUID(),
					type: 'AUTO',
					timestamp: Date.now(),
					summary: iterationSummary,
					// Strip internal `<!-- maestro:... -->` control markers before storing
					// so they never enter history or leak into any render surface.
					fullResponse: stripMaestroMarkers(
						result.success
							? result.response || synopsis
							: result.error || result.response || synopsis
					),
					agentSessionId: result.agentSessionId,
					projectPath: session.cwd,
					sessionId: session.id,
					success: result.success,
					usageStats: result.usageStats,
					elapsedTimeMs: elapsedMs,
				});
			}

			yield {
				type: 'goal_iteration_complete',
				timestamp: Date.now(),
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
						timestamp: Date.now(),
						category: 'handoff-prompt',
						iteration,
						prompt: GOAL_SYNOPSIS_REQUEST_PROMPT,
					};
				}
				const handoff = await requestHandoffBlurb(
					session,
					result.agentSessionId,
					appendSystemPrompt
				);
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

		const totalElapsedMs = Date.now() - runStartTime;
		const isSuccess = exitReason === 'completed';
		const finalSummary = `${exitReasonLabel(exitReason)} (${finalProgress}%)`;
		const finalDetails = [
			`**Goal-Driven Auto Run Summary**`,
			``,
			`- **Status:** ${exitReasonLabel(exitReason)}`,
			`- **Reason:** ${exitDetail}`,
			`- **Final Progress:** ${finalProgress}%`,
			`- **Iterations:** ${iteration}`,
			`- **Total Duration:** ${formatElapsedTime(totalElapsedMs)}`,
			`- **Goal:** ${goalConfig.goal}`,
		].join('\n');

		const usageStats: UsageStats | undefined =
			totalInputTokens > 0 || totalOutputTokens > 0
				? {
						inputTokens: totalInputTokens,
						outputTokens: totalOutputTokens,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						totalCostUsd: totalCost,
						// Cumulative total across iterations, not a per-iteration context size.
						contextWindow: 0,
					}
				: undefined;

		if (writeHistory) {
			const finalEntry: HistoryEntry = {
				id: generateUUID(),
				type: 'AUTO',
				timestamp: Date.now(),
				summary: finalSummary,
				fullResponse: finalDetails,
				projectPath: session.cwd,
				sessionId: session.id,
				success: isSuccess,
				elapsedTimeMs: totalElapsedMs,
				usageStats,
			};
			addHistoryEntry(finalEntry);
		}

		logger.autorun(`Goal-Driven Auto Run finished: ${exitReason}`, session.name, {
			iterations: iteration,
			finalProgress,
			exitReason,
		});

		yield {
			type: 'goal_complete',
			timestamp: Date.now(),
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
		unregisterCliActivity(session.id);
	}
}
