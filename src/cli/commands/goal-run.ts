// Goal-run command
// Launches a Goal-Driven Auto Run for an agent and streams events to stdout.

import { getSessionById } from '../services/storage';
import { detectAgent } from '../services/agent-spawner';
import { getAgentDefinition } from '../../main/agents/definitions';
import { emitError, emitJsonl } from '../output/jsonl';
import {
	formatRunEvent,
	formatError,
	formatInfo,
	formatSuccess,
	RunEvent,
} from '../output/formatter';
import { checkAgentBusy, waitForAgentAvailable } from '../services/agent-busy';
import { runGoal } from '../services/goal-runner';
import {
	withMaestroClient,
	UnsupportedCommandError,
	CommandTimeoutError,
} from '../services/maestro-client';
import type { GoalRunConfig } from '../../shared/goalDriven/types';

interface GoalRunOptions {
	exitCriteria?: string;
	maxIterations?: string; // commander passes option values as strings
	json?: boolean;
	verbose?: boolean;
	history?: boolean; // --no-history -> history: false
	/**
	 * Run-scoped model/effort overrides. When set they win over the agent's
	 * configured `customModel` / `customEffort` for this run's spawns only and
	 * are never written back to the stored session.
	 */
	model?: string;
	effort?: string;
	/**
	 * Hand the run to the running desktop app instead of executing it in this
	 * process. The run then behaves exactly like one started from the Auto Run
	 * modal's Go button: visible in the Auto Run surface, stoppable with
	 * `stop-auto-run`, listed by `session list`.
	 */
	visible?: boolean;
	/** Poll until the agent is free instead of failing immediately when busy. */
	wait?: boolean;
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

/**
 * Assemble the run config from parsed options. Shared by the headless and
 * `--visible` paths so a goal launched either way is described identically -
 * same trimming, same infinite-iteration default.
 */
function buildGoalConfig(
	trimmedGoal: string,
	options: GoalRunOptions,
	useJson: boolean
): GoalRunConfig {
	return {
		goal: trimmedGoal,
		exitCriteria: options.exitCriteria?.trim() ?? '',
		maxIterations: parseMaxIterations(options.maxIterations, useJson),
	};
}

/** Response shape of the desktop's `launch_goal_run_result` message. */
interface LaunchGoalRunResult {
	type: string;
	success: boolean;
	sessionId?: string;
	tabId?: string;
	code?: string;
	error?: string;
}

/**
 * Build the deep link that reopens a launched run. Tab-less form is a valid
 * target on its own, so an agent whose active tab the desktop could not report
 * still gets a usable link rather than a `.../tab/undefined` string.
 */
function goalRunDeepLink(agentId: string, tabId?: string): string {
	return tabId ? `maestro://session/${agentId}/tab/${tabId}` : `maestro://session/${agentId}`;
}

/**
 * Emit a launch failure in whichever format the caller asked for and exit 1.
 * Every `--visible` failure path routes through here so the JSON contract stays
 * one shape and no path can silently fall back to a headless run - the whole
 * point of `--visible` is that the user can watch it.
 */
function failVisibleLaunch(message: string, code: string, useJson: boolean): never {
	if (useJson) {
		emitError(message, code);
	} else {
		console.error(formatError(message));
	}
	process.exit(1);
}

/**
 * Hand a Goal-Driven Auto Run to the running desktop app (`--visible`).
 *
 * The desktop owns the run from here: it spawns the agent, arbitrates busy
 * state, and answers `stop-auto-run` / `session list`. This function's job is
 * only to deliver the request and report back stable identifiers, so it returns
 * as soon as the desktop confirms the run is running rather than streaming
 * iterations the way the headless path does.
 */
async function runVisibleGoalRun(
	agent: { id: string; name: string },
	goalConfig: GoalRunConfig,
	options: GoalRunOptions
): Promise<void> {
	const useJson = options.json ?? false;

	// Busy arbitration happens twice on purpose. Here it is advisory - it is what
	// makes `--wait` possible, since polling from inside the desktop would just
	// hold the IPC round-trip open. The desktop re-checks authoritatively and can
	// still answer AGENT_BUSY if something claimed the agent in between.
	const busyCheck = checkAgentBusy(agent.id);
	if (busyCheck.busy) {
		if (!options.wait) {
			failVisibleLaunch(
				`Agent "${agent.name}" is busy: ${busyCheck.reason}.`,
				'AGENT_BUSY',
				useJson
			);
		}
		await waitForAgentAvailable(agent, busyCheck, { useJson });
	}

	if (!useJson) {
		console.log(formatInfo('Goal-Driven Auto Run (visible)'));
		console.log(formatInfo(`Agent: ${agent.name}`));
		console.log(formatInfo(`Goal: ${goalConfig.goal}`));
		if (goalConfig.exitCriteria) {
			console.log(formatInfo(`Exit criteria: ${goalConfig.exitCriteria}`));
		}
		console.log(
			formatInfo(
				`Iterations: ${goalConfig.maxIterations === null ? '∞ (infinite)' : `max ${goalConfig.maxIterations}`}`
			)
		);
		console.log('');
	}

	let result: LaunchGoalRunResult;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<LaunchGoalRunResult>(
				{
					type: 'launch_goal_run',
					sessionId: agent.id,
					goal: goalConfig.goal,
					exitCriteria: goalConfig.exitCriteria || undefined,
					maxIterations: goalConfig.maxIterations,
					...(options.model?.trim() && { model: options.model.trim() }),
					...(options.effort?.trim() && { effort: options.effort.trim() }),
				},
				'launch_goal_run_result',
				// The desktop waits for the run to actually reach a running state
				// before replying (it loads the goal prompt template and reads git
				// status first), so this must outlast the renderer's own wait.
				30000
			)
		);
	} catch (error) {
		// Fail closed. Never fall back to a headless run: the caller asked for a
		// run they could watch, and a silent headless substitute is invisible in
		// exactly the surface they were pointing at.
		if (error instanceof UnsupportedCommandError) {
			failVisibleLaunch(error.message, 'UNSUPPORTED_COMMAND', useJson);
		}
		if (error instanceof CommandTimeoutError) {
			failVisibleLaunch(error.message, 'LAUNCH_TIMEOUT', useJson);
		}
		const message = error instanceof Error ? error.message : String(error);
		failVisibleLaunch(
			`Maestro desktop app is not reachable: ${message}. ` +
				'Start Maestro and retry, or drop --visible to run headlessly.',
			'MAESTRO_NOT_RUNNING',
			useJson
		);
	}

	if (!result.success) {
		failVisibleLaunch(
			result.error || 'The desktop app rejected the goal run',
			result.code || 'VISIBLE_LAUNCH_REJECTED',
			useJson
		);
	}

	const tabId = result.tabId;
	const uri = goalRunDeepLink(agent.id, tabId);

	if (useJson) {
		// Keys are camelCase to match the rest of this command's JSONL stream
		// (`taskIndex`, `elapsedMs`, `agentSessionId`) rather than the snake_case
		// sketched in the feature request.
		emitJsonl({
			type: 'visible_launch',
			ok: true,
			mode: 'goal',
			visible: true,
			agentId: agent.id,
			sessionId: agent.id,
			tabId: tabId ?? null,
			status: 'running',
			uri,
		});
	} else {
		console.log(formatSuccess(`Goal run started in Maestro on agent "${agent.name}"`));
		console.log(formatInfo(`Open: ${uri}`));
		console.log(formatInfo(`Stop with: maestro-cli stop-auto-run -a ${agent.id}`));
	}
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

		// `--wait` polls for the agent to free up, which only the desktop handoff
		// does. Rejecting it outright beats silently ignoring it: a script that
		// passes `--wait` expecting a queue would otherwise just fail on a busy
		// agent and look flaky. The headless path is deliberately left alone.
		if (options.wait && !options.visible) {
			const message = '--wait requires --visible.';
			if (useJson) {
				emitError(message, 'WAIT_REQUIRES_VISIBLE');
			} else {
				console.error(formatError(message));
			}
			process.exit(1);
		}

		// `--visible` hands the run to the desktop, which spawns the agent itself.
		// Branch BEFORE the local-binary checks below: the desktop resolves the
		// provider (and honors SSH remotes), so a CLI-side `detectAgent` here would
		// reject a perfectly runnable agent just because this machine lacks the
		// binary. Everything after this point is the headless path.
		if (options.visible) {
			await runVisibleGoalRun(agent, buildGoalConfig(trimmedGoal, options, useJson), options);
			return;
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

		const goalConfig = buildGoalConfig(trimmedGoal, options, useJson);
		const maxIterations = goalConfig.maxIterations;

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
			const runModel = options.model?.trim();
			const runEffort = options.effort?.trim();
			if (runModel) console.log(formatInfo(`Model: ${runModel} (this run only)`));
			if (runEffort) console.log(formatInfo(`Effort: ${runEffort} (this run only)`));
			console.log('');
		}

		const generator = runGoal(agent, goalConfig, {
			writeHistory: options.history !== false, // --no-history sets history to false
			verbose: options.verbose,
			model: options.model?.trim() || undefined,
			effort: options.effort?.trim() || undefined,
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
