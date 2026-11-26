/**
 * Whether each SSH remote can be reached right now, and telling the user when
 * that changes.
 *
 * Every path Maestro takes to a remote (agent turns, file reads and saves, the
 * file tree, git polls, shell commands) used to fail on its own terms when the
 * host went away: a raw `Connection closed by UNKNOWN port 65535` in one place,
 * `{}` in the System Log in another, and nothing at all for an agent turn whose
 * stderr matched no pattern. Five agents on one remote meant five unrelated
 * symptoms of one problem.
 *
 * Each of those paths now reports its ssh exit code here (`noteSshExit`). ssh
 * exits 255 only for its OWN failures (host down, tunnel dead, auth refused),
 * so a 255 makes the remote SUSPECT, not down: a tunnelled transport such as a
 * tailcat `ProxyCommand` drops the odd connection under a burst, and a modal
 * for that would be noise. A suspect remote gets one probe (single-flight). If
 * the probe also fails, the remote is UNREACHABLE: one event goes out, the
 * renderer shows one dialog for it, and a background re-probe watches for the
 * host to come back. Any later ssh run that gets through, or a probe that
 * succeeds, marks it reachable and announces the recovery.
 *
 * A remote that also hosts Federation agents is dialed by Federation too (its
 * port forward, discovery, re-probes). On a tunnelled transport those dials
 * collide with Maestro's own git and file-tree ssh, and the loser exits 255.
 * While Federation holds a live connection to that remote (`hasLiveTransport`),
 * the host is provably up, so such a 255 costs no probe: without this, a hosted
 * agent's remote cycled through the unreachable dialog and the "SSH connection
 * restored" toast over and over while nothing was actually down.
 *
 * A hosted agent's turns run on the Maestro host behind its remote, so a host that stops
 * answering stops that agent the same way a dead link does. The Federation mirror reports its
 * connection to each host here (`noteHostConnection`); a host one of this machine's agents runs on
 * that stays down past a short grace is an outage of the same remote with cause `host`: the same
 * event, dialog, re-check and recovery. ssh itself down outranks it: one remote, one dialog.
 *
 * The module imports nothing from Electron; the transport (`emit`), the remote
 * lookup and the probe are injected once at startup, so the process manager and
 * remote-fs can call it unconditionally. Before configuration every call is a
 * no-op.
 */

import type { SshRemoteConfig } from '../shared/types';
import type { PeerMirrorConnection } from '../shared/maestro-lib/client/peer-mirror';
import {
	describeSshUnreachable,
	isSshConnectionFailure,
	SSH_CONNECTION_FAILED_EXIT_CODE,
	SSH_RECOVERY_PROBE_INTERVAL_SECONDS,
	type SshReachabilityEvent,
} from '../shared/sshConnection';
import { logger } from './utils/logger';

const LOG_CONTEXT = 'SshReachability';

/**
 * After a probe finds a remote healthy, further suspicion is ignored this long.
 * A repo whose `git status` keeps timing out on a live host (an iCloud folder)
 * would otherwise cost a probe on every poll tick.
 */
const SUSPICION_COOLDOWN_MS = 15_000;

/** What `execFileNoThrow` reports when it killed a child for running too long. */
const SSH_TIMEOUT_EXIT_CODE = 'ETIMEDOUT';

/** How often an unreachable remote is probed to detect that it came back. */
export const SSH_RECOVERY_PROBE_INTERVAL_MS = SSH_RECOVERY_PROBE_INTERVAL_SECONDS * 1000;

/** The result of one probe: what ssh exited with, and what it said. */
export interface SshProbeOutcome {
	exitCode: number | string;
	stderr: string;
}

export interface SshReachabilityDeps {
	/** The current config for a remote id, or undefined when it was deleted. */
	resolveRemote: (remoteId: string) => SshRemoteConfig | undefined;
	/** Run a trivial command on the remote (`true`) and report how ssh exited. */
	probe: (remote: SshRemoteConfig) => Promise<SshProbeOutcome>;
	/** Deliver a state change to every client. */
	emit: (event: SshReachabilityEvent) => void;
	/**
	 * Whether another live connection to this remote proves it is up right now
	 * (a connected Federation peer). Optional: without it every 255 is suspect.
	 */
	hasLiveTransport?: (remoteId: string) => boolean;
	/**
	 * Whether an agent on this machine runs on the Maestro host behind `peerId` (a hosted agent).
	 * Optional: without it no host outage is ever raised.
	 */
	hostsAgents?: (peerId: string) => boolean;
	/** Ask the Federation peer on `remoteId` to reconnect now. Resolves true when it attached. */
	reconnectHost?: (remoteId: string) => Promise<boolean>;
}

