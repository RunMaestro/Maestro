// Goal-run command
// Launches a Goal-Driven Auto Run for an agent and streams events to stdout.

import { getSessionById } from '../services/storage';
import { detectAgent } from '../services/agent-spawner';
import { getAgentDefinition } from '../../main/agents/definitions';
import { emitError } from '../output/jsonl';
import { formatRunEvent, formatError, formatInfo, RunEvent } from '../output/formatter';
import { checkAgentBusy } from '../services/agent-busy';
import { runGoal } from '../services/goal-runner';
import { withMaestroClient } from '../services/maestro-client';
import { buildSessionDeepLink } from '../../shared/deep-link-urls';
import type { GoalRunConfig } from '../../shared/goalDriven/types';

interface GoalRunOptions {
	exitCriteria?: string;
	maxIterations?: string; // commander passes option values as strings
	json?: boolean;
	verbose?: boolean;
	history?: boolean; // --no-history -> history: false
	/**
	 * Hand the run to the running desktop app so it appears as a live Auto Run
	 * in the same UI surface as the Go/Spec buttons, instead of running headless
	 * in this CLI process. Fails closed when the desktop app is unreachable.
	 */
	visible?: boolean;
}

/**
 * Substring signature of MaestroClient / socket-level failures that mean the
 * desktop app is down or unreachable (as opposed to a command it rejected).
 * Mirrors the mapping in `dispatch.ts` so `--visible` can fail closed with a
 * dedicated code instead of a generic error.
 */
function isMaestroUnreachable(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes('econnrefused') ||
		lower.includes('connection refused') ||
		lower.includes('websocket') ||
		lower.includes('enotfound') ||
		lower.includes('etimedout') ||
		lower.includes('maestro desktop app is not running') ||
		lower.includes('discovery file is stale') ||
		lower.includes('not connected to maestro') ||
		lower.includes('connection to maestro timed out')
	);
}

/**
 * Response envelope for the `launch_goal_run` desktop command.
 */
interface LaunchGoalRunResponse {
	success?: boolean;
	tabId?: string;
	error?: string;
}

/**
 * Hand a Goal-Driven Auto Run to the running desktop app so it runs as a
 * visible, desktop-owned Auto Run (parity with the UI Go button) instead of
 * headlessly in this CLI process.
 *
 * Fails closed: if the desktop app is unreachable we exit non-zero rather than
 * silently falling back to a headless run, because the user explicitly opted
 * into a visible run and their goal shouldn't run somewhere they can't see it.
 */
