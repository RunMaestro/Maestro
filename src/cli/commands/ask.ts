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
//
// A `peer:agent` target (Federation) sends the same `cross_agent_ask` to that
// peer's host and reads the reply the same way. `--from` and `--with-context`
// name a LOCAL agent and its transcript, which the host cannot see, so they are
// refused there rather than dropped.

import { getSessionById, resolveAgentId } from '../services/storage';
import { AGENT_LIFTED_CODE, liftedSendRefusal } from '../../shared/maestro-lib/agents/lift-pointer';
import { withMaestroClient, type MaestroClient } from '../services/maestro-client';
import { readCallerIdentity } from '../../shared/agentDelegation';
import { admitCliConsult } from '../services/consult-budget-guard';
import { ExitCode, exitWith } from '../exit-codes';
import { exitIfMaestroNotRunning } from '../services/session-command';
import {
	PeerResolveError,
	peerErrorCode,
	routeAgentTarget,
	withPeerAgent,
} from '../services/peer-resolver';

export interface AskOptions {
	/**
	 * Your own agent id. Attribution + continuity on the target's consult tab.
	 * Defaults to the agent this runs under when invoked from a Maestro agent's
	 * shell, so the attribution does not depend on the agent remembering to pass it.
	 */
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
	const fail = (
		message: string,
		extra: Record<string, unknown> = {},
		exitCode: ExitCode = ExitCode.GeneralError
	) => {
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: message, ...extra }));
		} else {
			console.error(`Error: ${message}`);
		}
		exitWith(exitCode);
	};

	if (!question.trim()) {
		fail('question cannot be empty');
		return;
	}

	const timeoutError = `--timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds`;

	const route = routeAgentTarget(agentId);
	if (route.kind === 'peer') {
		if (options.from !== undefined || options.withContext) {
			fail(
				`${options.from !== undefined ? '--from' : '--with-context'} names a local agent, which the host on peer "${route.target.peer}" cannot see. Ask without it.`,
				{},
				ExitCode.InvalidUsage
			);
			return;
		}
		const peerTimeoutMs = parseTimeoutMs(options.timeout);
		if (peerTimeoutMs === null) {
			fail(timeoutError);
			return;
		}
		// A peer consult spends from this machine's chain like a local one. The
		// chain id is not forwarded: the host keeps its own budget ledger.
		const peerAdmission = admitCliConsult();
		if (!peerAdmission.allowed) {
			fail(peerAdmission.message, { code: peerAdmission.code });
			return;
		}
		try {
			await withPeerAgent(route.target, ({ agent, peer, withBridge }) =>
				consult(withBridge, agent.id, question, {}, peerTimeoutMs, options, fail, { peer })
			);
		} catch (error) {
			if (!(error instanceof PeerResolveError)) throw error;
			fail(
				error.message,
				{ code: peerErrorCode(error.code), ...(error.peer ? { peer: error.peer } : {}) },
				error.exitCode
			);
		}
		return;
	}

	let targetSessionId: string;
	try {
		targetSessionId = resolveAgentId(agentId);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		return;
	}
	// A lifted agent answers on its host now, so the question goes there.
	const liftedRefusal = liftedSendRefusal(getSessionById(targetSessionId) ?? {});
	if (liftedRefusal) {
		fail(liftedRefusal, { code: AGENT_LIFTED_CODE });
		return;
	}

	const caller = readCallerIdentity(process.env);
	let fromSessionId: string | undefined;
	if (options.from) {
		try {
			fromSessionId = resolveAgentId(options.from);
		} catch (error) {
			fail(`--from: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
	} else {
		fromSessionId = caller?.agentId;
	}
	if (fromSessionId && fromSessionId === targetSessionId) {
		fail('an agent cannot consult itself');
		return;
	}
	// The spawn's tab only describes the agent it was stamped for. An explicit
	// `--from` naming some other agent must not borrow this shell's tab.
	const fromTabId = caller?.tabId && fromSessionId === caller.agentId ? caller.tabId : undefined;

	const timeoutMs = parseTimeoutMs(options.timeout);
	if (timeoutMs === null) {
		fail(timeoutError);
		return;
	}

	// The consult budget, checked last so an ask that was never going to start
	// spends nothing. An ask from an agent's shell is a consult made while
	// working on some user message: it spends one from that message's chain, and
	// when the chain is out it is refused here, loudly, because an empty answer
	// would read to the calling agent as a peer with nothing to say. An ask the
	// user runs is their own question and always passes. Either way the
	// consulted agent's place in the chain travels in the message and the
	// desktop puts it in the consult's environment, so what THAT agent asks and
	// delegates is counted against the same budget (see admitConsult).
	const admission = admitCliConsult();
	if (!admission.allowed) {
		fail(admission.message, { code: admission.code });
		return;
	}

	await consult(
		withMaestroClient,
		targetSessionId,
		question,
		{ fromSessionId, ...(fromTabId ? { fromTabId } : {}), consultChain: admission.chain },
		timeoutMs,
		options,
		fail
	);
}

/** `--timeout` in ms, the default when absent, or null when it is out of bounds. */
function parseTimeoutMs(timeout: string | undefined): number | null {
	if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS * 1000;
	const seconds = Number(timeout);
	if (!Number.isFinite(seconds) || seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
		return null;
	}
	return Math.round(seconds * 1000);
}

/** Runs one bridge call: the local desktop's, or a peer host's (`withBridge`). */
type BridgeRunner = <T>(action: (client: MaestroClient) => Promise<T>) => Promise<T>;

/**
 * Send `cross_agent_ask` through `run` and print the reply. One body for the local desktop and a
 * peer's host, which answers the same message with the same fields. `extra` is merged into the
 * JSON (a peer's name).
 */
async function consult(
	run: BridgeRunner,
	targetSessionId: string,
	question: string,
	fromFields: Record<string, unknown>,
	timeoutMs: number,
	options: AskOptions,
	fail: (message: string) => void,
	extra: Record<string, unknown> = {}
): Promise<void> {
	try {
		const result = await run(async (client) =>
			client.sendCommand<AskResponse>(
				{
					type: 'cross_agent_ask',
					sessionId: targetSessionId,
					question,
					...fromFields,
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
					...extra,
				})
			);
			if (!result.success) exitWith(ExitCode.GeneralError);
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
			exitWith(ExitCode.GeneralError);
		}
		if (!result.answer) {
			console.error(`Note: ${result.targetAgentName ?? 'The agent'} answered with nothing`);
		}
	} catch (error) {
		// A peer that could not be attached is reported by the caller, with its code and exit code.
		if (error instanceof PeerResolveError) throw error;
		exitIfMaestroNotRunning(error, { json: options.json });
		fail(error instanceof Error ? error.message : String(error));
	}
}
