// Shared agent busy-state checks and wait loop for headless Auto Run commands.
// Used by `maestro-cli playbook` (run-playbook) and `maestro-cli run-doc`
// (run-doc) so both share one source of truth for busy detection and --wait.

import { getCliActivityForSession, isSessionBusyWithCli } from '../../shared/cli-activity';
import { formatWarning, formatInfo } from '../output/formatter';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Check if the desktop app has the session in a busy state.
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

/**
 * Check if an agent is busy, either from another CLI instance running a
 * playbook/doc or from the desktop app.
 */
export function checkAgentBusy(agentId: string): { busy: boolean; reason?: string } {
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

/**
 * Format a wait duration in human-readable form.
 *
 * NOTE: This is intentionally different from shared/formatters.ts formatElapsedTime,
 * which uses a combined format like "5m 12s". This function uses a simpler format
 * (e.g., "5s", "2m 30s") appropriate for CLI wait messages.
 */
export function formatWaitDuration(ms: number): string {
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
 * Poll until the agent becomes available. Caller should only invoke this when
 * the agent is currently busy and the user passed --wait. Emits progress lines
 * in human mode and a single `wait_complete` event in JSON mode.
 */
export async function waitForAgentAvailable(
	agent: { id: string; name: string },
	initialBusy: { busy: boolean; reason?: string },
	options: { useJson?: boolean } = {}
): Promise<void> {
	const { useJson } = options;
	const waitStartTime = Date.now();
	const pollIntervalMs = 5000; // Check every 5 seconds

	if (!useJson) {
		console.log(formatWarning(`Agent "${agent.name}" is busy: ${initialBusy.reason}`));
		console.log(formatInfo('Waiting for agent to become available...'));
	}

	let busyCheck = initialBusy;
	let lastReason = busyCheck.reason;
	while (busyCheck.busy) {
		await sleep(pollIntervalMs);
		busyCheck = checkAgentBusy(agent.id);

		// Log if reason changed (e.g., different playbook now running)
		if (busyCheck.busy && busyCheck.reason !== lastReason && !useJson) {
			console.log(formatWarning(`Still waiting: ${busyCheck.reason}`));
			lastReason = busyCheck.reason;
		}
	}

	const waitDuration = Date.now() - waitStartTime;
	if (!useJson) {
		console.log(formatInfo(`Agent available after waiting ${formatWaitDuration(waitDuration)}`));
		console.log('');
	} else {
		console.log(
			JSON.stringify({
				type: 'wait_complete',
				timestamp: Date.now(),
				waitDurationMs: waitDuration,
			})
		);
	}
}
