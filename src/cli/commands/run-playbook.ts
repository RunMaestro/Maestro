// Run playbook command
// Executes a playbook and streams events to stdout

import { getSessionById } from '../services/storage';
import { findPlaybookById } from '../services/playbooks';
import { runPlaybook as executePlaybook } from '../services/batch-processor';
import { detectAgent } from '../services/agent-spawner';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import { emitError, emitJsonl, type CompleteEvent } from '../output/jsonl';
import { formatRunEvent, formatError, formatInfo, RunEvent } from '../output/formatter';
import { checkAgentBusy, waitForAgentAvailable } from '../services/agent-busy';
import { installInterruptHandler } from '../utils/interrupt';
import { ExitCode, exitWith } from '../exit-codes';
import {
	PlaybookParamInputError,
	resolveRunParams,
	writeMissingParamsHaltMarker,
	type RunParamResolution,
} from '../services/playbook-params';
import { describeMissingRequiredParams } from '../../shared/playbookParams';
import type { Playbook } from '../../shared/types';
import { isAutomationQuerySource, readQuerySource } from '../../shared/querySource';

interface RunPlaybookOptions {
	dryRun?: boolean;
	history?: boolean; // commander uses --no-history which becomes history: false
	json?: boolean;
	debug?: boolean;
	verbose?: boolean;
	synopsis?: boolean; // commander uses --no-synopsis which becomes synopsis: false
	wait?: boolean;
	/**
	 * Run-scoped model/effort overrides. When set they win over the agent's
	 * configured `customModel` / `customEffort` for this run's spawns only and
	 * are never written back to the stored session.
	 */
	model?: string;
	effort?: string;
	/** Skip the documents' MAESTRO:MODEL markers for this run (--ignore-model-hints). */
	ignoreModelHints?: boolean;
	/** Repeated `--param NAME=VALUE`: answers for this run only, never saved. */
	param?: string[];
	/** `--params-file <path>`: a JSON object of answers for this run only (`--param` wins). */
	paramsFile?: string;
}

/**
 * When an automation (a Cue subscription, or an Auto Run task) started this
 * run, leave a halt marker in the playbook's first document so the next
 * scheduled fire refuses up front instead of failing the same way forever. A
 * person at a shell never gets one: they read the error and answer. Returns the
 * marked document, or null. A marker that could not be written is reported, not
 * thrown: the run is refused either way, and exit 2 is what the caller acts on.
 */
function markMissingParamsForAutomation(
	agentId: string,
	playbook: Pick<Playbook, 'documents'>,
	missing: string[]
): string | null {
	if (!isAutomationQuerySource(readQuerySource(process.env))) return null;
	const folder = getSessionById(agentId)?.autoRunFolderPath;
	if (!folder) return null;
	try {
		const marked = writeMissingParamsHaltMarker(folder, playbook, missing);
		if (marked) {
			console.error(
				`Wrote a halt marker into "${marked}" so the next scheduled run refuses until the parameters are configured.`
			);
		}
		return marked;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(formatError(`Could not write the missing-parameters halt marker: ${reason}`));
		return null;
	}
}