interface UnreachableState {
	event: SshReachabilityEvent;
	timer: ReturnType<typeof setInterval> | null;
}

let deps: SshReachabilityDeps | null = null;
const unreachable = new Map<string, UnreachableState>();
const probesInFlight = new Map<string, Promise<boolean>>();
/** Epoch ms of the last probe that found each remote reachable. */
const lastHealthyProbeAt = new Map<string, number>();

/**
 * How long a hosted agent's host may stay disconnected before it is an outage. The client's own
 * reconnect (backoff from 0.5 s) gets this long to bring a dropped connection back, so a blip
 * raises nothing; an SSH outage is confirmed in about the same time (one probe).
 */
export const HOST_OUTAGE_CONFIRM_MS = 8_000;

/** How the Federation mirror stands with the host on one remote (`MirrorPeerSummary`). */
export interface HostConnectionReport {
	remoteId: string;
	peerId: string;
	/** The remote's name, for the dialog. */
	name: string;
	connection: PeerMirrorConnection;
	/** The mirror's message for a failure, naming the fix. */
	error?: string;
}

interface HostOutageState {
	event: SshReachabilityEvent;
	peerId: string;
	timer: ReturnType<typeof setInterval> | null;
}

/** Host outages by remote id: ssh answers, but the Maestro host behind it does not. */
const hostDown = new Map<string, HostOutageState>();
/** Remotes whose host dropped and is being given `HOST_OUTAGE_CONFIRM_MS` to come back. */
const hostPending = new Map<
	string,
	{ report: HostConnectionReport; timer: ReturnType<typeof setTimeout> }
>();
/** The last connection each peer reported, so a confirm or an SSH recovery reads the current one. */
const lastHostReport = new Map<string, HostConnectionReport>();

/** Wire the transport and probe. Called once from main startup. */
export function configureSshReachability(next: SshReachabilityDeps | null): void {
	deps = next;
}

/** A remote failed to connect when its probe exited 255 or ssh could not be spawned. */
function probeFailed(outcome: SshProbeOutcome): boolean {
	return typeof outcome.exitCode === 'string' || isSshConnectionFailure(outcome.exitCode);
}

function labelFor(remote: Pick<SshRemoteConfig, 'name' | 'host'>): string {
	return remote.name?.trim() || remote.host;
}

/**
 * Record how an ssh run to `remote` ended.
 *
 * Exit 255 makes the remote suspect, and so does a caller's timeout firing
 * (`ETIMEDOUT`), which is how a tunnel that accepts and then hangs looks. Being
 * suspect costs one probe, so a timeout from a slow git status in an iCloud
 * folder is cleared by the probe succeeding rather than raising a dialog. Any
 * other number proves ssh reached the host. Other string codes (a spawn
 * failure such as a missing ssh binary) say nothing about the network.
 */
export function noteSshExit(
	remote: SshRemoteConfig | string | null | undefined,
	exitCode: number | string | null | undefined
): void {
	if (!deps || remote == null || exitCode == null) return;
	const remoteId = typeof remote === 'string' ? remote : remote.id;
	if (!remoteId) return;

	if (exitCode === SSH_CONNECTION_FAILED_EXIT_CODE || exitCode === SSH_TIMEOUT_EXIT_CODE) {
		if (unreachable.has(remoteId)) return;
		const healthyAt = lastHealthyProbeAt.get(remoteId);
		if (healthyAt !== undefined && Date.now() - healthyAt < SUSPICION_COOLDOWN_MS) return;
		if (deps.hasLiveTransport?.(remoteId)) {
			logger.debug(
				`ssh exit ${exitCode} ignored: a live Federation connection holds the remote`,
				LOG_CONTEXT,
				{ remoteId }
			);
			return;
		}
		void checkSshRemote(remoteId);
		return;
	}
	if (typeof exitCode === 'number') markReachable(remoteId);
}

/**
 * Probe a remote now and settle its state from the answer. Single-flight per
 * remote: callers arriving while a probe runs share its result. Returns true
 * when the remote is reachable.
 *
 * This is what the dialog's "Check Now" and `maestro-cli` call, so it also
 * works for a remote nobody has reported as failing yet.
 */
export function checkSshRemote(remoteId: string): Promise<boolean> {
	const running = probesInFlight.get(remoteId);
	if (running) return running;

	const run = (async () => {
		const current = deps;
		const remote = current?.resolveRemote(remoteId);
		if (!current || !remote) {
			// A deleted remote can no longer be down.
			clearUnreachable(remoteId, false);
			return false;
		}
		let outcome: SshProbeOutcome;
		try {
			outcome = await current.probe(remote);
		} catch (err) {
			outcome = { exitCode: 'EPROBE', stderr: err instanceof Error ? err.message : String(err) };
		}
		if (probeFailed(outcome)) {
			markUnreachable(remote, outcome.stderr);
			return false;
		}
		lastHealthyProbeAt.set(remoteId, Date.now());
		markReachable(remoteId);
		return true;
	})();

	probesInFlight.set(remoteId, run);
	void run.finally(() => probesInFlight.delete(remoteId));
	return run;
}

