/**
 * Automatic Federation: the desktop's coordinator that turns "Federation is possible here" into
 * "it is done", and says plainly when it cannot.
 *
 * Every pass, one remote and one agent at a time:
 *
 * 1. **Keep hosts running.** A remote whose `maestro-cli` is installed but whose host is down gets
 *    its host started (through its service when it has one). A connected remote gets its service
 *    registered once per app run, so the host comes back after a reboot. Both happen whether or
 *    not automatic moves are on.
 * 2. **Install where it is needed.** With automatic moves on, a remote with no `maestro-cli` that
 *    has at least one SSH agent gets this app's CLI, its service, and a running host. A remote with
 *    no SSH agent is left alone: nothing asked for a host there.
 * 3. **Move SSH agents onto their host**, with automatic moves on, once every sanity check passes:
 *    - the record may be lifted at all (`runLift()`'s own refusals, through a dry run);
 *    - no turn is running (else `waiting`, and it moves on a later pass);
 *    - the host can run the agent's provider (`providers.list()` on the host), unless the agent
 *      names its own binary path;
 *    - no secret env var would stay behind on this machine (the dry run's `withheld`): a move would
 *      leave the agent on the host without credentials it needs.
 *    A failed check is `blocked` with the reason and the one thing a person has to do. A blocked
 *    agent is not tried again until its record or its remote changes, or `BLOCKED_RETRY_MS` passes.
 *
 * Setup and lift run through the same functions as Make Federated and Move to Host
 * (`setupHostFromDesktop()`, `liftAgentFromDesktop()`), so automation and the person's own click
 * do exactly the same thing. A remote that opted out of Federation is never touched.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import {
	emptyAutoFederationSnapshot,
	type AutoFederationAgentStatus,
	type AutoFederationRemoteStatus,
	type AutoFederationSnapshot,
} from '../../shared/federationAuto';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import { liftRefusal, liftSshRemoteId } from '../../shared/maestro-lib/agents/lift-plan';
import { federationPeersOf } from '../../shared/maestro-lib/client/peer-connection';
import type { MirrorPeerSummary } from '../../shared/maestro-lib/client/peer-mirror';
import { describeRemoteService } from '../../shared/maestro-lib/client/remote-service';
import type { ProviderInfo } from '../../shared/maestro-lib/client/types';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import type { SshRemoteConfig } from '../../shared/types';
import type { DesktopLiftAnswer } from './lift';
import type { DesktopSetupHostAnswer } from './setup-host';

/** How often a pass runs on its own. Peer changes and agent edits also start one. */
export const AUTO_FEDERATION_INTERVAL_MS = 5 * 60_000;
/** The wait after boot before the first pass, so the mirror has probed the remotes. */
export const AUTO_FEDERATION_FIRST_PASS_MS = 30_000;
/** A nudge (peer change, agent edit) starts a pass after this quiet period. */
export const AUTO_FEDERATION_DEBOUNCE_MS = 5_000;
/** A remote whose setup failed is tried again after this long. */
export const SETUP_RETRY_MS = 30 * 60_000;
/** A blocked agent whose record did not change is tried again after this long. */
export const BLOCKED_RETRY_MS = 60 * 60_000;

export interface AutoFederationDeps {
	/** The stored SSH remotes. */
	readRemotes(): SshRemoteConfig[];
	/** The stored local agents. */
	readAgents(): AgentRecord[];
	/** The `federationAutoMove` setting. */
	isAutoMoveEnabled(): boolean;
	/** The mirror's view of every probed remote. Empty before the mirror runs. */
	peers(): MirrorPeerSummary[];
	/** Make Federated / Start Host: install when needed, register the service, start the host. */
	setupHost(remoteId: string): Promise<DesktopSetupHostAnswer>;
	/** Move to Host, with or without `dryRun`. */
	lift(agentId: string, options: { dryRun: boolean }): Promise<DesktopLiftAnswer>;
	/** A turn of this agent runs right now. */
	isAgentBusy(agent: AgentRecord): boolean;
	/** The providers the host on this remote can run, or null when it cannot be asked now. */
	hostProviders(remoteId: string): Promise<ProviderInfo[] | null>;
	/** Send the new snapshot to every window. */
	publish(snapshot: AutoFederationSnapshot): void;
	now?(): number;
	setTimer?(callback: () => void, ms: number): unknown;
	clearTimer?(handle: unknown): void;
	/** Report a failure that is not a remote's or an agent's own state (a bug). */
	onError?(error: unknown, operation: string): void;
}

