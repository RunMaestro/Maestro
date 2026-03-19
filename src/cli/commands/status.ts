// Status command - check if Maestro desktop app is running and reachable

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { withMaestroClient } from '../services/maestro-client';

export async function status(): Promise<void> {
	const info = readCliServerInfo();
	if (!info) {
		console.log('Maestro desktop app is not running');
		process.exit(1);
	}

	if (!isCliServerRunning()) {
		console.log('Maestro discovery file is stale (app may have crashed)');
		process.exit(1);
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
			console.log(
				`Maestro is running on port ${info.port} with ${sessionCount} agent${sessionCount !== 1 ? 's' : ''}`
			);
		});
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
