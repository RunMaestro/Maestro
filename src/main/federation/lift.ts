/**
 * The desktop's "Move to Host" (FED-SSH-06): lift an SSH remote agent onto the `maestro-cli host`
 * on its remote, from the Left Bar context menu or the command palette.
 *
 * It runs `runLift()` (`src/shared/maestro-lib/agents/lift-run.ts`), the function `maestro-cli
 * lift` runs, so both make the same checks, show the same plan, and roll back the same way. What
 * is the desktop's own:
 *
 * - The host is reached over the peer mirror's HELD client (`PeerMirrorService.hostClient()`).
 *   Nothing dials: a peer that is not connected right now is refused, so no second ssh starts
 *   beside the mirror's one queue (decision D8).
 * - Move Back is the one exception, because it must work with hosting off: when no mirror runs,
 *   it opens ONE connection to the agent's host (`connectHost`) and releases it when the return
 *   ends. With no mirror there is no second ssh to race.
 * - A running turn is read from the live processes (`isAgentBusy()`), because the persisted record
 *   always says idle.
 * - The pointer is written by the window, which owns the agent list: the same
 *   `remote:updateSessionConfig` request the CLI's `update_session_config` reaches, so the window
 *   applies one rule for both (refuse a running turn or an earlier lift, drop the moved queue
 *   items, keep every tab, flush to disk before the ack).
 */

import type { BrowserWindow } from 'electron';
import { FEDERATION_NOT_RUNNING_MESSAGE } from '../../shared/federationCommands';
import {
	LiftRunError,
	formatLiftPlan,
	providerEnvVarsOf,
	runLift,
	type LiftResult,
	type LiftRunDeps,
} from '../../shared/maestro-lib/agents/lift-run';
import type { LiftedToPointer } from '../../shared/maestro-lib/agents/lift-pointer';
import {
	runReturnFromHost,
	type ReturnHostConnection,
	type ReturnedFromHost,
	type ReturnResult,
	type ReturnRunOptions,
} from '../../shared/maestro-lib/agents/lift-return';
import { connectPeerClient } from '../../shared/maestro-lib/client/peer-connection';
import { getSshForwardManager } from '../../shared/maestro-lib/client/ssh-forward';
import { createWsMaestroClient } from '../../shared/maestro-lib/client/ws-client';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../shared/types';
import { isAgentBusy, type ProcessLivenessProbe } from '../utils/agent-busy';
import { isWebContentsAvailable } from '../utils/safe-send';
import { requestFromRenderer } from '../web-server/callbacks/remoteRequest';
import type { PeerMirrorService } from './peer-mirror-service';

/** What the window asks for. `dryRun` builds and returns the plan only. */
export interface DesktopLiftOptions {
	dryRun?: boolean;
	withEnv?: boolean;
}

/** The answer to the window: the result with the plan as `maestro-cli lift` prints it, or why not. */
export type DesktopLiftAnswer =
	| { ok: true; result: LiftResult; planText: string }
	| { ok: false; error: string; code: string };

export interface DesktopLiftDeps {
	readAgents(): AgentRecord[];
	readRemotes(): SshRemoteConfig[];
	/** The provider configs (Settings -> Agents), by provider id. */
	readAgentConfigs(): Record<string, Record<string, unknown> | undefined>;
	/** A turn is running on any of the agent's tabs right now. */
	isAgentRunning(agent: AgentRecord): boolean;
	/** The running mirror, or null before boot started it. */
	service(): PeerMirrorService | null;
	setPointer(agentId: string, pointer: LiftedToPointer, movedQueueItemIds: string[]): Promise<void>;
	/** Move Back: make the agent an SSH agent again with the host's tabs merged in. */
	restore(agentId: string, returned: ReturnedFromHost): Promise<void>;
	/**
	 * Move Back with no mirror running (hosting off): open one connection to the host on SSH
	 * remote `remoteId`. Throws when it cannot. The caller releases it. Absent: refuse instead.
	 */
	connectHost?(remoteId: string, peer: string): Promise<ReturnHostConnection>;
	now?(): number;
}

/** The answer to the window's Move Back from Host. */
export type DesktopReturnAnswer =
	| { ok: true; result: ReturnResult }
	| { ok: false; error: string; code: string };

/**
 * Move a hosted agent back from its host (Move Back from Host, `maestro-cli unlift`). The host is
 * reached over the mirror's held client, as for Move to Host, or, when no mirror runs (hosting
 * off), over one connection of its own that ends with the return. Never throws.
 */