/** The fields of an agent record a blocked check depends on: any change earns a retry. */
function agentFingerprint(agent: AgentRecord): string {
	return canonicalJson({
		toolType: agent.toolType,
		cwd: agent.cwd,
		ssh: agent.sessionSshRemoteConfig ?? null,
		env: (agent as { customEnvVars?: unknown }).customEnvVars ?? null,
		path: (agent as { customPath?: unknown }).customPath ?? null,
		// Lift eligibility reads the tabs (an agent with none cannot move).
		tabs: (agent.aiTabs ?? []).map((tab) => [tab.id, tab.agentSessionId ?? null]),
	});
}

/** Every connection field a person can change to fix a failed setup. */
function remoteFingerprint(remote: SshRemoteConfig): string {
	return canonicalJson({
		host: remote.host,
		port: remote.port,
		user: remote.username ?? null,
		key: remote.privateKeyPath ?? null,
		useSshConfig: remote.useSshConfig ?? null,
		sshOptions: remote.sshOptions ?? null,
		remoteEnv: remote.remoteEnv ?? null,
		enabled: remote.enabled,
	});
}

/**
 * Service skips with only a manual workaround (no service manager there at all): shown as a note,
 * never as something that needs a person.
 */
const INFORMATIONAL_SERVICE_REASONS: ReadonlySet<string> = new Set([
	'unsupported-os',
	'no-systemd-user',
	'desktop-app',
]);

/** A lift refusal the next pass can clear by itself (nothing for a person to do). */
const TRANSIENT_LIFT_CODES = new Set([
	'LIFT_BUSY',
	'PEER_NOT_CONNECTED',
	'PEER_HOST_DOWN',
	'FEDERATION_NOT_RUNNING',
]);

export class AutoFederationCoordinator {
	private readonly deps: AutoFederationDeps;
	private readonly remotes = new Map<string, AutoFederationRemoteStatus>();
	private readonly agents = new Map<string, AutoFederationAgentStatus>();
	/** Remotes whose service was registered (or found registered) this app run. */
	private readonly serviceEnsured = new Set<string>();
	/** When a remote's setup last failed, and against which remote record. */
	private readonly setupFailures = new Map<string, { at: number; fingerprint: string }>();
	/** When an agent was last blocked, against which records, and why (to show it again). */
	private readonly agentBlocks = new Map<
		string,
		{ at: number; fingerprint: string; reason: string; fix: string }
	>();
	private interval: unknown = null;
	private debounce: unknown = null;
	private running = false;
	/** The pass running now, so a caller that asked for one can wait for it to finish. */
	private active: Promise<void> | null = null;
	/** A nudge came in while a pass ran: run once more after it. */
	private again = false;
	private lastPassAt: number | undefined;
	/** The next pass ignores the retry backoffs (Run Now). Cleared when a pass starts. */
	private force = false;
	/** The pass running now ignores the retry backoffs. */
	private forcing = false;
	private stopped = false;