export async function runVisibleGoalRun(
	agentId: string,
	goalConfig: GoalRunConfig,
	useJson: boolean
): Promise<void> {
	let result: LaunchGoalRunResponse;
	try {
		result = await withMaestroClient(async (client) => {
			return client.sendCommand<LaunchGoalRunResponse>(
				{
					type: 'launch_goal_run',
					sessionId: agentId,
					goal: goalConfig.goal,
					exitCriteria: goalConfig.exitCriteria,
					maxIterations: goalConfig.maxIterations,
				},
				'launch_goal_run_result'
			);
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const unreachable = isMaestroUnreachable(message);
		const code = unreachable ? 'MAESTRO_NOT_RUNNING' : 'VISIBLE_LAUNCH_FAILED';
		const friendly = unreachable
			? 'Maestro desktop is not running or not reachable. --visible requires the desktop app; re-run without --visible for a headless goal run.'
			: `Failed to launch visible goal run: ${message}`;
		if (useJson) {
			emitError(friendly, code);
		} else {
			console.error(formatError(friendly));
		}
		process.exit(1);
		return;
	}

	if (!result.success) {
		const message = result.error || 'The desktop app rejected the visible goal run.';
		// A busy agent surfaces here deterministically as a clear error so
		// orchestrators can branch on it instead of guessing.
		const code = /busy/i.test(message) ? 'AGENT_BUSY' : 'VISIBLE_LAUNCH_REJECTED';
		if (useJson) {
			emitError(message, code);
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
		return;
	}

	const tabId = result.tabId;
	const uri = buildSessionDeepLink(agentId, tabId);
	if (useJson) {
		console.log(
			JSON.stringify({
				ok: true,
				mode: 'visible',
				visible: true,
				agent_id: agentId,
				session_id: agentId,
				tab_id: tabId ?? null,
				status: 'launched',
				uri,
			})
		);
	} else {
		console.log(formatInfo('Visible Goal-Driven Auto Run launched in Maestro.'));
		console.log(formatInfo(`Agent: ${agentId}`));
		console.log(formatInfo(`Open: ${uri}`));
	}
}

/**
 * Parse the --max-iterations option into a finite positive integer, or null for
 * an infinite run (the default when the flag is omitted).
 */
function parseMaxIterations(raw: string | undefined, useJson: boolean): number | null {
	if (raw === undefined) return null;
	const parsed = parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		const message = `--max-iterations must be a positive integer (got "${raw}")`;
		if (useJson) {
			emitError(message, 'INVALID_MAX_ITERATIONS');
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
	return parsed;
}

export async function goalRun(
	agentId: string,
	goal: string,
	options: GoalRunOptions
): Promise<void> {
	const useJson = options.json ?? false;

	try {
		const trimmedGoal = goal.trim();
		if (!trimmedGoal) {
			const message = 'A non-empty goal is required.';
			if (useJson) {
				emitError(message, 'EMPTY_GOAL');
			} else {
				console.error(formatError(message));
			}
			process.exit(1);
		}

		const agent = getSessionById(agentId);
		if (!agent) {
			const message = `Agent "${agentId}" not found.`;
			if (useJson) {
				emitError(message, 'AGENT_NOT_FOUND');
			} else {
				console.error(formatError(message));
			}
			process.exit(1);
		}

		// Agent CLI must be supported and installed.
		const def = getAgentDefinition(agent.toolType);
		if (!def) {
			const message = `Agent type "${agent.toolType}" is not supported in CLI batch mode yet.`;
			if (useJson) {
				emitError(message, 'AGENT_UNSUPPORTED');
			} else {
				console.error(formatError(message));
			}
			process.exit(1);
		}

		// --visible hands the run to the desktop app, which owns spawning (using the
		// agent's configured binary, SSH, etc.) and busy arbitration. Skip the
		// headless-only preflight below (detectAgent / checkAgentBusy / runGoal).
		if (options.visible) {
			await runVisibleGoalRun(
				agent.id,
				{
					goal: trimmedGoal,
					exitCriteria: options.exitCriteria?.trim() ?? '',
					maxIterations: parseMaxIterations(options.maxIterations, useJson),
				},
				useJson
			);
			return;
		}

		const detection = await detectAgent(agent.toolType);
		if (!detection.available) {
			const errorCode = `${agent.toolType.toUpperCase().replace(/-/g, '_')}_NOT_FOUND`;
			const message = `${def.name} CLI not found. Please install ${def.name}.`;
			if (useJson) {
				emitError(message, errorCode);
			} else {
				console.error(formatError(message));
			}
			process.exit(1);
		}

		// One run per agent: refuse if busy in desktop or another CLI instance.
		const busyCheck = checkAgentBusy(agent.id);
		if (busyCheck.busy) {
			const message = `Agent "${agent.name}" is busy: ${busyCheck.reason}.`;
			if (useJson) {
				emitError(message, 'AGENT_BUSY');
			} else {
				console.error(formatError(message));
			}
			process.exit(1);
		}

		const maxIterations = parseMaxIterations(options.maxIterations, useJson);
		const goalConfig: GoalRunConfig = {
			goal: trimmedGoal,
			exitCriteria: options.exitCriteria?.trim() ?? '',
			maxIterations,
		};

		if (!useJson) {
			console.log(formatInfo(`Goal-Driven Auto Run`));
			console.log(formatInfo(`Agent: ${agent.name}`));
			console.log(formatInfo(`Goal: ${goalConfig.goal}`));
			if (goalConfig.exitCriteria) {
				console.log(formatInfo(`Exit criteria: ${goalConfig.exitCriteria}`));
			}
			console.log(
				formatInfo(
					`Iterations: ${maxIterations === null ? '∞ (infinite)' : `max ${maxIterations}`}`
				)
			);
			console.log('');
		}

		const generator = runGoal(agent, goalConfig, {
			writeHistory: options.history !== false, // --no-history sets history to false
			verbose: options.verbose,
		});

		for await (const event of generator) {
			if (useJson) {
				console.log(JSON.stringify(event));
			} else {
				console.log(formatRunEvent(event as RunEvent, { debug: false }));
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (useJson) {
			emitError(`Failed to run goal: ${message}`, 'EXECUTION_ERROR');
		} else {
			console.error(formatError(`Failed to run goal: ${message}`));
		}
		process.exit(1);
	}
}