export async function runPlaybook(playbookId: string, options: RunPlaybookOptions): Promise<void> {
	const useJson = options.json;

	try {
		let agentId: string;
		let playbook;

		// Find playbook across all agents
		try {
			const result = findPlaybookById(playbookId);
			playbook = result.playbook;
			agentId = result.agentId;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			if (useJson) {
				emitError(message, 'PLAYBOOK_NOT_FOUND');
			} else {
				console.error(formatError(message));
			}
			process.exit(1);
		}

		// Playbook parameters: the saved answers, overridden for this run only by
		// --params-file and --param. Checked before anything else so a run that
		// cannot start never detects, waits on, or spawns an agent.
		let params: RunParamResolution;
		try {
			params = resolveRunParams(playbook, {
				param: options.param,
				paramsFile: options.paramsFile,
			});
		} catch (error) {
			if (!(error instanceof PlaybookParamInputError)) throw error;
			if (useJson) {
				emitError(error.message, 'INVALID_PARAMETERS');
			} else {
				console.error(formatError(error.message));
			}
			exitWith(ExitCode.InvalidUsage);
		}
		if (params.missing.length > 0) {
			const missing = params.missing.map((spec) => spec.name);
			const message = describeMissingRequiredParams(params.missing);
			console.error(formatError(message));
			console.error(
				`Answer them for this run with --param NAME=VALUE, or save them with: maestro-cli playbook configure ${playbook.id} --set NAME=VALUE`
			);
			const haltMarker = markMissingParamsForAutomation(agentId, playbook, missing);
			if (useJson) {
				emitJsonl({
					type: 'error',
					message,
					code: 'MISSING_PARAMETERS',
					missing,
					...(haltMarker ? { haltMarker } : {}),
				});
			}
			exitWith(ExitCode.InvalidUsage);
		}
		// The engine reads answers off the record; this copy is never saved.
		if (params.specs.length > 0) {
			playbook = { ...playbook, parameterValues: params.values };
		}

		const agent = getSessionById(agentId)!;

		// Check if agent CLI is available
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

		// Check if agent is busy (either from desktop or another CLI instance)
		const busyCheck = checkAgentBusy(agent.id);

		if (busyCheck.busy) {
			if (options.wait) {
				// Wait mode - poll until agent becomes available
				await waitForAgentAvailable(agent, busyCheck, { useJson });
			} else {
				// No wait mode - fail immediately
				const message = `Agent "${agent.name}" is busy: ${busyCheck.reason}. Use --wait to wait for availability.`;
				if (useJson) {
					emitError(message, 'AGENT_BUSY');
				} else {
					console.error(formatError(message));
				}
				process.exit(1);
			}
		}

		// Determine Auto Run folder path
		const folderPath = agent.autoRunFolderPath;
		if (!folderPath) {
			if (useJson) {
				emitError('Agent does not have an Auto Run folder configured', 'NO_AUTORUN_FOLDER');
			} else {
				console.error(formatError('Agent does not have an Auto Run folder configured'));
			}
			process.exit(1);
		}

		// Show startup info in human-readable mode
		if (!useJson) {
			console.log(formatInfo(`Running playbook: ${playbook.name}`));
			console.log(formatInfo(`Agent: ${agent.name}`));
			console.log(formatInfo(`Documents: ${playbook.documents.length}`));
			// Show loop configuration
			if (playbook.loopEnabled) {
				const loopInfo = playbook.maxLoops ? `max ${playbook.maxLoops}` : '∞';
				console.log(formatInfo(`Loop: enabled (${loopInfo})`));
			}
			const runModel = options.model?.trim();
			const runEffort = options.effort?.trim();
			if (runModel) console.log(formatInfo(`Model: ${runModel} (this run only)`));
			if (runEffort) console.log(formatInfo(`Effort: ${runEffort} (this run only)`));
			if (options.ignoreModelHints) {
				console.log(formatInfo('Model hints in documents: ignored (this run only)'));
			}
			if (options.dryRun) {
				console.log(formatInfo('Dry run mode - no changes will be made'));
			}
			console.log('');
		}

		// First Ctrl+C stops the run gracefully (the agent turn is aborted and the
		// run records "stopped"); a second one exits immediately.
		const interrupt = installInterruptHandler({
			onFirst: () => {
				if (!useJson) {
					console.log(formatInfo('Stopping... press Ctrl+C again to quit immediately.'));
				}
			},
		});

		// Execute playbook and stream events
		const generator = executePlaybook(agent, playbook, folderPath, {
			signal: interrupt.signal,
			dryRun: options.dryRun,
			writeHistory: options.history !== false, // --no-history sets history to false
			debug: options.debug,
			verbose: options.verbose,
			skipSynopsis: options.synopsis === false, // --no-synopsis sets synopsis to false
			model: options.model?.trim() || undefined,
			effort: options.effort?.trim() || undefined,
			ignoreModelHints: options.ignoreModelHints || undefined,
		});

		try {
			for await (const event of generator) {
				if (useJson) {
					console.log(JSON.stringify(event));
				} else {
					console.log(formatRunEvent(event as RunEvent, { debug: options.debug }));
				}
				// A stopped run is not a success; report it the way a shell reports SIGINT.
				if (event.type === 'complete' && (event as CompleteEvent).stopped) {
					process.exitCode = 130;
				}
			}
		} finally {
			interrupt.dispose();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (useJson) {
			emitError(`Failed to run playbook: ${message}`, 'EXECUTION_ERROR');
		} else {
			console.error(formatError(`Failed to run playbook: ${message}`));
		}
		process.exit(1);
	}
}
