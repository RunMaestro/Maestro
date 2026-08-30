// Read-terminal command - read the scrollback of an open Maestro terminal tab.
//
// The read half of `send-terminal`. Without it the terminal is a write-only
// device for an agent: `open-terminal --command "npm run dev"` is the right way
// to run a long-lived process, but the agent that started it could not see a
// single line it printed.
//
// The buffer comes from xterm, which has already interpreted the escape
// sequences, so what arrives here is plain text - there are no colour codes to
// strip and no --raw opt-out to offer.

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface ReadTerminalOptions {
	agent?: string;
	tab?: string;
	tail?: string;
	json?: boolean;
}

interface ReadResult {
	type: string;
	success: boolean;
	error?: string;
	tabId?: string;
	tabName?: string;
	cwd?: string;
	state?: string;
	content?: string;
	totalLines?: number;
}

/**
 * Bounded by default: a `tail -f` tab can hold a lot of scrollback, and dumping
 * all of it into an agent's context is worse than useless. Pass `--tail` for
 * more (the renderer caps it at MAX_TERMINAL_READ_LINES regardless).
 */
export const DEFAULT_TAIL_LINES = 200;

export async function readTerminal(options: ReadTerminalOptions): Promise<void> {
	const fail = (error: string): never => {
		if (options.json) console.log(JSON.stringify({ success: false, error }));
		else console.error(`Error: ${error}`);
		process.exit(1);
	};

	let tail = DEFAULT_TAIL_LINES;
	if (options.tail !== undefined) {
		const parsed = Number(options.tail);
		if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
			fail(`Invalid --tail value: ${options.tail} (expected a positive whole number)`);
		}
		tail = parsed;
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
			return client.sendCommand<ReadResult>(
				{ type: 'read_terminal_tab', sessionId, tabRef: options.tab, tail },
				'read_terminal_tab_result'
			);
		});

		if (!result.success) {
			fail(result.error || 'Failed to read the terminal tab');
		}

		const content = result.content ?? '';

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						success: true,
						sessionId,
						tabId: result.tabId ?? null,
						name: result.tabName ?? null,
						cwd: result.cwd ?? null,
						state: result.state ?? null,
						// `busy` is what tells an agent whether the command is still
						// running or the output it just read is final.
						busy: result.state === 'busy',
						totalLines: result.totalLines ?? null,
						lines: content === '' ? [] : content.split('\n'),
					},
					null,
					2
				)
			);
			return;
		}

		// Plain text by default - the buffer is already text, and agents grep it.
		if (content !== '') console.log(content);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
