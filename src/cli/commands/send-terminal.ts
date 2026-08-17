// Send-terminal command - type into an already-open Maestro terminal tab.
//
// `open-terminal` makes a new terminal; this one talks to a terminal that is
// already there, which is what you want to drive a shell the user is watching:
// run a command in it, or Ctrl-C the dev server it is running.

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface SendTerminalOptions {
	agent?: string;
	tab?: string;
	control?: string;
	/** Commander sets this false when `--no-enter` is passed. */
	enter?: boolean;
	json?: boolean;
}

interface WriteResult {
	type: string;
	success: boolean;
	error?: string;
	tabId?: string;
	tabName?: string;
}

/**
 * Translate `--control C` into the control character a PTY expects. Ctrl-A is
 * 0x01 through Ctrl-Z 0x1a, which is just the letter's position in the
 * alphabet, so the whole range comes from one subtraction.
 */
function controlCharFor(name: string): string | null {
	const trimmed = name.trim().toUpperCase();
	if (!/^[A-Z]$/.test(trimmed)) return null;
	return String.fromCharCode(trimmed.charCodeAt(0) - 64);
}

export async function sendTerminal(
	command: string | undefined,
	options: SendTerminalOptions
): Promise<void> {
	const hasCommand = typeof command === 'string' && command.trim() !== '';
	const hasControl = typeof options.control === 'string' && options.control.trim() !== '';

	if (hasCommand === hasControl) {
		const error = hasCommand
			? 'Pass either a command or --control, not both'
			: 'Nothing to send: pass a command, or --control <letter>';
		if (options.json) console.log(JSON.stringify({ success: false, error }));
		else console.error(`Error: ${error}`);
		process.exit(1);
	}

	let data: string;
	if (hasControl) {
		const char = controlCharFor(options.control as string);
		if (!char) {
			const error = `Invalid --control value: ${options.control} (expected a single letter, e.g. C for Ctrl-C)`;
			if (options.json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
		data = char;
	} else {
		// A trailing newline is what actually runs the command. `--no-enter`
		// leaves it typed but unexecuted, so a human can read it before
		// committing to it.
		data = options.enter === false ? (command as string) : `${command as string}\n`;
	}

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
			return client.sendCommand<WriteResult>(
				{ type: 'write_terminal_tab', sessionId, tabRef: options.tab, data },
				'write_terminal_tab_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(
					JSON.stringify({
						success: true,
						sessionId,
						tabId: result.tabId ?? null,
						tabName: result.tabName ?? null,
					})
				);
			} else {
				const where = result.tabName ? ` to ${result.tabName}` : '';
				if (hasControl) {
					console.log(`Sent Ctrl-${(options.control as string).trim().toUpperCase()}${where}`);
				} else if (options.enter === false) {
					console.log(`Typed${where} (not run - no Enter sent)`);
				} else {
					console.log(`Ran in Maestro terminal${where}: ${command}`);
				}
			}
		} else {
			const error = result.error || 'Failed to write to the terminal tab';
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