	constructor(deps: AutoFederationDeps) {
		this.deps = deps;
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private setTimer(callback: () => void, ms: number): unknown {
		if (this.deps.setTimer) return this.deps.setTimer(callback, ms);
		const handle = setTimeout(callback, ms);
		handle.unref?.();
		return handle;
	}

	private clearTimer(handle: unknown): void {
		if (handle === null) return;
		if (this.deps.clearTimer) this.deps.clearTimer(handle);
		else clearTimeout(handle as NodeJS.Timeout);
	}

	/** Schedule the first pass and the interval. */
	start(): void {
		if (this.stopped) return;
		this.debounce = this.setTimer(() => this.fire(), AUTO_FEDERATION_FIRST_PASS_MS);
	}

	stop(): void {
		this.stopped = true;
		this.clearTimer(this.debounce);
		this.clearTimer(this.interval);
		this.debounce = null;
		this.interval = null;
	}

	/** Something changed (a peer connected, an agent was edited): run a pass soon. */
	nudge(): void {
		if (this.stopped) return;
		if (this.running) {
			this.again = true;
			return;
		}
		this.clearTimer(this.debounce);
		this.debounce = this.setTimer(() => this.fire(), AUTO_FEDERATION_DEBOUNCE_MS);
	}

	/**
	 * Run a pass now and resolve with what it left behind (`maestro-cli federation auto run`, Run
	 * Now). A person asked, so whatever they fixed is tried now, past the retry backoffs, unless
	 * `force: false`.
	 */
	async runNow(options: { force?: boolean } = {}): Promise<AutoFederationSnapshot> {
		this.clearTimer(this.debounce);
		this.debounce = null;
		if (options.force !== false) this.force = true;
		await this.pass();
		this.scheduleNext();
		return this.snapshot();
	}

	snapshot(): AutoFederationSnapshot {
		const autoMove = this.deps.isAutoMoveEnabled();
		return {
			...emptyAutoFederationSnapshot(autoMove),
			running: this.running,
			...(this.lastPassAt !== undefined ? { lastPassAt: this.lastPassAt } : {}),
			remotes: [...this.remotes.values()],
			agents: [...this.agents.values()],
		};
	}

	private fire(): void {
		this.debounce = null;
		void this.pass().finally(() => this.scheduleNext());
	}

	/** The next pass on its own, an interval after this one, whoever started this one. */
	private scheduleNext(): void {
		if (this.stopped) return;
		this.clearTimer(this.interval);
		this.interval = this.setTimer(() => this.fire(), AUTO_FEDERATION_INTERVAL_MS);
	}

	private publish(): void {
		this.deps.publish(this.snapshot());
	}

	private setRemote(
		remote: SshRemoteConfig,
		patch: Omit<AutoFederationRemoteStatus, 'remoteId' | 'name' | 'at'>
	): void {
		// The service report outlives a passing connection state: a reconnect does not run setup
		// again, so dropping it would hide a lingering fix until the next app run.
		const previous = this.remotes.get(remote.id);
		this.remotes.set(remote.id, {
			remoteId: remote.id,
			name: remote.name,
			...(previous?.service && patch.service === undefined ? { service: previous.service } : {}),
			...patch,
			at: this.now(),
		});
	}

	/** The service's required fix, kept from the last setup, for a host that is ready again. */
	private readonly serviceFixes = new Map<string, string>();

	private setAgent(
		agent: AgentRecord,
		remoteId: string,
		patch: Omit<AutoFederationAgentStatus, 'agentId' | 'agentName' | 'remoteId' | 'at'>
	): void {
		this.agents.set(agent.id, {
			agentId: agent.id,
			agentName: agent.name,
			remoteId,
			...patch,
			at: this.now(),
		});
	}

	/** One pass over every remote. Never two at once. */
	private pass(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.active) {
			// The running pass loops once more, so the caller gets a pass that started after it asked.
			this.again = true;
			return this.active;
		}
		this.active = this.runPasses().finally(() => {
			this.active = null;
		});
		return this.active;
	}

	private async runPasses(): Promise<void> {
		this.running = true;
		this.publish();
		try {
			do {
				this.again = false;
				this.forcing = this.force;
				this.force = false;
				await this.passOnce();
			} while (this.again && !this.stopped);
		} catch (error) {
			this.deps.onError?.(error, 'federation:auto-pass');
		} finally {
			this.running = false;
			this.lastPassAt = this.now();
			this.publish();
		}
	}