export async function returnAgentFromDesktop(
	agentId: string,
	options: ReturnRunOptions,
	deps: DesktopLiftDeps
): Promise<DesktopReturnAnswer> {
	const service = deps.service();
	if (!service && !deps.connectHost && !options.offline) {
		return { ok: false, code: 'FEDERATION_NOT_RUNNING', error: FEDERATION_NOT_RUNNING_MESSAGE };
	}
	try {
		const result = await runReturnFromHost(agentId, options, {
			readAgents: deps.readAgents,
			connect: async (remoteId, pointerPeer) => {
				try {
					if (!service) {
						if (!deps.connectHost) throw new Error(FEDERATION_NOT_RUNNING_MESSAGE);
						return await deps.connectHost(remoteId, pointerPeer);
					}
					const { peer, client } = service.hostClient(remoteId);
					return { peer, client, release: async () => {} };
				} catch (error) {
					throw new LiftRunError(
						'PEER_NOT_CONNECTED',
						error instanceof Error ? error.message : String(error)
					);
				}
			},
			restore: deps.restore,
		});
		return { ok: true, result };
	} catch (error) {
		return {
			ok: false,
			code: error instanceof LiftRunError ? error.code : 'RETURN_FAILED',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Lift one local agent by id. Never throws: a refusal or failure is `{ ok: false }`. */
export async function liftAgentFromDesktop(
	agentId: string,
	options: DesktopLiftOptions,
	deps: DesktopLiftDeps
): Promise<DesktopLiftAnswer> {
	const service = deps.service();
	if (!service) {
		return { ok: false, code: 'FEDERATION_NOT_RUNNING', error: FEDERATION_NOT_RUNNING_MESSAGE };
	}
	const runDeps: LiftRunDeps = {
		readAgents: deps.readAgents,
		readRemotes: deps.readRemotes,
		providerEnvVars: (provider) =>
			providerEnvVarsOf(deps.readAgentConfigs()[provider]?.customEnvVars),
		busyReason: (id) => {
			const agent = deps.readAgents().find((record) => record.id === id);
			return agent && deps.isAgentRunning(agent) ? 'a turn is running' : undefined;
		},
		connect: async (remote) => {
			try {
				const { peer, client } = service.hostClient(remote.id);
				// Borrowed from the mirror: the mirror keeps it open after the lift.
				return { peer, client, release: async () => {} };
			} catch (error) {
				throw new LiftRunError(
					'PEER_NOT_CONNECTED',
					error instanceof Error ? error.message : String(error)
				);
			}
		},
		setPointer: deps.setPointer,
		now: deps.now,
	};
	let planText = '';
	try {
		const result = await runLift(
			agentId,
			{ dryRun: options.dryRun === true, withEnv: options.withEnv === true },
			runDeps,
			(plan) => {
				planText = formatLiftPlan(plan.summary, options.dryRun === true);
			}
		);
		return { ok: true, result, planText };
	} catch (error) {
		return {
			ok: false,
			code: error instanceof LiftRunError ? error.code : 'LIFT_FAILED',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** The answer the window's `remote:updateSessionConfig` handler sends back. */
interface PointerReply {
	success: boolean;
	error?: string;
}

function readPointerReply(raw: unknown): PointerReply {
	if (!raw || typeof raw !== 'object')
		return { success: false, error: 'The window sent no answer' };
	const reply = raw as { success?: unknown; error?: unknown };
	return {
		success: reply.success === true,
		...(typeof reply.error === 'string' ? { error: reply.error } : {}),
	};
}

/** How long the window has to apply and flush the pointer. */
export const LIFT_POINTER_TIMEOUT_MS = 5000;

/**
 * Ask the window that owns the agent list to make the agent a pointer. Throws when it refuses or
 * does not answer, so `runLift()` removes the host's copy again.
 */
export async function setLiftPointerInWindow(
	win: BrowserWindow | null,
	agentId: string,
	pointer: LiftedToPointer,
	movedQueueItemIds: string[]
): Promise<void> {
	if (!win || !isWebContentsAvailable(win)) throw new Error('The Maestro window is not available');
	const reply = await requestFromRenderer<PointerReply>(win, 'remote:updateSessionConfig', {
		args: [agentId, { liftedTo: pointer, liftedQueueItemIds: movedQueueItemIds }],
		fallback: { success: false, error: 'The window did not answer in time' },
		parse: readPointerReply,
		timeoutMs: LIFT_POINTER_TIMEOUT_MS,
	});
	if (!reply.success) throw new Error(reply.error || 'The window refused the pointer');
}

/** Ask the window that owns the agent list to restore a hosted agent. Throws when it refuses. */
export async function restoreReturnedAgentInWindow(
	win: BrowserWindow | null,
	agentId: string,
	returned: ReturnedFromHost
): Promise<void> {
	if (!win || !isWebContentsAvailable(win)) throw new Error('The Maestro window is not available');
	const reply = await requestFromRenderer<PointerReply>(win, 'remote:updateSessionConfig', {
		args: [agentId, { returnedFromHost: returned }],
		fallback: { success: false, error: 'The window did not answer in time' },
		parse: readPointerReply,
		timeoutMs: LIFT_POINTER_TIMEOUT_MS,
	});
	if (!reply.success) throw new Error(reply.error || 'The window refused the move back');
}

export interface DesktopLiftRuntime {
	/** The stored agent list (`maestro-sessions.json` `sessions`). */
	readSessions(): unknown;
	/** The stored SSH remotes (settings `sshRemotes`). */
	readSshRemotes(): unknown;
	/** The provider configs (`maestro-agent-configs.json` `configs`). */
	readAgentConfigs(): unknown;
	getMainWindow(): BrowserWindow | null;
	getProcessManager(): ProcessLivenessProbe | null;
	service(): PeerMirrorService | null;
}

function arrayOf<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

/** The deps the IPC handler runs on: the stores main holds, the live processes, the window. */
export function buildDesktopLiftDeps(runtime: DesktopLiftRuntime): DesktopLiftDeps {
	return {
		readAgents: () => arrayOf<AgentRecord>(runtime.readSessions()),
		readRemotes: () => arrayOf<SshRemoteConfig>(runtime.readSshRemotes()),
		readAgentConfigs: () => {
			const configs = runtime.readAgentConfigs();
			return configs && typeof configs === 'object' && !Array.isArray(configs)
				? (configs as Record<string, Record<string, unknown> | undefined>)
				: {};
		},
		isAgentRunning: (agent) => isAgentBusy(agent, runtime.getProcessManager()),
		service: runtime.service,
		setPointer: (agentId, pointer, moved) =>
			setLiftPointerInWindow(runtime.getMainWindow(), agentId, pointer, moved),
		restore: (agentId, returned) =>
			restoreReturnedAgentInWindow(runtime.getMainWindow(), agentId, returned),
		connectHost: (remoteId, peer) =>
			connectHostForReturn(arrayOf<SshRemoteConfig>(runtime.readSshRemotes()), remoteId, peer),
	};
}

/**
 * Keeps the connection a return opens, so the returns that follow on the same remote reuse it
 * (the come-home job polling a turn that runs on the host: one held connection, not a new forward
 * every check). Each return's own `release()` does nothing; `release(remoteId)` ends the one held
 * for that remote, and the job calls it when it is done with that remote's agent or the link may
 * be broken.
 */
export function holdHostConnections(
	connectHost: (remoteId: string, peer: string) => Promise<ReturnHostConnection>
): {
	connectHost(remoteId: string, peer: string): Promise<ReturnHostConnection>;
	release(remoteId: string): Promise<void>;
} {
	const held = new Map<string, { peer: string; opened: Promise<ReturnHostConnection> }>();
	const release = async (remoteId: string) => {
		const entry = held.get(remoteId);
		if (!entry) return;
		held.delete(remoteId);
		const connection = await entry.opened.catch(() => null);
		await connection?.release();
	};
	return {
		async connectHost(remoteId, peer) {
			const entry = held.get(remoteId);
			// A different peer on the same remote is a different host: never hand its client out.
			if (entry && entry.peer !== peer) await release(remoteId);
			let current = held.get(remoteId);
			if (!current) {
				current = { peer, opened: connectHost(remoteId, peer) };
				held.set(remoteId, current);
				// A connection that never opened is not kept: the next return dials again.
				current.opened.catch(() => {
					if (held.get(remoteId) === current) held.delete(remoteId);
				});
			}
			const connection = await current.opened;
			return { peer: connection.peer, client: connection.client, release: async () => {} };
		},
		release,
	};
}

/**
 * One connection to the host on SSH remote `remoteId`, for a Move Back while no mirror runs. The
 * forward is the shared manager's, refcounted, so `release()` ends the ssh when nothing else
 * holds it. One attempt: a host that does not answer throws, and the caller decides what next.
 */
export async function connectHostForReturn(
	remotes: readonly SshRemoteConfig[],
	remoteId: string,
	peer: string
): Promise<ReturnHostConnection> {
	const remote = remotes.find((candidate) => candidate.id === remoteId);
	if (!remote) throw new Error(`SSH remote ${remoteId} is not configured on this machine.`);
	const opened = await connectPeerClient(peer, remote, {
		acquireForward: (target) => getSshForwardManager().acquire(target),
		createClient: (endpoint) => createWsMaestroClient({ endpoint }),
	});
	return { peer, client: opened.client, release: opened.release };
}
