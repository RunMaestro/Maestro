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
//
// A `peer:agent` target (Federation) stops the turn on that peer's host. The host
// has no `interrupt_turn` (it is the renderer's Stop ladder), so each tab is
// stopped with the bridge's `process:interrupt`, the call the client's
// `turns.interrupt` makes (through `runPeerAgentAction()`, shared with the
// desktop's mirror), and the agent is read back to report `exited`.

import { withMaestroClient } from '../services/maestro-client';
import {
	errorFrameMessage,
	failCommand,
	failFromError,
	resolveAgentOrFail,
	resolveTabEntry,
	type DesktopTabEntry,
} from '../services/session-command';
import {
	PeerResolveError,
	hostCallError,
	peerAgentRef,
	pickHostTab,
	peerErrorCode,
	routeAgentTarget,
	withPeerAgent,
	type PeerTarget,
} from '../services/peer-resolver';
import type { AITabRecord } from '../../shared/maestro-lib/store/records';
import {
	runPeerAgentAction,
	type PeerAgentActionResult,
} from '../../shared/maestro-lib/client/peer-actions';
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
	const route = routeAgentTarget(agentId);
	if (route.kind === 'peer') return interruptPeer(route.target, options);
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

	reportStopped({ agentId: sessionId, tabId: tabId ?? null, ...result }, json, (check) =>
		check ? `maestro-cli tab show ${check}` : 'maestro-cli session list --json'
	);
}

interface StopReport {
	agentId: string;
	tabId: string | null;
	wasBusy: boolean;
	interrupted: boolean;
	stoppedTabIds: string[];
	exited: boolean;
	/** Federation: the peer whose host ran the turn. */
	peer?: string;
}

/** Print a stop, local or on a peer, the one way. `checkWith` names the read-back command. */
function reportStopped(
	report: StopReport,
	json: boolean | undefined,
	checkWith: (tabId: string | undefined) => string
): void {
	if (json) {
		console.log(JSON.stringify({ success: true, ...report }));
		return;
	}
	if (isQuiet()) return;

	const target = report.tabId ? `tab ${report.tabId}` : `agent ${report.agentId}`;
	const on = report.peer ? ` on peer ${report.peer}` : '';
	if (!report.wasBusy) {
		console.log(`Nothing to stop: no turn is running on ${target}${on}`);
		return;
	}
	const tabs = report.stoppedTabIds;
	const count = Math.max(tabs.length, 1);
	const where = tabs.length > 0 ? ` (tab${tabs.length === 1 ? '' : 's'} ${tabs.join(', ')})` : '';
	console.log(
		formatSuccess(`Stopped ${count} turn${count === 1 ? '' : 's'} on ${target}${on}${where}`)
	);
	if (!report.exited) {
		console.log(`The process is still exiting; check with: ${checkWith(report.tabId ?? tabs[0])}`);
	}
}

/**
 * Stop a turn on a peer's host. No `--tab` stops every busy tab of the agent, as the Stop pill
 * does; `--tab` stops that tab. Nothing is retried: a dropped forward is an error.
 */
async function interruptPeer(target: PeerTarget, options: InterruptOptions): Promise<void> {
	const json = options.json;
	let report: StopReport;
	try {
		report = await withPeerAgent(target, async ({ agent, client, peer }) => {
			const tabs = agent.aiTabs ?? [];
			let targets: AITabRecord[];
			let tabId: string | null = null;
			if (options.tab !== undefined) {
				let tab: AITabRecord;
				try {
					tab = pickHostTab(tabs, options.tab, agent.activeTabId);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new PeerResolveError(
						'host-failed',
						`${message} (agent ${peerAgentRef(peer, agent.id)})`,
						ExitCode.GeneralError,
						peer
					);
				}
				tabId = tab.id;
				targets = [tab];
			} else {
				targets = tabs.filter((tab) => tab.state === 'busy');
			}

			// The shared action stops the named tab, or every busy tab, as the desktop's Stop does.
			const stopped = await runPeerAgentAction(
				client,
				agent,
				tabId ? { kind: 'interrupt', tabId } : { kind: 'interrupt' }
			);
			if (!stopped.ok) throw hostCallError(peer, stopped.error);
			const { stoppedTabIds } = stopped.value as Extract<
				PeerAgentActionResult,
				{ kind: 'interrupt' }
			>;

			// The host stops a tab by signalling its process; read the agent back to see it settle.
			let exited = true;
			if (stoppedTabIds.length > 0) {
				const fresh = await client.agents.get(agent.id);
				exited =
					fresh.ok &&
					!(fresh.value.aiTabs ?? []).some(
						(tab) => stoppedTabIds.includes(tab.id) && tab.state === 'busy'
					);
			}
			return {
				agentId: agent.id,
				tabId,
				wasBusy: stoppedTabIds.length > 0 || targets.some((tab) => tab.state === 'busy'),
				interrupted: stoppedTabIds.length > 0,
				stoppedTabIds,
				exited,
				peer,
			};
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const peerError = error instanceof PeerResolveError ? error : undefined;
		if (json) {
			console.log(
				JSON.stringify({
					success: false,
					error: message,
					...(peerError ? { code: peerErrorCode(peerError.code), peer: peerError.peer } : {}),
				})
			);
		} else {
			console.error(formatError(message));
		}
		exitWith(peerError?.exitCode ?? ExitCode.GeneralError);
	}
	const peerRef = peerAgentRef(report.peer as string, report.agentId);
	reportStopped(report, json, () => `maestro-cli show agent ${peerRef}`);
}
