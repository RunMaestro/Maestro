// Run playbook command
// Executes a playbook and streams events to stdout

import { getSessionById } from '../services/storage';
import { findPlaybookById } from '../services/playbooks';
import { runPlaybook as executePlaybook } from '../services/batch-processor';
import { detectAgent } from '../services/agent-spawner';
import { getAgentDefinition } from '../../main/agents/definitions';
import { emitError } from '../output/jsonl';
import { formatRunEvent, formatError, formatInfo, RunEvent } from '../output/formatter';
import { checkAgentBusy, waitForAgentAvailable } from '../services/agent-busy';

interface RunPlaybookOptions {
	dryRun?: boolean;
	history?: boolean; // commander uses --no-history which becomes history: false
	json?: boolean;
	debug?: boolean;
	verbose?: boolean;
	synopsis?: boolean; // commander uses --no-synopsis which becomes synopsis: false
	wait?: boolean;
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
			return;
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
			return;
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
				return;
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
			return;
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
			if (options.dryRun) {
				console.log(formatInfo('Dry run mode - no changes will be made'));
			}
			console.log('');
		}

		// Execute playbook and stream events
		const generator = executePlaybook(agent, playbook, folderPath, {
			dryRun: options.dryRun,
			writeHistory: options.history !== false, // --no-history sets history to false
			debug: options.debug,
			verbose: options.verbose,
			skipSynopsis: options.synopsis === false, // --no-synopsis sets synopsis to false
		});

		for await (const event of generator) {
			if (useJson) {
				console.log(JSON.stringify(event));
			} else {
				console.log(formatRunEvent(event as RunEvent, { debug: options.debug }));
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (useJson) {
			emitError(`Failed to run playbook: ${message}`, 'EXECUTION_ERROR');
		} else {
			console.error(formatError(`Failed to run playbook: ${message}`));
		}
		process.exit(1);
		return;
	}
}
