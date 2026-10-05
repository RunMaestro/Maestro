// Status command - check if Maestro desktop app is running and reachable

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { withMaestroClient } from '../services/maestro-client';
import { MAESTRO_NOT_RUNNING_MESSAGE } from '../services/maestro-not-running';
import { ExitCode } from '../exit-codes';

export async function status(): Promise<void> {
	const info = readCliServerInfo();
	if (!info) {
		console.log(MAESTRO_NOT_RUNNING_MESSAGE);
		process.exit(ExitCode.NotRunning);
	}

	if (!isCliServerRunning()) {
		// Same outcome as no file at all, said the same way; the stale pid is
		// the only extra fact worth a second line.
		console.log(MAESTRO_NOT_RUNNING_MESSAGE);
		console.log(`(discovery file is stale: pid ${info.pid} is gone, the app may have crashed)`);
		process.exit(ExitCode.NotRunning);
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
		process.exit(ExitCode.NotRunning);
	}
}
