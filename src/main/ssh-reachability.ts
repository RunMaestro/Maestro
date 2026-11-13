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
 * The module imports nothing from Electron; the transport (`emit`), the remote
 * lookup and the probe are injected once at startup, so the process manager and
 * remote-fs can call it unconditionally. Before configuration every call is a
 * no-op.
 */

import type { SshRemoteConfig } from '../shared/types';
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
}

/** Every remote currently known to be unreachable, for a client that just connected. */
export function getUnreachableSshRemotes(): SshReachabilityEvent[] {
	return [...unreachable.values()].map((state) => state.event);
}

/** Test-only: drop all state and timers. */
export function __resetSshReachabilityForTest(): void {
	for (const state of unreachable.values()) {
		if (state.timer) clearInterval(state.timer);
	}
	unreachable.clear();
	probesInFlight.clear();
	lastHealthyProbeAt.clear();
	deps = null;
}
