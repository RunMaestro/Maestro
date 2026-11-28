/**
 * Every moved agent comes home (hotfix v1.1.3-RC, workstream H2).
 *
 * v1.1.1-RC and v1.1.2-RC moved SSH agents onto a Federation host without asking. With hosting off
 * (`federationHostedAgents`, off by default since v1.1.3-RC), each record that still carries a
 * `liftedTo` pointer is returned here, once per launch, with no click and no question:
 *
 * - One agent at a time, so one remote never sees two SSH connections from this job (I5).
 * - Online first, through the same `returnAgentFromDesktop()` that Move Back from Host and
 *   `maestro-cli unlift` run. The host's tabs and transcripts come back and its copy is removed.
 * - A turn running on the host is waited out, never interrupted: the return is retried after it.
 * - A host that does not answer is tried a small, fixed number of times. Then the agent is
 *   returned offline, so it works now, and the result records what could not be fetched.
 * - An agent already home is skipped, so a crash or a quit mid-way is finished by the next run.
 *
 * This is the one Federation path that connects with hosting off. It is bounded: when the last
 * agent is settled it holds no timer and no forward (I6).
 */

import { peerAgentRef, readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import type { ReturnRunOptions } from '../../shared/maestro-lib/agents/lift-return';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { DesktopReturnAnswer } from './lift';

/** How many times the online return is tried before the agent comes back offline. */
export const COME_HOME_ONLINE_ATTEMPTS = 3;
/** The wait between two online attempts. */
export const COME_HOME_RETRY_WAIT_MS = 5_000;
/** The wait between two checks of a turn still running on the host. */
export const COME_HOME_BUSY_WAIT_MS = 10_000;
/** How long a running host turn is waited out before the agent is left for the next launch. */
export const COME_HOME_BUSY_MAX_WAIT_MS = 30 * 60_000;

/** Refusals that a later attempt can get past: the host did not answer, or the window did not. */
const RETRYABLE_CODES = new Set([
	'PEER_NOT_CONNECTED',
	'RETURN_HOST_FAILED',
	'RETURN_RESTORE_FAILED',
	'RETURN_FAILED',
]);

/** One agent the job settled, or could not. */
export interface ComeHomeAgentOutcome {
	id: string;
	name: string;
	/** `peer:agentId` it was hosted as. */
	from: string;
	/**
	 * `online`: back with the host's tabs and transcripts. `offline`: back with only this machine's
	 * copy (see `missing`). `failed`: still moved; the next launch tries again.
	 */
	result: 'online' | 'offline' | 'failed';
	/** A turn on the host held this agent back until it ended. */
	waitedForHostTurn?: boolean;
	/** Offline only: what the host may hold that this machine does not, and where it is. */
	missing?: {
		peer: string;
		hostAgentId: string;
		/** When the agent moved. Anything the host wrote after this may be missing here. */
		movedAt: number;
		/** The newest transcript row this machine holds, if any. */
		lastLocalRowAt?: number;
	};
	/** What the return reported (host copy left behind, a failure's reason). */
	notices: string[];
}

export interface ComeHomeReport {
	startedAt: number;
	finishedAt: number;
	agents: ComeHomeAgentOutcome[];
}

export interface ComeHomeDeps {
	readAgents(): AgentRecord[];
	/** Hosting on means the agent stays moved: the job does nothing. */
	hostingEnabled(): boolean;
	/** `returnAgentFromDesktop()` with the desktop's deps. */
	returnAgent(agentId: string, options: ReturnRunOptions): Promise<DesktopReturnAnswer>;
	sleep(ms: number): Promise<void>;
	now(): number;
}

export interface ComeHomeTiming {
	onlineAttempts?: number;
	retryWaitMs?: number;
	busyWaitMs?: number;
	busyMaxWaitMs?: number;
}

/** The records that still point at a host. */
export function movedAgents(agents: readonly AgentRecord[]): AgentRecord[] {
	return agents.filter((agent) => readLiftedTo(agent.liftedTo) !== undefined);
}

function newestRowAt(agent: AgentRecord): number | undefined {
	let newest: number | undefined;
	for (const tab of agent.aiTabs ?? []) {
		for (const row of tab.logs ?? []) {
			const at = (row as { timestamp?: unknown }).timestamp;
			if (typeof at === 'number' && Number.isFinite(at) && (newest === undefined || at > newest)) {
				newest = at;
			}
		}
	}
	return newest;
}

async function bringHome(
	agent: AgentRecord,
	deps: ComeHomeDeps,
	timing: Required<ComeHomeTiming>
): Promise<ComeHomeAgentOutcome | null> {
	const pointer = readLiftedTo(agent.liftedTo);
	if (!pointer) return null;
	const outcome: ComeHomeAgentOutcome = {
		id: agent.id,
		name: agent.name,
		from: peerAgentRef(pointer.peer, pointer.agentId),
		result: 'failed',
		notices: [],
	};

	let attempts = 0;
	let waitedMs = 0;
	let lastError = '';
	while (attempts < timing.onlineAttempts) {
		const answer = await deps.returnAgent(agent.id, {});
		if (answer.ok) {
			outcome.result = 'online';
			outcome.notices.push(...(answer.result.notices ?? []));
			return outcome;
		}
		// Moved back by someone else since the list was read (Move Back, `unlift`): done.
		if (answer.code === 'RETURN_NOT_HOSTED') return null;
		if (answer.code === 'RETURN_BUSY') {
			outcome.waitedForHostTurn = true;
			if (waitedMs >= timing.busyMaxWaitMs) {
				outcome.notices.push(
					`A turn has run on the host for more than ${Math.round(timing.busyMaxWaitMs / 60_000)} minutes. The agent stays on the host until it ends; Maestro tries again at the next launch.`
				);
				return outcome;
			}
			await deps.sleep(timing.busyWaitMs);
			waitedMs += timing.busyWaitMs;
			continue;
		}
		lastError = answer.error;
		if (!RETRYABLE_CODES.has(answer.code)) {
			outcome.notices.push(answer.error);
			return outcome;
		}
		attempts++;
		if (attempts < timing.onlineAttempts) await deps.sleep(timing.retryWaitMs);
	}

	// The host did not answer: come back with this machine's copy, so the agent works now.
	const offline = await deps.returnAgent(agent.id, { offline: true });
	if (!offline.ok) {
		if (offline.code === 'RETURN_NOT_HOSTED') return null;
		outcome.notices.push(offline.error);
		return outcome;
	}
	outcome.result = 'offline';
	outcome.missing = {
		peer: pointer.peer,
		hostAgentId: pointer.agentId,
		movedAt: pointer.at,
		...(newestRowAt(agent) !== undefined ? { lastLocalRowAt: newestRowAt(agent) } : {}),
	};
	if (lastError) outcome.notices.push(`The host did not answer: ${lastError}`);
	outcome.notices.push(...(offline.result.notices ?? []));
	return outcome;
}

/**
 * Return every moved agent, one at a time. Does nothing while hosting is on. Never throws for one
 * agent's failure: it is reported and the job moves on.
 */
export async function runComeHome(
	deps: ComeHomeDeps,
	timing: ComeHomeTiming = {}
): Promise<ComeHomeReport> {
	const resolved: Required<ComeHomeTiming> = {
		onlineAttempts: timing.onlineAttempts ?? COME_HOME_ONLINE_ATTEMPTS,
		retryWaitMs: timing.retryWaitMs ?? COME_HOME_RETRY_WAIT_MS,
		busyWaitMs: timing.busyWaitMs ?? COME_HOME_BUSY_WAIT_MS,
		busyMaxWaitMs: timing.busyMaxWaitMs ?? COME_HOME_BUSY_MAX_WAIT_MS,
	};
	const startedAt = deps.now();
	const agents: ComeHomeAgentOutcome[] = [];
	if (!deps.hostingEnabled()) {
		for (const { id } of movedAgents(deps.readAgents())) {
			// Re-read: an earlier return or a user's Move Back may have settled it meanwhile.
			const current = deps.readAgents().find((agent) => agent.id === id);
			if (!current || deps.hostingEnabled()) continue;
			const outcome = await bringHome(current, deps, resolved);
			if (outcome) agents.push(outcome);
		}
	}
	return { startedAt, finishedAt: deps.now(), agents };
}
