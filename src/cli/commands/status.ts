// Status command - check if a Maestro host (the desktop app, or the headless
// `maestro-cli host`) is running and reachable

import {
	readCliServerInfo,
	isCliServerRunning,
	type CliServerInfo,
} from '../../shared/cli-server-discovery';
import { withMaestroClient } from '../services/maestro-client';
import {
	MAESTRO_NOT_RUNNING_HINT,
	MAESTRO_NOT_RUNNING_MESSAGE,
} from '../services/maestro-not-running';
import { ExitCode } from '../exit-codes';
import { failCommand } from '../services/session-command';

/**
 * Said when no host is reachable: the one message every app-dependent verb
 * prints (`MAESTRO_NOT_RUNNING_MESSAGE`), then what to do on a machine that has
 * no desktop app at all.
 */
export const NOT_RUNNING_MESSAGE = `${MAESTRO_NOT_RUNNING_MESSAGE}. ${MAESTRO_NOT_RUNNING_HINT}`;

/** The peer the discovery file names, as a person reads it. */
export function describeHost(info: Pick<CliServerInfo, 'hostKind' | 'pid'>): string {
	return info.hostKind === 'headless'
		? `The headless Maestro host (\`maestro-cli host\`, pid ${info.pid})`
		: 'Maestro';
}

export interface StatusOptions {
	json?: boolean;
}

export async function status(options: StatusOptions = {}): Promise<void> {
	const info = readCliServerInfo();
	if (!info) {
		failCommand(NOT_RUNNING_MESSAGE, options.json, ExitCode.NotRunning);
	}

	if (!isCliServerRunning()) {
		failCommand(
			info.hostKind === 'headless'
				? 'Maestro discovery file is stale (the headless host may have crashed; `maestro-cli host start` starts a new one)'
				: 'Maestro discovery file is stale (app may have crashed)',
			options.json,
			ExitCode.NotRunning
		);
	}

	try {
		// Ping to verify WebSocket connectivity
		await withMaestroClient(async (client) => {
			await client.sendCommand<{ type: string }>({ type: 'ping' }, 'pong');

			// Get session count
			const sessionsResult = await client.sendCommand<{ type: string; sessions: unknown[] }>(
				{ type: 'get_sessions' },
				'sessions_list'
			);

			const sessionCount = sessionsResult.sessions?.length ?? 0;
			if (options.json) {
				console.log(
					JSON.stringify({ success: true, running: true, port: info.port, agents: sessionCount })
				);
			} else {
				console.log(
					`${describeHost(info)} is running on port ${info.port} with ${sessionCount} agent${sessionCount !== 1 ? 's' : ''}`
				);
			}
		});
	} catch (error) {
		failCommand(
			error instanceof Error ? error.message : String(error),
			options.json,
			ExitCode.NotRunning
		);
	}
}
