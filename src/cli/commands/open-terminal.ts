// Open terminal command - open a new terminal tab in the Maestro desktop app.
//
// `--background` creates the tab without moving the user: the active agent is
// left alone, the new terminal does not become the visible tab, and the target
// agent is not flipped into terminal mode. The tab is still addressable by the
// id printed here, so `send-terminal --tab` works against it immediately.

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface OpenTerminalOptions {
	agent?: string;
	cwd?: string;
	shell?: string;
	name?: string;
	command?: string;
	background?: boolean;
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

	const background = options.background === true;

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				error?: string;
				tabId?: string;
			}>(
				{
					type: 'open_terminal_tab',
					sessionId,
					cwd: options.cwd,
					shell: options.shell,
					name: options.name,
					command: options.command,
					...(background ? { background: true } : {}),
				},
				'open_terminal_tab_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true, sessionId, tabId: result.tabId ?? null }));
			} else {
				const where = background ? ' in the background' : '';
				console.log(
					options.command
						? `Terminal tab opened in Maestro${where}, running: ${options.command}`
						: `Terminal tab opened in Maestro${where}`
				);
				// Surface the id in plain output too - it's the handle for
				// `send-terminal --tab`, and agents shouldn't need --json to get it.
				if (result.tabId) console.log(`  Tab: ${result.tabId}`);
			}
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
