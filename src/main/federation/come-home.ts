/**
 * Every moved agent comes home (hotfix v1.1.3-RC, workstream H2).
 *
 * v1.1.1-RC and v1.1.2-RC moved SSH agents onto a Federation host without asking. With hosting off
 * (`federationHostedAgents`, off by default since v1.1.3-RC), each record that still carries a
 * `liftedTo` pointer is returned here, once per launch, with no click and no question:
 *
 * - One agent at a time per SSH remote, so one remote never sees two SSH connections from this
 *   job (I5). Remotes run side by side, so one slow host does not hold up the others.
 * - Online first, through the same `returnAgentFromDesktop()` that Move Back from Host and
 *   `maestro-cli unlift` run. The host's tabs and transcripts come back and its copy is removed.
 * - A turn running on the host is waited out, never interrupted: the return is retried after it,
 *   over one held connection. Past {@link COME_HOME_BUSY_MAX_WAIT_MS} the agent comes back with
 *   this machine's copy and the host keeps its own, finished later (`hostCopyLeft`).
 * - A host that does not answer is tried a small, fixed number of times. Then the agent is
 *   returned offline, so it works now, and the result records what could not be fetched. The other
 *   agents on that remote are not dialed again in the same run.
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
import {
	comeHomeFailureFor,
	comeHomeWaitText,
	type ComeHomeAgentOutcome,
	type ComeHomeReport,
} from '../../shared/federationComeHome';

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
	/**
	 * End the connection held for SSH remote `remoteId` (`holdHostConnections()`), so the returns
	 * between two calls reuse one. Absent: each return opens and ends its own.
	 */
	releaseConnection?(remoteId: string): Promise<void>;
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
 * Why the host must not be dialed for this agent, or undefined when it may be. An agent with no
 * SSH remote turned on, or a remote the user deleted, disabled, or opted out of Federation, is not
 * dialed: the agent comes back offline, so it is never stranded on a host Maestro may not reach.
 */
export function onlineSkipReason(
	agent: AgentRecord,
	remotes: readonly SshRemoteConfig[]
): string | undefined {
	const ssh = (agent as { sessionSshRemoteConfig?: { enabled?: boolean } }).sessionSshRemoteConfig;
	const remoteId = remoteIdOf(agent);
	// The same rule as the return's own (`RETURN_NO_SSH`): the host is reached through this remote.
	if (!ssh?.enabled || !remoteId) return 'It has no SSH remote turned on in Edit Agent.';
	const remote = remotes.find((candidate) => candidate.id === remoteId);
	if (!remote) return 'Its SSH remote is no longer configured on this machine.';
	if (remote.enabled === false) return `Its SSH remote "${remote.name}" is disabled.`;
	if (!isFederationRemote(remote)) {
		return `Its SSH remote "${remote.name}" is opted out of Federation.`;
	}
	return undefined;
}

/** The SSH remote id an agent runs on, or undefined when it has none. */
function remoteIdOf(agent: AgentRecord): string | undefined {
	const remoteId = (agent as { sessionSshRemoteConfig?: { remoteId?: unknown } })
		.sessionSshRemoteConfig?.remoteId;
	return typeof remoteId === 'string' && remoteId ? remoteId : undefined;
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
	const remoteId = remoteIdOf(agent);
	try {
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
			// The connection stays held: the next check reuses it.
			await deps.sleep(timing.busyWaitMs);
			waitedMs += timing.busyWaitMs;
		}
	} finally {
		if (remoteId) await deps.releaseConnection?.(remoteId);
	}
}

