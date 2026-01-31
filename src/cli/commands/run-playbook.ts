// Run playbook command
// Executes a playbook and streams events to stdout

import { getSessionById } from '../services/storage';
import { findPlaybookById } from '../services/playbooks';
import { runPlaybook as executePlaybook } from '../services/batch-processor';
import { detectClaude, detectCodex } from '../services/agent-spawner';
import { emitError } from '../output/jsonl';
import {
	formatRunEvent,
	formatError,
	formatInfo,
	formatWarning,
	RunEvent,
} from '../output/formatter';
import { isSessionBusyWithCli, getCliActivityForSession } from '../../shared/cli-activity';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Check if desktop app has the session in busy state.
 *
 * NOTE: This function uses lowercase "maestro" config directory, which matches
 * the electron-store default (from package.json "name": "maestro"). This is
 * intentionally different from cli/services/storage.ts which uses "Maestro"
 * (capitalized) for CLI-specific storage. This function needs to read the
 * desktop app's session state, not CLI storage.
 *
 * @internal
 */
function isSessionBusyInDesktop(sessionId: string): { busy: boolean; reason?: string } {
	try {
		const platform = os.platform();
		const home = os.homedir();
		let configDir: string;

		if (platform === 'darwin') {
			configDir = path.join(home, 'Library', 'Application Support', 'maestro');
		} else if (platform === 'win32') {
			configDir = path.join(
				process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
				'maestro'
			);
		} else {
			configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'maestro');
		}

		const sessionsPath = path.join(configDir, 'maestro-sessions.json');
		const content = fs.readFileSync(sessionsPath, 'utf-8');
		const data = JSON.parse(content);
		const sessions = data.sessions || [];

		const session = sessions.find((s: { id: string }) => s.id === sessionId);
		if (session && session.state === 'busy') {
			return { busy: true, reason: 'Desktop app shows agent is busy' };
		}
		return { busy: false };
	} catch {
		// Can't read sessions file, assume not busy
		return { busy: false };
	}
}

interface RunPlaybookOptions {
	dryRun?: boolean;
	history?: boolean; // commander uses --no-history which becomes history: false
	json?: boolean;
	debug?: boolean;
	verbose?: boolean;
	wait?: boolean;
}

/**
 * Format wait duration in human-readable format.
 *
 * NOTE: This is intentionally different from shared/formatters.ts formatElapsedTime,
 * which uses a combined format like "5m 12s". This function uses a simpler format
 * (e.g., "5s", "2m 30s") appropriate for CLI wait messages.
 *
 * @internal
 */
function formatWaitDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Pause execution for the specified duration.
 * @internal
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if agent is busy (either from another CLI instance or desktop app).
 * @internal
 */
function checkAgentBusy(agentId: string, _agentName: string): { busy: boolean; reason?: string } {
	// Check CLI activity first
	const cliActivity = getCliActivityForSession(agentId);
	if (cliActivity && isSessionBusyWithCli(agentId)) {
		return {
			busy: true,
			reason: `Running playbook "${cliActivity.playbookName}" from CLI (PID: ${cliActivity.pid})`,
		};
	}

	// Check desktop state
	const desktopBusy = isSessionBusyInDesktop(agentId);
	if (desktopBusy.busy) {
		return {
			busy: true,
			reason: 'Busy in desktop app',
		};
	}

	return { busy: false };
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

		const agent = getSessionById(agentId)!;

		// Check if agent CLI is available
		if (agent.toolType === 'codex') {
			const codex = await detectCodex();
			if (!codex.available) {
				if (useJson) {
					emitError('Codex CLI not found. Please install codex CLI.', 'CODEX_NOT_FOUND');
				} else {
					console.error(formatError('Codex CLI not found. Please install codex CLI.'));
				}
				process.exit(1);
			}
		} else if (agent.toolType === 'claude-code') {
			const claude = await detectClaude();
			if (!claude.available) {
				if (useJson) {
					emitError('Claude Code not found. Please install claude-code CLI.', 'CLAUDE_NOT_FOUND');
				} else {
					console.error(formatError('Claude Code not found. Please install claude-code CLI.'));
				}
				process.exit(1);
			}
		} else {
			const message = `Agent type "${agent.toolType}" is not supported in CLI batch mode yet.`;
			if (useJson) {
				emitError(message, 'AGENT_UNSUPPORTED');
			} else {
				console.error(formatError(message));
			}
			process.exit(1);
		}

		// Check if agent is busy (either from desktop or another CLI instance)
		let busyCheck = checkAgentBusy(agent.id, agent.name);

		if (busyCheck.busy) {
			if (options.wait) {
				// Wait mode - poll until agent becomes available
				const waitStartTime = Date.now();
				const pollIntervalMs = 5000; // Check every 5 seconds

				if (!useJson) {
					console.log(formatWarning(`Agent "${agent.name}" is busy: ${busyCheck.reason}`));
					console.log(formatInfo('Waiting for agent to become available...'));
				}

				let lastReason = busyCheck.reason;
				while (busyCheck.busy) {
					await sleep(pollIntervalMs);
					busyCheck = checkAgentBusy(agent.id, agent.name);

					// Log if reason changed (e.g., different playbook now running)
					if (busyCheck.busy && busyCheck.reason !== lastReason && !useJson) {
						console.log(formatWarning(`Still waiting: ${busyCheck.reason}`));
						lastReason = busyCheck.reason;
					}
				}

				const waitDuration = Date.now() - waitStartTime;
				if (!useJson) {
					console.log(
						formatInfo(`Agent available after waiting ${formatWaitDuration(waitDuration)}`)
					);
					console.log('');
				} else {
					// Emit wait event in JSON mode
					console.log(
						JSON.stringify({
							type: 'wait_complete',
							timestamp: Date.now(),
							waitDurationMs: waitDuration,
						})
					);
				}
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
	}
}
