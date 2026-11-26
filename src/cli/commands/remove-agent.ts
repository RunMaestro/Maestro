// Remove agent command - delete an agent from the Maestro desktop app

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';
import { exitIfMaestroNotRunning } from '../services/session-command';
import {
	PeerResolveError,
	hostCallError,
	routeAgentTarget,
	withPeerAgent,
	type PeerTarget,
} from '../services/peer-resolver';
import { ExitCode } from '../exit-codes';
import {
	runningTurnWhere,
	type RunningTurnProbe,
} from '../../shared/maestro-lib/agents/lift-pointer';

interface RemoveAgentOptions {
	json?: boolean;
	/** Remove the agent even while it runs a turn (the turn is stopped and its answer lost). */
	force?: boolean;
}

/**
 * The refusal for an agent that runs a turn, or null. The same rule on this machine and on a peer's
 * host, read from the live state each sends (the bridge's and the host's agent lists read the
 * process table, never the stored state).
 */
export function removeBusyRefusal(agent: RunningTurnProbe, label: string): string | null {
	const where = runningTurnWhere(agent);
	if (where === null) return null;
	return `${label} is running a turn${where ? ` in ${where}` : ''}. Removing it stops the turn and loses its answer: wait for it to finish, or stop it, or pass --force to remove it anyway.`;
}

/** What a remove takes away and what it keeps, said on success. */
export function removedSummary(agent: { aiTabs?: readonly unknown[] } | undefined): string {
	const count = Array.isArray(agent?.aiTabs) ? agent.aiTabs.length : undefined;
	const tabs = count === undefined ? 'its tabs' : `its ${count} tab${count === 1 ? '' : 's'}`;
	return `${tabs}, closed tabs and playbooks are gone and its processes stopped; its History, provider sessions and working directory are kept`;
}

export async function removeAgent(agentId: string, options: RemoveAgentOptions): Promise<void> {
	// `peer:agent` removes the agent on that Federation peer's host, a headless host or a desktop
	// one (the copy a Move Back left there while the host was down). Read it with `show agent`.
	const route = routeAgentTarget(agentId);
	if (route.kind === 'peer') return removePeerAgent(route.target, options);
	// Resolve agent ID (supports partial match / name lookup)
	let sessionId: string;
	try {
		sessionId = resolveAgentId(agentId);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		return process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			// The bridge's list reads each agent's live processes (`isAgentBusy()`).
			const listed = await client.sendCommand<{
				type: string;
				sessions?: Array<RunningTurnProbe & { id: string; aiTabs?: RunningTurnProbe['aiTabs'] }>;
			}>({ type: 'get_sessions' }, 'sessions_list');
			const live = (Array.isArray(listed.sessions) ? listed.sessions : []).find(
				(agent) => agent?.id === sessionId
			);
			const refusal = live && !options.force ? removeBusyRefusal(live, `Agent ${sessionId}`) : null;
			if (refusal) return { success: false, error: refusal, live };
			const deleted = await client.sendCommand<{
				type: string;
				success: boolean;
				sessionId?: string;
				error?: string;
			}>(
				{
					type: 'delete_session',
					sessionId,
				},
				'delete_session_result'
			);
			return { ...deleted, live };
		});

		if (result.success) {
			const removed = removedSummary(result.live);
			if (options.json) {
				console.log(JSON.stringify({ success: true, agentId: sessionId, removed }));
			} else {
				console.log(formatSuccess(`Removed agent ${sessionId}: ${removed}`));
			}
		} else {
			const msg = result.error || 'Failed to remove agent';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}
}

async function removePeerAgent(target: PeerTarget, options: RemoveAgentOptions): Promise<void> {
	try {
		const removed = await withPeerAgent(target, async ({ agent, client, peer }) => {
			// Read fresh: the host sends every record with its live tab state (`withLiveTabState()`).
			const current = await client.agents.get(agent.id);
			if (!current.ok) throw hostCallError(peer, current.error);
			const refusal = options.force
				? null
				: removeBusyRefusal(current.value, `"${current.value.name}" on peer "${peer}"`);
			if (refusal) throw new Error(refusal);
			const result = await client.agents.remove(agent.id);
			if (!result.ok) throw hostCallError(peer, result.error);
			return { agentId: agent.id, peer, removed: removedSummary(current.value) };
		});
		if (options.json) {
			console.log(JSON.stringify({ success: true, ...removed }));
		} else {
			console.log(
				formatSuccess(
					`Removed agent ${removed.agentId} on peer "${removed.peer}": ${removed.removed}`
				)
			);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const peerError = error instanceof PeerResolveError ? error : undefined;
		if (options.json) {
			console.log(
				JSON.stringify({
					success: false,
					error: msg,
					...(peerError ? { peer: peerError.peer } : {}),
				})
			);
		} else {
			console.error(formatError(msg));
		}
		process.exit(peerError?.exitCode ?? ExitCode.GeneralError);
	}
}