async function bringHome(
	agent: AgentRecord,
	deps: ComeHomeDeps,
	timing: Required<ComeHomeTiming>,
	/** Remotes that did not answer earlier in this run: their agents are not dialed again. */
	unreachable: Set<string>
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
	const remoteId = remoteIdOf(agent);
	const release = async () => {
		if (remoteId) await deps.releaseConnection?.(remoteId);
	};

	let attempts = 0;
	let waitedMs = 0;
	let lastError = '';
	let lastCode = '';
	let skipReason: string | undefined;
	let refusedForGood = false;
	let busyTooLong = false;
	try {
		while (attempts < timing.onlineAttempts) {
			// Read before every try, since a wait can be long: hosting turned on leaves the agent where
			// the person now wants it, and a remote disabled or opted out meanwhile is not dialed.
			if (deps.hostingEnabled()) return null;
			skipReason = onlineSkipReason(agent, deps.readRemotes());
			if (!skipReason && remoteId && unreachable.has(remoteId)) {
				skipReason = 'Its host did not answer for another agent a moment ago.';
			}
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
					busyTooLong = true;
					break;
				}
				// The connection stays held: the next check reuses it.
				await deps.sleep(timing.busyWaitMs);
				waitedMs += timing.busyWaitMs;
				continue;
			}
			// Anything else may have broken the link: the next try dials again.
			await release();
			lastError = answer.error;
			lastCode = answer.code;
			// A refusal no retry can fix must not leave the agent moved: restore it here now.
			if (!RETRYABLE_CODES.has(answer.code)) {
				refusedForGood = true;
				break;
			}
			attempts++;
			if (attempts < timing.onlineAttempts) await deps.sleep(timing.retryWaitMs);
		}
	} finally {
		await release();
	}
	// The host never answered: its other agents in this run go straight to the local restore.
	if (remoteId && lastCode === 'PEER_NOT_CONNECTED' && !refusedForGood && !busyTooLong) {
		unreachable.add(remoteId);
	}

	// The host did not answer, may not be dialed, refused for good, or runs a turn past the limit:
	// come back with this machine's copy, so the agent works now and nothing stays moved. The host
	// copy is kept (`hostCopyLeft`) and finished when the host answers.
	if (deps.hostingEnabled()) return null;
	const offline = await deps.returnAgent(agent.id, { offline: true });
	if (!offline.ok) {
		if (offline.code === 'RETURN_NOT_HOSTED') return null;
		outcome.reason = `This machine could not restore it: ${offline.error}`;
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
	if (busyTooLong) {
		outcome.notices.push(
			`A turn has run on ${pointer.peer} for more than ${Math.round(timing.busyMaxWaitMs / 60_000)} minutes. It is not stopped: ${pointer.peer} keeps its copy, and what that turn writes comes home when Maestro finishes the copy.`
		);
	} else if (skipReason) outcome.notices.push(`The host was not contacted. ${skipReason}`);
	else if (refusedForGood) outcome.notices.push(`The return was refused: ${lastError}`);
	else if (lastCode === 'PEER_NOT_CONNECTED') {
		outcome.notices.push(`The host did not answer: ${lastError}`);
	} else if (lastError) outcome.notices.push(`The host answered with an error: ${lastError}`);
	outcome.notices.push(...(offline.result.notices ?? []));
	return outcome;
}

/** The agents grouped by SSH remote, in list order; agents with no remote share one lane. */
function lanesByRemote(agents: readonly AgentRecord[]): AgentRecord[][] {
	const lanes = new Map<string, AgentRecord[]>();
	for (const agent of agents) {
		const key = remoteIdOf(agent) ?? '';
		const lane = lanes.get(key);
		if (lane) lane.push(agent);
		else lanes.set(key, [agent]);
	}
	return [...lanes.values()];
}

/**
 * Return every moved agent, one at a time per SSH remote. Does nothing while hosting is on. Never throws for one
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
		const unreachable = new Set<string>();
		const moved = movedAgents(deps.readAgents());
		const outcomes = new Map<string, ComeHomeAgentOutcome>();
		// One lane per SSH remote, run side by side; inside a lane, one agent at a time (I5).
		await Promise.all(
			lanesByRemote(moved).map(async (lane) => {
				for (const { id } of lane) {
					tried.add(id);
					// Re-read: an earlier return or a user's Move Back may have settled it meanwhile.
					const current = deps.readAgents().find((agent) => agent.id === id);
					if (!current || deps.hostingEnabled()) continue;
					const outcome = await bringHome(current, deps, resolved, unreachable);
					if (outcome) outcomes.set(id, outcome);
				}
			})
		);
		for (const { id } of moved) {
			const outcome = outcomes.get(id);
			if (outcome) agents.push(outcome);
		}
		for (const { id } of hostCopiesLeft(deps.readAgents(), deps.now())) {
			const current = deps.readAgents().find((agent) => agent.id === id);
			if (!current || tried.has(id) || deps.hostingEnabled()) continue;
			const remoteId = remoteIdOf(current);
			if (remoteId && unreachable.has(remoteId)) continue;
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

let comeHomeRunner: ComeHomeRunner | null = null;

/**
 * The job that brings moved agents home, once the IPC handlers built it. `federation auto` and the
 * spawn refusal for a moved agent read its last report.
 */
export function getComeHomeRunner(): ComeHomeRunner | null {
	return comeHomeRunner;
}

export function setComeHomeRunner(next: ComeHomeRunner | null): void {
	comeHomeRunner = next;
}

/**
 * The spawn refusal for an agent still moved onto a host while hosting is off: the same true reason
 * its queued messages show (`comeHomeWaitText()`), from the job's last report.
 */
export function movedAgentWaitRefusal(agent: {
	id: string;
	name?: string;
	liftedTo?: unknown;
}): string {
	const peer = readLiftedTo(agent.liftedTo)?.peer ?? 'its host';
	const failure = comeHomeFailureFor(getComeHomeRunner()?.lastReport(), agent.id);
	return `"${agent.name ?? 'This agent'}" is still on its Federation host. ${comeHomeWaitText(peer, failure)}`;
}
