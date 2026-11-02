// Interrupt command - stop a running turn, the CLI path to the Stop pill.
//
// No --tab is the agent-level Stop the desktop pill runs: every busy tab of the
// agent, its consults and its pending retries. --tab narrows it to one tab
// (exact id, unique prefix, or `active`). Both run the renderer's
// `interruptTurn()` through the `interrupt_turn` WS message, so the CLI, the
// REST route and the desktop share one implementation.
//
// Nothing running is a success with `wasBusy: false`, so the verb is safe to
// re-run. Read the result back with `tab show <tab-id>` or `session list --json`.

import { withMaestroClient } from '../services/maestro-client';
import {
	errorFrameMessage,
	failCommand,
	failFromError,
	resolveAgentOrFail,
	resolveTabEntry,
	type DesktopTabEntry,
} from '../services/session-command';
import { ExitCode, exitWith } from '../exit-codes';
import { formatError, formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { readCallerIdentity } from '../../shared/agentDelegation';
import {
	INTERRUPT_TURN_REPLY_TIMEOUT_MS,
	type InterruptTurnResult,
} from '../../shared/turnInterrupt';

export interface InterruptOptions {
	/** One tab: exact id, unique prefix, or `active` (this agent's active tab). */
	tab?: string;
	json?: boolean;
}

type InterruptReply = Partial<InterruptTurnResult> & { type?: string };

export async function interrupt(agentId: string, options: InterruptOptions): Promise<void> {
	const json = options.json;
	const sessionId = resolveAgentOrFail(agentId, json);

	// Bridge calls only inside the try, so a failCommand exit below is never
	// caught and reported a second time.
	let tabEntry: DesktopTabEntry | undefined;
	if (options.tab !== undefined) {
		try {
			tabEntry = await resolveTabEntry(options.tab, sessionId);
		} catch (error) {
			failFromError(error, json);
		}
		if (tabEntry.agentId !== sessionId) {
			failCommand(`Tab ${tabEntry.tabId} belongs to agent ${tabEntry.agentId}`, json);
		}
	}
	const tabId = tabEntry?.tabId;

	// The stop ladder kills the turn's whole process tree, and this CLI runs
	// inside it when an agent stops itself, so it could never report back.
	// Only agent turns carry the identity; a human's shell is never refused.
	const caller = readCallerIdentity(process.env);
	if (caller?.agentId === sessionId && (!tabId || tabId === caller.tabId)) {
		failCommand(
			tabId
				? `Refusing to interrupt tab ${tabId}: it is running this command. Name another tab with --tab <tab-id>.`
				: `Refusing to interrupt agent ${sessionId}: its running turn is this command. Name another tab with --tab <tab-id>.`,
			json
		);
	}

	let reply: InterruptReply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<InterruptReply>(
				{ type: 'interrupt_turn', sessionId, ...(tabId ? { tabId } : {}) },
				'interrupt_turn_result',
				INTERRUPT_TURN_REPLY_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, json);
	}

	const frameError = errorFrameMessage(reply);
	if (frameError) failCommand(frameError, json);

	if (reply.success !== true) {
		const message = reply.error || 'Interrupt failed';
		if (json) {
			console.log(
				JSON.stringify({ success: false, error: message, ...(reply.code && { code: reply.code }) })
			);
		} else {
			console.error(formatError(message));
		}
		// A renderer that never answered is a timeout (exit 5), like a CLI-side one.
		exitWith(reply.code === 'RENDERER_TIMEOUT' ? ExitCode.Timeout : ExitCode.GeneralError);
	}

	const result = {
		wasBusy: reply.wasBusy === true,
		interrupted: reply.interrupted === true,
		stoppedTabIds: Array.isArray(reply.stoppedTabIds) ? reply.stoppedTabIds : [],
		exited: reply.exited === true,
	};

	if (json) {
		console.log(
			JSON.stringify({ success: true, agentId: sessionId, tabId: tabId ?? null, ...result })
		);
		return;
	}
	if (isQuiet()) return;

	const target = tabId ? `tab ${tabId}` : `agent ${sessionId}`;
	if (!result.wasBusy) {
		console.log(`Nothing to stop: no turn is running on ${target}`);
		return;
	}
	const tabs = result.stoppedTabIds;
	const count = Math.max(tabs.length, 1);
	const where = tabs.length > 0 ? ` (tab${tabs.length === 1 ? '' : 's'} ${tabs.join(', ')})` : '';
	console.log(formatSuccess(`Stopped ${count} turn${count === 1 ? '' : 's'} on ${target}${where}`));
	if (!result.exited) {
		const check = tabId ?? tabs[0];
		console.log(
			check
				? `The process is still exiting; check with: maestro-cli tab show ${check}`
				: 'The process is still exiting; check with: maestro-cli session list --json'
		);
	}
}
