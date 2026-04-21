// Open terminal command - open a new terminal tab in the Maestro desktop app

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface OpenTerminalOptions {
	agent?: string;
	cwd?: string;
	shell?: string;
	name?: string;
}

export async function openTerminal(options: OpenTerminalOptions): Promise<void> {
	let sessionId: string;
	if (options.agent) {
		try {
			sessionId = resolveAgentId(options.agent);
		} catch (error) {
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	} else {
		sessionId = resolveSessionId({});
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'open_terminal_tab',
					sessionId,
					cwd: options.cwd,
					shell: options.shell,
					name: options.name,
				},
				'open_terminal_tab_result'
			);
		});

		if (result.success) {
			console.log('Terminal tab opened in Maestro');
		} else {
			console.error(`Error: ${result.error || 'Failed to open terminal tab'}`);
			process.exit(1);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
