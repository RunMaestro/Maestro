// Open terminal command - open a new terminal tab in the Maestro desktop app

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface OpenTerminalOptions {
	agent?: string;
	cwd?: string;
	shell?: string;
	name?: string;
	json?: boolean;
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
			if (options.json) console.log(JSON.stringify({ success: true, sessionId }));
			else console.log('Terminal tab opened in Maestro');
		} else {
			const error = result.error || 'Failed to open terminal tab';
			if (options.json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: msg }));
		else console.error(`Error: ${msg}`);
		process.exit(1);
	}
}
