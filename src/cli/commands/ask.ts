// Ask command - consult another agent and print its answer.
//
// The agent-to-agent counterpart of `dispatch`, and the difference between them
// is the whole point:
//
//   dispatch  hands WORK to an agent. The prompt lands in a real tab (the active
//             one unless you name another), so it appears mid-conversation in
//             whatever the human has open there, and the reply goes to the
//             screen rather than back to you.
//   ask       asks a QUESTION of an agent. It rides the same consult path a
//             typed `@mention` does - a hidden tab on the target, a fresh
//             context, no focus, no unread - and the answer comes back here.
//
// So: `ask` when you want an answer, `dispatch` when you want the other agent to
// go do something.

import { resolveAgentId } from '../services/storage';
import { withMaestroClient } from '../services/maestro-client';

export interface AskOptions {
	/** Your own agent id. Attribution + continuity on the target's consult tab. */
	from?: string;
	/** Forward your current transcript as context (off by default). */
	withContext?: boolean;
	/** Seconds to wait for the answer. */
	timeout?: string;
	json?: boolean;
}

/** Bounds mirrored from the main-process handler, which clamps again. */
const DEFAULT_TIMEOUT_SECONDS = 600;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 3600;

/**
 * Extra slack on the websocket wait so the DESKTOP's timeout is the one that
 * fires. Its message names the agent that went quiet; a client-side timeout can
 * only say the app did not answer, which sends the caller debugging Maestro
 * instead of the consult.
 */
const CLIENT_TIMEOUT_GRACE_MS = 15_000;

interface AskResponse {
	type: string;
	success: boolean;
	answer?: string;
	error?: string;
	canceled?: boolean;
	targetAgentName?: string;
	targetTabId?: string;
}

export async function ask(agentId: string, question: string, options: AskOptions): Promise<void> {
	/**
	 * Report and stop. Every caller `return`s after this even though
	 * `process.exit` does not come back: a validation failure that kept going
	 * would still consult the agent, and the tests that prove a bad invocation
	 * consults nobody can only do that if the guard actually stops.
	 */
	const fail = (message: string) => {
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: message }));
		} else {
			console.error(`Error: ${message}`);
		}
		process.exit(1);
	};

	if (!question.trim()) {
		fail('question cannot be empty');
		return;
	}

	let targetSessionId: string;
	try {
		targetSessionId = resolveAgentId(agentId);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		return;
	}

	let fromSessionId: string | undefined;
	if (options.from) {
		try {
			fromSessionId = resolveAgentId(options.from);
		} catch (error) {
			fail(`--from: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (fromSessionId === targetSessionId) {
			fail('an agent cannot consult itself');
			return;
		}
	}

	let seconds = DEFAULT_TIMEOUT_SECONDS;
	if (options.timeout !== undefined) {
		seconds = Number(options.timeout);
		if (
			!Number.isFinite(seconds) ||
			seconds < MIN_TIMEOUT_SECONDS ||
			seconds > MAX_TIMEOUT_SECONDS
		) {
			fail(`--timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`);
			return;
		}
	}
	const timeoutMs = Math.round(seconds * 1000);

	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<AskResponse>(
				{
					type: 'cross_agent_ask',
					sessionId: targetSessionId,
					question,
					fromSessionId,
					withContext: options.withContext === true,
					timeoutMs,
				},
				'cross_agent_ask_result',
				timeoutMs + CLIENT_TIMEOUT_GRACE_MS
			)
		);

		if (options.json) {
			console.log(
				JSON.stringify({
					success: result.success,
					answer: result.answer,
					error: result.error,
					canceled: result.canceled,
					agentId: targetSessionId,
					agentName: result.targetAgentName,
					tabId: result.targetTabId,
				})
			);
			if (!result.success) process.exit(1);
			return;
		}

		// A stopped or failed consult can still have said something useful before
		// it ended. Print the partial on stdout and the reason on stderr rather
		// than discarding one of them.
		if (result.answer) console.log(result.answer);
		if (!result.success) {
			console.error(
				result.canceled
					? `Consult with ${result.targetAgentName ?? 'the agent'} was stopped`
					: `Error: ${result.error || 'the agent did not answer'}`
			);
			process.exit(1);
		}
		if (!result.answer) {
			console.error(`Note: ${result.targetAgentName ?? 'The agent'} answered with nothing`);
		}
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