function markUnreachable(remote: SshRemoteConfig, stderr: string): void {
	const message = describeSshUnreachable(remote, stderr);
	const existing = unreachable.get(remote.id);
	if (existing) {
		// Still down. Keep the original `since`; refresh the reason, since a
		// tunnel's error text can change while it stays broken.
		existing.event = { ...existing.event, message };
		return;
	}

	const event: SshReachabilityEvent = {
		remoteId: remote.id,
		remoteName: labelFor(remote),
		reachable: false,
		message,
		since: Date.now(),
	};
	const timer = setInterval(() => {
		void checkSshRemote(remote.id);
	}, SSH_RECOVERY_PROBE_INTERVAL_MS);
	// Never keep the process alive just to watch a dead host.
	timer.unref?.();
	unreachable.set(remote.id, { event, timer });

	logger.warn(`SSH remote unreachable: ${event.remoteName}`, LOG_CONTEXT, { message });
	deps?.emit(event);
}

function markReachable(remoteId: string): void {
	clearUnreachable(remoteId, true);
}

function clearUnreachable(remoteId: string, announce: boolean): void {
	const state = unreachable.get(remoteId);
	if (!state) return;
	if (state.timer) clearInterval(state.timer);
	unreachable.delete(remoteId);

	if (!announce) return;
	const event: SshReachabilityEvent = {
		remoteId,
		remoteName: state.event.remoteName,
		reachable: true,
		since: Date.now(),
	};
	logger.info(`SSH remote reachable again: ${event.remoteName}`, LOG_CONTEXT);
	deps?.emit(event);
	recheckHostAfterSshRecovery(remoteId);
}

/**
 * A host that dropped while ssh itself was down was never shown: the SSH dialog covered it. Once
 * ssh is back, the host gets the same grace as a fresh drop, so a host that reconnects with the
 * link raises nothing and one that stays down gets its own dialog.
 */
function recheckHostAfterSshRecovery(remoteId: string): void {
	const held = hostDown.get(remoteId);
	if (!held) return;
	if (held.timer) clearInterval(held.timer);
	hostDown.delete(remoteId);
	const report = lastHostReport.get(remoteId);
	if (report && report.connection !== 'connected') armHostConfirm(report);
}

/**
 * Record how the Federation mirror stands with the host on a remote (every `peer.state` push).
 *
 * A host that a hosted agent runs on and that stops answering is an outage of that remote, told
 * the same way as an SSH outage: one event, one dialog, a re-check every
 * `SSH_RECOVERY_PROBE_INTERVAL_SECONDS`, and one recovery event. A drop gets
 * `HOST_OUTAGE_CONFIRM_MS` to reconnect first. Before it is raised, ssh is probed: when the remote
 * itself is down, the SSH outage (which names every agent on the remote) is the one the user
 * sees, and the host outage is held silently behind it.
 */
export function noteHostConnection(report: HostConnectionReport): void {
	if (!deps) return;
	lastHostReport.set(report.remoteId, report);
	if (report.connection === 'connected') {
		clearHostPending(report.remoteId);
		clearHostDown(report.remoteId, true);
		return;
	}
	const held = hostDown.get(report.remoteId);
	if (held) {
		// Still down: refresh the reason, keep the original `since`.
		held.event = { ...held.event, message: describeHostUnreachable(report) };
		return;
	}
	// A first connect has not answered yet: nothing was lost.
	if (report.connection === 'connecting' && !hostPending.has(report.remoteId)) return;
	armHostConfirm(report);
}

/** Stop following the host of a peer that is no longer mirrored (deleted, opted out, renamed). */
export function forgetHostPeer(peerId: string): void {
	for (const [remoteId, report] of lastHostReport) {
		if (report.peerId === peerId) forgetHostConnection(remoteId);
	}
}

function forgetHostConnection(remoteId: string): void {
	lastHostReport.delete(remoteId);
	clearHostPending(remoteId);
	clearHostDown(remoteId, false);
}

function armHostConfirm(report: HostConnectionReport): void {
	const pending = hostPending.get(report.remoteId);
	if (pending) {
		pending.report = report;
		return;
	}
	const timer = setTimeout(() => void confirmHostDown(report.remoteId), HOST_OUTAGE_CONFIRM_MS);
	timer.unref?.();
	hostPending.set(report.remoteId, { report, timer });
}

