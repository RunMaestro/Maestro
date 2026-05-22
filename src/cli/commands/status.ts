// Status command
// Checks whether the Maestro desktop app is reachable via CLI IPC.

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { formatError } from '../output/formatter';
import { withMaestroClient } from '../services/maestro-client';

interface SessionsListResult {
	type: 'sessions_list';
	sessions?: unknown[];
}

export async function status(): Promise<void> {
	const info = readCliServerInfo();
	if (!info) {
		console.log('Maestro desktop app is not running');
		return;
	}

	if (!isCliServerRunning()) {
		console.log('Maestro discovery file is stale (app may have crashed)');
		return;
	}

	try {
		const sessionCount = await withMaestroClient(async (client) => {
			await client.sendCommand({ type: 'ping' }, 'pong');
			const result = await client.sendCommand<SessionsListResult>(
				{ type: 'get_sessions' },
				'sessions_list'
			);
			return Array.isArray(result.sessions) ? result.sessions.length : 0;
		});

		console.log(`Maestro is running on port ${info.port} with ${sessionCount} sessions`);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(formatError(`Failed to reach Maestro desktop app: ${message}`));
		process.exit(1);
	}
}