	private async passOnce(): Promise<void> {
		const allRemotes = this.deps.readRemotes();
		const participating = new Set(federationPeersOf(allRemotes).map(({ remote }) => remote.id));
		const autoMove = this.deps.isAutoMoveEnabled();
		const agentsByRemote = new Map<string, AgentRecord[]>();
		const liveAgentIds = new Set<string>();
		for (const agent of this.deps.readAgents()) {
			const remoteId = liftSshRemoteId(agent);
			if (!remoteId || readLiftedTo(agent.liftedTo)) continue;
			liveAgentIds.add(agent.id);
			const list = agentsByRemote.get(remoteId) ?? [];
			list.push(agent);
			agentsByRemote.set(remoteId, list);
		}
		// Forget agents that moved, were removed, or are no longer SSH agents (a `moved` status of
		// this run stays, so the person can read what happened).
		for (const [agentId, status] of this.agents) {
			if (!liveAgentIds.has(agentId) && status.state !== 'moved') this.agents.delete(agentId);
		}

		for (const remote of allRemotes) {
			if (this.stopped) return;
			const agents = agentsByRemote.get(remote.id) ?? [];
			if (!participating.has(remote.id)) {
				this.remotes.delete(remote.id);
				for (const agent of agents) {
					this.setAgent(agent, remote.id, {
						state: 'manual',
						reason:
							remote.enabled === false
								? `SSH remote "${remote.name}" is disabled.`
								: `Federation is off for SSH remote "${remote.name}".`,
						fix: 'Turn the remote and its Federation switch on in Settings > SSH Hosts to move this agent automatically.',
					});
				}
				continue;
			}
			const ready = await this.ensureHost(remote, agents.length > 0 && autoMove);
			for (const agent of agents) {
				if (this.stopped) return;
				// Read again before each move: it may have been switched off while setup ran.
				if (!autoMove || !this.deps.isAutoMoveEnabled()) {
					this.setAgent(agent, remote.id, {
						state: 'manual',
						reason: 'Automatic moves are off.',
						fix: 'Right-click the agent > Move to Host, or turn on "Move SSH agents to their host automatically" in Settings > SSH Hosts.',
					});
					continue;
				}
				if (!ready) {
					const status = this.remotes.get(remote.id);
					this.setAgent(agent, remote.id, {
						state: status?.state === 'blocked' ? 'blocked' : 'pending',
						reason:
							status?.state === 'blocked'
								? `Its remote "${remote.name}" has no host: ${status.reason ?? 'setup failed'}`
								: `Waiting for the host on "${remote.name}".`,
						...(status?.state === 'blocked' && status.fix ? { fix: status.fix } : {}),
					});
					continue;
				}
				await this.tryMove(agent, remote, allRemotes);
				this.publish();
			}
		}
		// Statuses for remotes that no longer exist.
		const ids = new Set(allRemotes.map((remote) => remote.id));
		for (const remoteId of this.remotes.keys())
			if (!ids.has(remoteId)) this.remotes.delete(remoteId);
	}

	/**
	 * Make sure `remote` runs a connected host when it should. Returns true when the mirror is
	 * connected to it after this call.
	 */
	private async ensureHost(remote: SshRemoteConfig, hostWanted: boolean): Promise<boolean> {
		const peer = this.deps.peers().find((candidate) => candidate.remoteId === remote.id);
		const connection = peer?.connection;

		if (connection === 'connected') {
			// Once per app run: make sure the host comes back after a reboot. A failed attempt stays
			// eligible, and is tried again after SETUP_RETRY_MS like any other failed setup.
			if (!this.serviceEnsured.has(remote.id)) {
				if (!this.setupBackingOff(remote) && (await this.runSetup(remote, true))) {
					this.serviceEnsured.add(remote.id);
				}
			} else if (this.remotes.get(remote.id)?.state !== 'ready') {
				const fix = this.serviceFixes.get(remote.id);
				this.setRemote(remote, { state: 'ready', ...(fix ? { fix, needsYou: true } : {}) });
			}
			return this.isConnected(remote.id);
		}

		// The CLI is there but no host runs: start it (A2), whatever automatic moves say.
		const startWanted = connection === 'host-down';
		// No CLI: install only where an SSH agent wants a host and automatic moves are on.
		const installWanted = connection === 'not-installed' && hostWanted;
		if (!startWanted && !installWanted) {
			if (connection === 'not-installed') {
				this.setRemote(remote, {
					state: 'waiting',
					reason: 'No Maestro host here, and no SSH agent that needs one.',
				});
			} else if (
				connection === undefined ||
				connection === 'connecting' ||
				connection === 'reconnecting'
			) {
				this.setRemote(remote, { state: 'waiting', reason: 'Checking the remote for a host.' });
			} else {
				this.setRemote(remote, {
					state: 'waiting',
					reason: peer?.error ?? `The remote is not reachable right now (${connection}).`,
				});
			}
			return false;
		}
		if (this.setupBackingOff(remote)) return false;
		await this.runSetup(remote, false);
		return this.isConnected(remote.id);
	}

	/** A setup of this remote failed recently, against the same remote record. */
	private setupBackingOff(remote: SshRemoteConfig): boolean {
		if (this.forcing) return false;
		const failed = this.setupFailures.get(remote.id);
		return (
			failed !== undefined &&
			failed.fingerprint === remoteFingerprint(remote) &&
			this.now() - failed.at < SETUP_RETRY_MS
		);
	}

	private isConnected(remoteId: string): boolean {
		return this.deps
			.peers()
			.some((peer) => peer.remoteId === remoteId && peer.connection === 'connected');
	}

