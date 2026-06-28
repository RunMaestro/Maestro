// Goal-run command
// Launches a Goal-Driven Auto Run for an agent and streams events to stdout.

import { getSessionById } from '../services/storage';
import { detectAgent } from '../services/agent-spawner';
import { getAgentDefinition } from '../../main/agents/definitions';
import { emitError } from '../output/jsonl';
import { formatRunEvent, formatError, formatInfo, RunEvent } from '../output/formatter';
import { checkAgentBusy } from '../services/agent-busy';
import { runGoal } from '../services/goal-runner';
import type { GoalRunConfig } from '../../shared/goalDriven/types';

interface GoalRunOptions {
	exitCriteria?: string;
	maxIterations?: string; // commander passes option values as strings
	json?: boolean;
	verbose?: boolean;
	history?: boolean; // --no-history -> history: false
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
