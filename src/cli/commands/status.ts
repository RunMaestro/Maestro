// Status command - check if Maestro desktop app is running and reachable

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';
import { withMaestroClient } from '../services/maestro-client';
import { ExitCode } from '../exit-codes';

export async function status(): Promise<void> {
	const info = readCliServerInfo();
	if (!info) {
		console.log('Maestro desktop app is not running');
		process.exit(ExitCode.NotRunning);
	}

	if (!isCliServerRunning()) {
		console.log('Maestro discovery file is stale (app may have crashed)');
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

			// Which mode the desktop runs in (DG14). An older app answers `echo`, which reads as the
			// standard mode, so a failed ask prints nothing rather than failing a healthy status.
			try {
				const app = await client.sendCommand<{ type: string; runtimeHosting?: boolean }>(
					{ type: 'get_app_info' },
					'app_info'
				);
				if (app.runtimeHosting === true) console.log('Agent state: library runtime (main)');
			} catch {
				// Not worth failing `status` over.
			}
		});
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(ExitCode.NotRunning);
	}
}