	/** Set the host up. True when it succeeded (or an older host was found running, on purpose left). */
	private async runSetup(remote: SshRemoteConfig, alreadyConnected: boolean): Promise<boolean> {
		this.setRemote(remote, {
			state: 'setting-up',
			reason: alreadyConnected
				? 'Making sure the host comes back after a reboot.'
				: 'Installing or starting the Maestro host.',
		});
		this.publish();
		let answer: DesktopSetupHostAnswer;
		try {
			answer = await this.deps.setupHost(remote.id);
		} catch (error) {
			answer = {
				ok: false,
				code: 'SETUP_FAILED',
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (!answer.ok) {
			// An older running host is not replaced on its own: that would interrupt its work.
			if (answer.code === 'host-running' && alreadyConnected) {
				this.setRemote(remote, {
					state: 'ready',
					reason: 'The host runs an older version than this app.',
					fix: 'Make Federated on one of its agents offers Upgrade and Restart Host, or run maestro-cli remote-host install <ssh-remote> --restart.',
				});
				return true;
			}
			this.setupFailures.set(remote.id, { at: this.now(), fingerprint: remoteFingerprint(remote) });
			this.setRemote(remote, {
				state: 'blocked',
				reason: answer.error,
				fix: setupFix(answer.code),
			});
			return false;
		}
		this.setupFailures.delete(remote.id);
		const { service, serviceError } = answer.result;
		const serviceText = service
			? describeRemoteService(service)
			: serviceError
				? `The service could not be registered: ${serviceError}`
				: undefined;
		// What the host still needs from a person to survive logout and reboots, if anything.
		const serviceFix =
			service && service.kind !== 'none' && service.lingerFix
				? `Run \`${service.lingerFix}\` on the remote so the host survives logout and reboots.`
				: service && service.kind !== 'none' && service.state === 'start-failed'
					? 'The service did not start the host. Check it on the remote (`systemctl --user status maestro-host`, or `launchctl print gui/$(id -u)/sh.maestro.host`).'
					: service?.kind === 'none' && !INFORMATIONAL_SERVICE_REASONS.has(service.reason)
						? service.fix
						: serviceError
							? 'Run maestro-cli remote-host install <ssh-remote> --start to register the service again and see the error.'
							: undefined;
		// A remote that can never have a service (Windows, no user bus, a Mac with Maestro.app) keeps
		// its workaround as a note: the person cannot "fix" it, so it must not read as needing them
		// on every run (and fail `federation auto` forever).
		const serviceNote =
			service?.kind === 'none' && INFORMATIONAL_SERVICE_REASONS.has(service.reason)
				? service.fix
				: undefined;
		if (serviceFix) this.serviceFixes.set(remote.id, serviceFix);
		else this.serviceFixes.delete(remote.id);
		const connected = this.isConnected(remote.id);
		this.setRemote(remote, {
			state: connected ? 'ready' : 'blocked',
			...(connected
				? serviceFix
					? { fix: serviceFix, needsYou: true }
					: serviceNote
						? { fix: serviceNote }
						: {}
				: {
						reason:
							answer.reconnectError ??
							'The host was set up, but the mirror could not connect to it.',
						fix: 'Right-click the peer in the Left Bar > Reconnect, or run maestro-cli remote-host status <ssh-remote>.',
					}),
			...(serviceText ? { service: serviceText } : {}),
		});
		return true;
	}

	/** Every sanity check, then the move. */
	private async tryMove(
		agent: AgentRecord,
		remote: SshRemoteConfig,
		remotes: SshRemoteConfig[]
	): Promise<void> {
		const fingerprint = `${agentFingerprint(agent)}|${remoteFingerprint(remote)}`;
		const blocked = this.agentBlocks.get(agent.id);
		if (
			blocked &&
			!this.forcing &&
			blocked.fingerprint === fingerprint &&
			this.now() - blocked.at < BLOCKED_RETRY_MS
		) {
			// Not retried yet, but still blocked: show it as such (a pass with moves off said manual).
			this.setAgent(agent, remote.id, {
				state: 'blocked',
				reason: blocked.reason,
				fix: blocked.fix,
			});
			return;
		}
		const block = (reason: string, fix: string): void => {
			this.agentBlocks.set(agent.id, { at: this.now(), fingerprint, reason, fix });
			this.setAgent(agent, remote.id, { state: 'blocked', reason, fix });
		};
		const wait = (reason: string): void => {
			this.agentBlocks.delete(agent.id);
			this.setAgent(agent, remote.id, { state: 'waiting', reason });
		};

		// 1. Record refusals: nothing to dial for.
		const refusal = liftRefusal(agent, remotes);
		if (refusal) {
			block(refusal.message, 'Move it with Move to Host once the cause is fixed.');
			return;
		}
		// 2. A running turn: it moves on a later pass.
		if (this.deps.isAgentBusy(agent)) {
			wait('A turn is running. It moves when the agent is idle.');
			return;
		}
		// 3. The host can run its provider.
		const customPath = (agent as { customPath?: unknown }).customPath;
		if (typeof customPath !== 'string' || !customPath.trim()) {
			const providers = await this.deps.hostProviders(remote.id);
			// Unanswered is not "available": neither the dry run nor the import checks the binary, so
			// moving now could leave the agent on a host that cannot run it.
			if (!providers) {
				wait(
					'The host did not say which providers it can run. Maestro asks again on the next pass.'
				);
				return;
			}
			const provider = providers.find((candidate) => candidate.id === agent.toolType);
			if (!provider || !provider.available) {
				const name = getAgentDisplayName(agent.toolType);
				block(
					`${name} is not available to the host on "${remote.name}"${provider?.unavailableReason ? ` (${provider.unavailableReason})` : ''}.`,
					`Install ${name} on "${remote.name}" and log in to it as the SSH user. If it is installed outside ~/.local/bin or a Node version manager, add \`export PATH="<its folder>:$PATH"\` to ~/.maestro/host.env on the remote, then use Start Host.`
				);
				return;
			}
		}
		// 4. The dry run: every refusal the real lift would make, and what would stay behind.
		const plan = await this.deps.lift(agent.id, { dryRun: true });
		if (!plan.ok) {
			if (TRANSIENT_LIFT_CODES.has(plan.code)) wait(plan.error);
			else
				block(
					plan.error,
					'Fix the cause above. The next automatic pass, or Move to Host, then moves it.'
				);
			return;
		}
		const withheld = plan.result.plan.env.withheld;
		if (withheld.length > 0) {
			block(
				`It has secret env vars that would stay on this machine: ${withheld.join(', ')}.`,
				'Right-click the agent > Move to Host and check "Send secret env vars too", or set those variables on the remote and remove them from this agent.'
			);
			return;
		}
		// 5. The move, unless automatic moves were switched off while the checks ran.
		if (!this.deps.isAutoMoveEnabled()) {
			this.setAgent(agent, remote.id, {
				state: 'manual',
				reason: 'Automatic moves are off.',
				fix: 'Right-click the agent > Move to Host, or turn on "Move SSH agents to their host automatically" in Settings > SSH Hosts.',
			});
			return;
		}
		const moved = await this.deps.lift(agent.id, { dryRun: false });
		if (!moved.ok) {
			if (TRANSIENT_LIFT_CODES.has(moved.code)) wait(moved.error);
			else
				block(
					moved.error,
					'Fix the cause above. The next automatic pass, or Move to Host, then moves it.'
				);
			return;
		}
		this.agentBlocks.delete(agent.id);
		this.setAgent(agent, remote.id, {
			state: 'moved',
			reason: `Moved onto the host on "${remote.name}".`,
			...(moved.result.target ? { target: moved.result.target } : {}),
		});
	}
}

/** What a person does when setup failed, by the failure's code. */
function setupFix(code: string): string {
	switch (code) {
		case 'foreign-cli':
		case 'broken-cli':
			return 'Right-click an agent on this remote > Make Federated and use the button the window offers, or run maestro-cli remote-host install <ssh-remote> --force --start.';
		case 'node-download':
		case 'sqlite-install':
			return 'Let the remote reach nodejs.org and the npm registry (or install Node.js 22+ there), then Make Federated or wait for the next try.';
		case 'unsupported-os':
		case 'unsupported-arch':
			return 'This remote cannot run a Maestro host. Turn Federation off for it in Settings > SSH Hosts to stop the attempts.';
		case 'ssh-failed':
		case 'timeout':
			return 'Check the remote is reachable with Test Connection in Settings > SSH Hosts. Maestro tries again later.';
		default:
			return 'Run maestro-cli remote-host install <ssh-remote> --start to see the full error, or use Make Federated on one of its agents.';
	}
}
