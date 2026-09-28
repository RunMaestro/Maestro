// List terminals command - enumerate open terminal tabs in the Maestro desktop app.
//
// Terminal tabs live only in the desktop's renderer state, so unlike the other
// `list` subcommands this one has to ask the running app rather than read from
// disk. It exists so a caller can find the tab id to hand to `send-terminal`.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface ListTerminalsOptions {
	agent?: string;
	json?: boolean;
}

interface TerminalTabEntry {
	tabId: string;
	agentId: string;
	agentName: string;
	name: string;
	cwd: string;
	pid: number;
	state: string;
	active: boolean;
	startupCommand: string | null;
}

export async function listTerminals(options: ListTerminalsOptions): Promise<void> {
	// No --agent lists every agent's terminals; the desktop treats an omitted
	// sessionId as "all", which is more useful than defaulting to the active
	// agent when you are hunting for a tab you opened somewhere else.
	let sessionId: string | undefined;
	if (options.agent) {
		try {
			sessionId = resolveAgentId(options.agent);
		} catch (error) {
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				error?: string;
				tabs?: TerminalTabEntry[];
			}>({ type: 'list_terminal_tabs', sessionId }, 'list_terminal_tabs_result');
		});

		if (!result.success) {
			const error = result.error || 'Failed to list terminal tabs';
			if (options.json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}

		const tabs = result.tabs ?? [];

		if (options.json) {
			console.log(JSON.stringify({ success: true, tabs }, null, 2));
			return;
		}

		if (tabs.length === 0) {
			console.log('No open terminal tabs.');
			return;
		}

		// One tab per line so the output greps and pipes cleanly.
		// Columns: state | active marker | tabId | agent | name | cwd.
		for (const tab of tabs) {
			const marker = tab.active ? '*' : ' ';
			const startup = tab.startupCommand ? `  [startup: ${tab.startupCommand}]` : '';
			console.log(
				`${tab.state.padEnd(6)} ${marker} ${tab.tabId}  ${tab.agentName} (${tab.agentId})  ${
					tab.name
				}  ${tab.cwd}${startup}`
			);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: msg }));
		else console.error(`Error: ${msg}`);
		process.exit(1);
	}
}
