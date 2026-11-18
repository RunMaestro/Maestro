// Claude TUI canary command - did the installed Claude Code pass a TUI turn?
//
// The running app runs one real maestro-p turn after every Claude Code (or
// Maestro) update and raises a toast when it fails (see
// src/main/agents/claude-tui-canary.ts). Without flags this reads the last
// result, including what Claude Code showed when it failed. `--run` runs the
// canary now, whatever the version, and prints the new result.

import { withMaestroClient } from '../services/maestro-client';
import { formatError, formatSuccess, colorize } from '../output/formatter';
import { formatRelativeTime } from '../../shared/formatters';
import type {
	ClaudeTuiCanaryResult,
	ClaudeTuiCanaryRunOutcome,
} from '../../shared/claudeTuiCanary';

/** A canary turn may sit through startup dialogs and a cold Claude boot. */
const RUN_TIMEOUT_MS = 4 * 60 * 1000;

interface ClaudeCanaryOptions {
	run?: boolean;
	json?: boolean;
}

function fail(message: string, json?: boolean): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(formatError(message));
	process.exit(1);
}

function printResult(result: ClaudeTuiCanaryResult): void {
	const when = formatRelativeTime(result.checkedAt);
	if (result.ok) {
		console.log(
			formatSuccess(`Claude Code ${result.claudeVersion} passed the TUI canary (${when})`)
		);
	} else {
		console.log(
			`${colorize('red', 'FAILED')} Claude Code ${result.claudeVersion} (${when}): ${result.error ?? 'failed'}` +
				(result.exitCode !== null ? `, exit ${result.exitCode}` : '')
		);
		if (result.screen) {
			console.log('\nWhat Claude Code last showed:\n');
			console.log(result.screen);
		}
	}
	console.log(`\nAccount: ${result.configDir}  Maestro: ${result.maestroVersion}`);
}

export async function claudeCanary(options: ClaudeCanaryOptions): Promise<void> {
	if (options.run) {
		let response: { success: boolean; error?: string; outcome?: ClaudeTuiCanaryRunOutcome };
		try {
			response = await withMaestroClient((client) =>
				client.sendCommand<typeof response & { type: string }>(
					{ type: 'claude_canary_run' },
					'claude_canary_run_result',
					RUN_TIMEOUT_MS
				)
			);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options.json);
		}
		if (!response.success || !response.outcome) {
			fail(response.error || 'The canary did not run', options.json);
		}
		const outcome = response.outcome;
		if (options.json) {
			console.log(JSON.stringify({ success: true, ...outcome }));
		} else if (outcome.ran) {
			printResult(outcome.result);
		} else {
			console.log(`Did not run: ${outcome.reason}`);
		}
		// Exit 2 for a failed canary, so a script can tell it from a CLI error.
		if (outcome.ran && !outcome.result.ok) process.exit(2);
		if (!outcome.ran) process.exit(1);
		return;
	}

	let response: { success: boolean; error?: string; last?: ClaudeTuiCanaryResult | null };
	try {
		response = await withMaestroClient((client) =>
			client.sendCommand<typeof response & { type: string }>(
				{ type: 'claude_canary_status' },
				'claude_canary_status_result'
			)
		);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
	if (!response.success) fail(response.error || 'Could not read the canary', options.json);
	const last = response.last ?? null;
	if (options.json) {
		console.log(JSON.stringify({ success: true, last }));
		return;
	}
	if (!last) {
		console.log('The canary has not run yet. Run it with: maestro-cli claude-canary --run');
		return;
	}
	printResult(last);
	if (!last.ok) process.exit(2);
}
