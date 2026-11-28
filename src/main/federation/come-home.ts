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
 * - An agent home with its host copy still there (`hostCopyLeft`: a crash or a lost link between
 *   the restore and the removal, or an offline return) is finished: the host is tried again, what
 *   it wrote since comes home, and the copy is removed, so the agent has one owner (I3). A host
 *   that still does not answer is left for the next launch, for {@link HOST_COPY_RETRY_MS} only.
 *
 * This is the one Federation path that connects with hosting off. It is bounded: when the last
 * agent is settled it holds no timer and no forward (I6).
 */

import { isFederationRemote } from '../../shared/federationRemote';
import { peerAgentRef, readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import {
	readHostCopyLeft,
	type ReturnRunOptions,
} from '../../shared/maestro-lib/agents/lift-return';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../shared/types';
import type { DesktopReturnAnswer } from './lift';
import type { ComeHomeAgentOutcome, ComeHomeReport } from '../../shared/federationComeHome';

export type { ComeHomeAgentOutcome, ComeHomeReport } from '../../shared/federationComeHome';

/** How many times the online return is tried before the agent comes back offline. */
export const COME_HOME_ONLINE_ATTEMPTS = 3;
/** The wait between two online attempts. */
export const COME_HOME_RETRY_WAIT_MS = 5_000;
/** The wait between two checks of a turn still running on the host. */
export const COME_HOME_BUSY_WAIT_MS = 10_000;
/** How long a running host turn is waited out before the agent is left for the next launch. */
export const COME_HOME_BUSY_MAX_WAIT_MS = 30 * 60_000;
/**
 * How long after an agent came home its leftover host copy is still dialed for, one try per
 * launch. A remote that is gone for good is not dialed at every launch forever.
 */
export const HOST_COPY_RETRY_MS = 14 * 24 * 60 * 60_000;

/** Refusals that a later attempt can get past: the host did not answer, or the window did not. */
const RETRYABLE_CODES = new Set([
	'PEER_NOT_CONNECTED',
	'RETURN_HOST_FAILED',
	'RETURN_RESTORE_FAILED',
	'RETURN_FAILED',
]);

export interface ComeHomeDeps {
	readAgents(): AgentRecord[];
	/** The configured SSH remotes: a deleted, disabled, or opted-out one is not dialed. */
	readRemotes(): SshRemoteConfig[];
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

/** The records home again whose host copy is still to remove, and still worth a dial at `now`. */
export function hostCopiesLeft(agents: readonly AgentRecord[], now: number): AgentRecord[] {
	return agents.filter((agent) => {
		if (readLiftedTo(agent.liftedTo)) return false;
		const left = readHostCopyLeft(agent.hostCopyLeft);
		return left !== undefined && now - left.returnedAt < HOST_COPY_RETRY_MS;
	});
}

/**
 * Why the host must not be dialed for this agent, or undefined when it may be. A remote the user
 * deleted, disabled, or opted out of Federation is not dialed: the agent comes back offline, so it
 * is never stranded on a host Maestro may not reach.
 */
export function onlineSkipReason(
	agent: AgentRecord,
	remotes: readonly SshRemoteConfig[]
): string | undefined {
	const ssh = (agent as { sessionSshRemoteConfig?: { remoteId?: unknown } }).sessionSshRemoteConfig;
	const remoteId = typeof ssh?.remoteId === 'string' ? ssh.remoteId : undefined;
	if (!remoteId) return undefined; // The return refuses it with its own reason (RETURN_NO_SSH).
	const remote = remotes.find((candidate) => candidate.id === remoteId);
	if (!remote) return 'Its SSH remote is no longer configured on this machine.';
	if (remote.enabled === false) return `Its SSH remote "${remote.name}" is disabled.`;
	if (!isFederationRemote(remote)) {
		return `Its SSH remote "${remote.name}" is opted out of Federation.`;
	}
	return undefined;
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

/**
 * Finish an agent that is home with its host copy still there: one online try (plus waiting out a
 * turn the copy runs). Null when there is nothing to tell: the remote may not be dialed, or the
 * host still does not answer (the person was told where the copy is when the agent came home).
 */
async function finishHostCopy(
	agent: AgentRecord,
	deps: ComeHomeDeps,
	timing: Required<ComeHomeTiming>
): Promise<ComeHomeAgentOutcome | null> {
	const left = readHostCopyLeft(agent.hostCopyLeft);
	if (!left || onlineSkipReason(agent, deps.readRemotes())) return null;
	const outcome: ComeHomeAgentOutcome = {
		id: agent.id,
		name: agent.name,
		from: peerAgentRef(left.peer, left.agentId),
		result: 'online',
		notices: [],
	};
	let waitedMs = 0;
	for (;;) {
		// Settings can change during a wait: no dial once hosting is on or the remote may not be dialed.
		if (deps.hostingEnabled() || onlineSkipReason(agent, deps.readRemotes())) return null;
		const answer = await deps.returnAgent(agent.id, {});
		if (answer.ok) {
			if (answer.result.hostCopyRemoved) {
				outcome.notices.push(`Its old copy on ${left.peer} is removed.`);
			}
			outcome.notices.push(...(answer.result.notices ?? []));
			return outcome;
		}
		if (answer.code !== 'RETURN_BUSY' || waitedMs >= timing.busyMaxWaitMs) return null;
		outcome.waitedForHostTurn = true;
		await deps.sleep(timing.busyWaitMs);
		waitedMs += timing.busyWaitMs;
	}
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
	let skipReason: string | undefined;
	while (attempts < timing.onlineAttempts) {
		// Read before every try, since a wait can be long: hosting turned on leaves the agent where
		// the person now wants it, and a remote disabled or opted out meanwhile is not dialed.
		if (deps.hostingEnabled()) return null;
		skipReason = onlineSkipReason(agent, deps.readRemotes());
		if (skipReason) break;
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
	if (deps.hostingEnabled()) return null;
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
	if (skipReason) outcome.notices.push(`The host was not contacted. ${skipReason}`);
	else if (lastError) outcome.notices.push(`The host did not answer: ${lastError}`);
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
		/** Agents this run already dialed for: a copy they left is for the next launch. */
		const tried = new Set<string>();
		for (const { id } of movedAgents(deps.readAgents())) {
			tried.add(id);
			// Re-read: an earlier return or a user's Move Back may have settled it meanwhile.
			const current = deps.readAgents().find((agent) => agent.id === id);
			if (!current || deps.hostingEnabled()) continue;
			const outcome = await bringHome(current, deps, resolved);
			if (outcome) agents.push(outcome);
		}
		for (const { id } of hostCopiesLeft(deps.readAgents(), deps.now())) {
			const current = deps.readAgents().find((agent) => agent.id === id);
			if (!current || tried.has(id) || deps.hostingEnabled()) continue;
			const outcome = await finishHostCopy(current, deps, resolved);
			if (outcome) agents.push(outcome);
		}
	}
	return { startedAt, finishedAt: deps.now(), agents };
}

/** The job as main runs it: one run at a time, and the last report kept for the CLI. */
export interface ComeHomeRunner {
	/** Start the job, or join the run in flight. */
	run(): Promise<ComeHomeReport>;
	/** The report of the last finished run, or null before one finished. */
	lastReport(): ComeHomeReport | null;
}

/**
 * Single flight: a second call while a run is in flight gets that run's promise, so no agent is
 * ever returned by two runs at once (I5). A later call runs again; agents already home are skipped.
 */
export function createComeHomeRunner(
	deps: ComeHomeDeps,
	timing: ComeHomeTiming = {}
): ComeHomeRunner {
	let inFlight: Promise<ComeHomeReport> | null = null;
	let last: ComeHomeReport | null = null;
	return {
		run() {
			if (!inFlight) {
				inFlight = runComeHome(deps, timing)
					.then((report) => {
						last = report;
						return report;
					})
					.finally(() => {
						inFlight = null;
					});
			}
			return inFlight;
		},
		lastReport: () => last,
	};
}