function clearHostPending(remoteId: string): void {
	const pending = hostPending.get(remoteId);
	if (!pending) return;
	clearTimeout(pending.timer);
	hostPending.delete(remoteId);
}

async function confirmHostDown(remoteId: string): Promise<void> {
	const pending = hostPending.get(remoteId);
	if (!pending || !deps) return;
	if (!deps.hostsAgents?.(pending.report.peerId)) {
		// No agent here runs on this host: a remote without one is not an outage.
		clearHostPending(remoteId);
		return;
	}
	// Tell a stopped host from a dead remote. A failed probe raises the SSH outage.
	await checkSshRemote(remoteId);
	const still = hostPending.get(remoteId);
	if (!still) return; // Reconnected while the probe ran.
	clearHostPending(remoteId);
	markHostDown(still.report);
}

/** The dialog's reason for a host outage: what is down, and the fix when there is one. */
export function describeHostUnreachable(report: HostConnectionReport): string {
	switch (report.connection) {
		case 'host-down':
		case 'not-installed':
		case 'outdated':
			if (report.error) return report.error;
			break;
		default:
			break;
	}
	return `The Maestro host on "${report.name}" stopped answering. The SSH connection to the remote works; the host process there is not running or not responding.`;
}

function markHostDown(report: HostConnectionReport): void {
	const event: SshReachabilityEvent = {
		remoteId: report.remoteId,
		remoteName: report.name,
		reachable: false,
		message: describeHostUnreachable(report),
		since: Date.now(),
		cause: 'host',
	};
	const timer = setInterval(() => {
		// While ssh itself is down its own re-probe runs; the host waits for it.
		if (!unreachable.has(report.remoteId)) void checkRemoteLink(report.remoteId);
	}, SSH_RECOVERY_PROBE_INTERVAL_MS);
	timer.unref?.();
	hostDown.set(report.remoteId, { event, peerId: report.peerId, timer });
	if (unreachable.has(report.remoteId)) return;
	logger.warn(`Maestro host unreachable: ${event.remoteName}`, LOG_CONTEXT, {
		message: event.message,
	});
	deps?.emit(event);
}

function clearHostDown(remoteId: string, announce: boolean): void {
	const state = hostDown.get(remoteId);
	if (!state) return;
	if (state.timer) clearInterval(state.timer);
	hostDown.delete(remoteId);
	// Behind an SSH outage the host was never shown; the SSH recovery announces the remote.
	if (!announce || unreachable.has(remoteId)) return;
	const event: SshReachabilityEvent = {
		remoteId,
		remoteName: state.event.remoteName,
		reachable: true,
		since: Date.now(),
		cause: 'host',
	};
	logger.info(`Maestro host reachable again: ${event.remoteName}`, LOG_CONTEXT);
	deps?.emit(event);
}

/**
 * Check everything Maestro needs on a remote: ssh first, then, when its host is held down, the
 * host (a reconnect). This is the dialog's "Check Now" and `maestro-cli ssh-remote status
 * --check`. Resolves true when the remote and its host both answer.
 */
export async function checkRemoteLink(remoteId: string): Promise<boolean> {
	const sshUp = await checkSshRemote(remoteId);
	if (!sshUp || !hostDown.has(remoteId) || !deps?.reconnectHost) return sshUp;
	try {
		// The reconnect pushes `peer.state`, which clears the outage through `noteHostConnection`.
		return await deps.reconnectHost(remoteId);
	} catch (error) {
		logger.warn('Maestro host reconnect failed', LOG_CONTEXT, {
			remoteId,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * Every remote currently known to be unreachable, for a client that just connected: one event per
 * remote, the SSH outage when ssh itself is down, else the host outage.
 */
export function getUnreachableSshRemotes(): SshReachabilityEvent[] {
	const events = [...unreachable.values()].map((state) => state.event);
	for (const [remoteId, state] of hostDown) {
		if (!unreachable.has(remoteId)) events.push(state.event);
	}
	return events;
}

/** Test-only: drop all state and timers. */
export function __resetSshReachabilityForTest(): void {
	for (const state of unreachable.values()) {
		if (state.timer) clearInterval(state.timer);
	}
	unreachable.clear();
	probesInFlight.clear();
	lastHealthyProbeAt.clear();
	for (const state of hostDown.values()) {
		if (state.timer) clearInterval(state.timer);
	}
	hostDown.clear();
	for (const pending of hostPending.values()) clearTimeout(pending.timer);
	hostPending.clear();
	lastHostReport.clear();
	deps = null;
}
