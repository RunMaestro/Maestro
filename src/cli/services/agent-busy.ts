// Agent busy-state detection and wait loop for CLI run commands.
//
// Shared by `run-playbook`, `run-doc`, and `goal-run` so a CLI run never starts
// on an agent that is already busy in the desktop app or another CLI instance.
// Extracted to avoid duplicating the (subtle) desktop config-path logic and the
// --wait poll loop across commands.

import { resolveUserDataDir } from '../../shared/userDataDir';
import { readSessionsStoreFile } from '../../main/stores/sessions-store-file';
import { isSessionBusyWithCli, getCliActivityForSession } from '../../shared/cli-activity';
import { formatWarning, formatInfo } from '../output/formatter';
import { humanizeDuration } from '../../shared/duration';

export interface BusyCheckResult {
	busy: boolean;
	reason?: string;
}

/**
 * Check if the desktop app has the session in a busy state.
 *
 * Reads the desktop's `maestro-sessions.json` from Maestro's data directory as
 * `resolveUserDataDir()` resolves it - the same directory every other CLI read
 * uses. It used to hard-code the lowercase `maestro` directory and ignore
 * `MAESTRO_USER_DATA`, so in dev and on a case-sensitive packaged install it
 * read a file that did not exist and answered "not busy".
 */
export function isSessionBusyInDesktop(sessionId: string): BusyCheckResult {
	try {
		const { sessions } = readSessionsStoreFile(resolveUserDataDir());
		// `state` is not part of the CLI's `SessionInfo`: it is the desktop's
		// runtime field, read here straight off the stored record.
		const session = sessions.find((s) => s.id === sessionId) as { state?: string } | undefined;
		if (session?.state === 'busy') {
			return { busy: true, reason: 'Desktop app shows agent is busy' };
		}
		return { busy: false };
	} catch {
		// Can't read sessions file, assume not busy.
		return { busy: false };
	}
}

/**
 * Check if an agent is busy from another CLI instance or the desktop app.
 */
export function checkAgentBusy(agentId: string): BusyCheckResult {
	// Check CLI activity first.
	const cliActivity = getCliActivityForSession(agentId);
	if (cliActivity && isSessionBusyWithCli(agentId)) {
		return {
			busy: true,
			reason: `Running "${cliActivity.playbookName}" from CLI (PID: ${cliActivity.pid})`,
		};
	}

	// Then desktop state.
	const desktopBusy = isSessionBusyInDesktop(agentId);
	if (desktopBusy.busy) {
		return { busy: true, reason: 'Busy in desktop app' };
	}

	return { busy: false };
}

/**
 * Format a wait duration in human-readable form ("500ms", "5s", "2m 30s").
 *
 * NOTE: the ladder deliberately stops at minutes, unlike formatElapsedTime,
 * which rolls up into hours. A CLI wait is bounded by a timeout, so a long one
 * is more legible as "90m 0s" than as "1h 30m" - the minute count is what the
 * caller set and what they are watching.
 */
export function formatWaitDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return humanizeDuration(ms, { units: ['minute', 'second'], keepZeroUnits: true });
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
	initialBusy: BusyCheckResult,
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
