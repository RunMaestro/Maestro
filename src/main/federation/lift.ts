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
 * - A running turn is read from the live processes (`isAgentBusy()`), because the persisted record
 *   always says idle.
 * - The pointer is written by the window, which owns the agent list: the same
 *   `remote:updateSessionConfig` request the CLI's `update_session_config` reaches, so the window
 *   applies one rule for both (refuse a running turn or an earlier lift, drop the moved queue
 *   items, keep every tab, flush to disk before the ack).
 */

import type { BrowserWindow } from 'electron';
import { encoreDisabledMessage } from '../../shared/encoreFeatureDefaults';
import {
	LiftRunError,
	formatLiftPlan,
	providerEnvVarsOf,
	runLift,
	type LiftResult,
	type LiftRunDeps,
} from '../../shared/maestro-lib/agents/lift-run';
import type { LiftedToPointer } from '../../shared/maestro-lib/agents/lift-pointer';
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
	/** The running mirror, or null while the Federation Encore Feature is off. */
	service(): PeerMirrorService | null;
	setPointer(agentId: string, pointer: LiftedToPointer, movedQueueItemIds: string[]): Promise<void>;
	now?(): number;
}

/** Lift one local agent by id. Never throws: a refusal or failure is `{ ok: false }`. */
export async function liftAgentFromDesktop(
	agentId: string,
	options: DesktopLiftOptions,
	deps: DesktopLiftDeps
): Promise<DesktopLiftAnswer> {
	const service = deps.service();
	if (!service) {
		return { ok: false, code: 'PEER_ENCORE_OFF', error: encoreDisabledMessage('federation') };
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
	};
}
