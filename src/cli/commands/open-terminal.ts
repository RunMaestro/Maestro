// Open terminal command - open a new terminal tab in the Maestro desktop app.
//
// Switches to the new tab, as it always has. Pass --background to create it
// without moving the view - the tab still appears in the agent's tab bar.

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';

interface OpenTerminalOptions {
	agent?: string;
	cwd?: string;
	shell?: string;
	name?: string;
	command?: string;
	background?: boolean;
	focus?: boolean;
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

	const background = resolveBackgroundFlag(options, 'open-terminal');

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
					background,
				},
				'open_terminal_tab_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(
					JSON.stringify({ success: true, sessionId, tabId: result.tabId ?? null, background })
				);
			} else {
				const where = background ? ' (background tab)' : '';
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
