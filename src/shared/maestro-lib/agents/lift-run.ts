/**
 * Running a Federation lift: every step from "which agent" to "the local copy is a pointer", shared
 * by `maestro-cli lift` and the desktop's "Move to Host" action (#1716 section 6).
 *
 * The rules live in `lift-plan.ts` (refusals, payload, summary) and `lift-pointer.ts` (the
 * pointer). This module runs them in order against what the caller injects, so the CLI and the
 * desktop make the same checks, print the same plan, and roll back the same way:
 *
 * 1. Record refusals (`liftRefusal()`), the remote's Federation opt-in, a running turn the record
 *    cannot show (`busyReason`), and the caller's own refusal (`localRefusal`). None costs a dial.
 * 2. The plan (`planAgentLift()`), handed to `onPlan` once the host is reached. A dry run stops.
 * 3. `import_agent` on the host, then the local pointer. The two writes cannot be one
 *    transaction: when the pointer cannot be set, the host's copy is removed again, so the agent
 *    never has two owners.
 *
 * How the host is reached and who writes the pointer differ, and are the caller's: the CLI dials
 * its own SSH forward and writes through the desktop or the store file; the desktop borrows the
 * peer mirror's held client and asks its window, which owns the agent list.
 */

import type { SshRemoteConfig } from '../../types';
import { federationOffMessage, peerIdFor } from '../client/peer-connection';
import type { ClientError, MaestroClient } from '../client/types';
import type { AgentRecord } from '../store/records';
import { liftRefusal, liftSshRemoteId, planAgentLift } from './lift-plan';
import type { LiftPlan, LiftPlanSummary } from './lift-plan';
import { peerAgentRef, type LiftedToPointer } from './lift-pointer';

export interface LiftRunOptions {
	/** Build and show the plan, then stop. */
	dryRun?: boolean;
	/** Send secret env vars too. */
	withEnv?: boolean;
}

/** A refusal or failure of a lift. `code` is the stable `--json` code (`LIFT_BUSY`, ...). */
export class LiftRunError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'LiftRunError';
		this.code = code;
	}
}

/** The `LIFT_<CODE>` a refusal reports: `busy` is `LIFT_BUSY`. */
export function liftErrorCode(code: string): string {
	return `LIFT_${code.toUpperCase().replace(/-/g, '_')}`;
}

/** A client attached to the agent's host. `release()` is the caller's (a no-op for a borrowed one). */
export interface LiftHostConnection {
	/** The peer id the host is addressed by: the pointer names it. */
	peer: string;
	client: Pick<MaestroClient, 'agents'>;
	release(): Promise<void>;
}

/** What a lift needs from the world. */
export interface LiftRunDeps {
	/** The stored agent records (tabs and transcripts included). */
	readAgents(): AgentRecord[];
	readRemotes(): SshRemoteConfig[];
	/** The agent id `ref` names. Throws when it names none. Default: `ref` is the id. */
	resolveAgentId?(ref: string): string;
	/** The provider-level env vars (Settings -> Agents) for a provider. */
	providerEnvVars(provider: string): Record<string, string> | undefined;
	/** Why the agent is busy where its record cannot show it (a CLI run, a live process). */
	busyReason(agentId: string): string | undefined;
	/** A refusal of the caller's own, checked last before the host is reached. */
	localRefusal?(): LiftRunError | undefined;
	/** Reach the host on `remote`. Throws when it cannot (the host is down, the peer is lost). */
	connect(remote: SshRemoteConfig, peer: string): Promise<LiftHostConnection>;
	/** A failed host call as the error to throw. Default: `LIFT_HOST_FAILED` naming the peer. */
	hostCallError?(peer: string, error: Pick<ClientError, 'code' | 'message'>): Error;
	/** Make the local agent a pointer and take the moved queue items off its queue. Throws on failure. */
	setPointer(agentId: string, pointer: LiftedToPointer, movedQueueItemIds: string[]): Promise<void>;
	now?(): number;
}

export interface LiftResult {
	plan: LiftPlanSummary;
	dryRun: boolean;
	/** Set once the host made its copy. */
	liftedTo?: LiftedToPointer;
	/** `peer:agentId`: where to send from now on. */
	target?: string;
	/** Queued messages the host accepted. */
	queued?: number;
	notices?: string[];
}

/** Only the string entries of a stored env-var record (a provider config's `customEnvVars`). */
export function providerEnvVarsOf(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'string') out[key] = entry;
	}
	return out;
}

/** The plan, as a person reads it before anything moves (`maestro-cli lift` and the desktop). */
export function formatLiftPlan(summary: LiftPlanSummary, dryRun: boolean): string {
	const lines: string[] = [];
	lines.push(
		`${dryRun ? 'Would lift' : 'Lifting'} "${summary.agent.name}" (${summary.agent.provider}) onto peer "${summary.peer}" (SSH remote ${summary.remote.name})`
	);
	lines.push('Moves to the host:');
	lines.push(`  Working directory: ${summary.cwd}`);
	if (summary.model) lines.push(`  Model: ${summary.model}`);
	if (summary.effort) lines.push(`  Effort: ${summary.effort}`);
	if (summary.customArgs) lines.push(`  Arguments: ${summary.customArgs}`);
	if (summary.customPath) lines.push(`  Binary path: ${summary.customPath}`);
	lines.push(`  Tabs (${summary.tabs.length}):`);
	for (const tab of summary.tabs) {
		const label = tab.name ? `"${tab.name}"` : tab.id;
		const session = tab.agentSessionId
			? `resumes ${tab.agentSessionId}`
			: 'no provider session yet';
		const active = tab.id === summary.activeTabId ? ', active' : '';
		lines.push(`    - ${label}: ${tab.entries} transcript entries, ${session}${active}`);
	}
	lines.push(
		`  Env vars (${summary.env.sent.length}): ${summary.env.sent.length > 0 ? summary.env.sent.join(', ') : 'none'}`
	);
	if (summary.env.secretsSent.length > 0) {
		lines.push(`  Secret env vars sent (--with-env): ${summary.env.secretsSent.join(', ')}`);
	}
	if (summary.env.sessionDir) {
		lines.push(
			`  Provider session dir: ${summary.env.sessionDir.key}=${summary.env.sessionDir.value} (the host checks it exists)`
		);
	}
	lines.push(`  Queued messages: ${summary.queued.length}`);
	lines.push('Stays on this machine:');
	lines.push(
		'  Every tab and transcript (the local agent becomes a pointer; sends to it are refused)'
	);
	for (const stay of summary.stays) {
		const what =
			stay.kind === 'secret-env'
				? `Env var ${stay.ref}`
				: stay.kind === 'hidden-tab'
					? `Hidden tab ${stay.ref}`
					: stay.kind === 'auto-run-folder'
						? `Auto Run folder ${stay.ref}`
						: `Queue item ${stay.ref}`;
		lines.push(`  ${what}: ${stay.reason}`);
	}
	return lines.join('\n');
}

function defaultHostCallError(peer: string, error: Pick<ClientError, 'message'>): Error {
	return new LiftRunError('LIFT_HOST_FAILED', `Peer "${peer}": ${error.message}`);
}

/** Remove the host's copy after the pointer could not be set. Returns a line for the error. */
async function rollBack(connection: LiftHostConnection, hostAgentId: string): Promise<string> {
	const removed = await connection.client.agents.remove(hostAgentId);
	if (removed.ok) return `The host's copy was removed again, so the agent stays here, unchanged.`;
	return `The host's copy (${peerAgentRef(connection.peer, hostAgentId)}) could not be removed: ${removed.error.message} On the remote, run: maestro-cli remove-agent ${hostAgentId}`;
}

/**
 * Every step of a lift, without printing. `onPlan` gets the plan once the host is reached, before
 * anything moves. Throws `LiftRunError`, or whatever `connect` / `hostCallError` throw.
 */
export async function runLift(
	agentRef: string,
	options: LiftRunOptions,
	deps: LiftRunDeps,
	onPlan: (plan: LiftPlan) => void = () => {}
): Promise<LiftResult> {
	let agentId: string;
	try {
		agentId = deps.resolveAgentId ? deps.resolveAgentId(agentRef) : agentRef;
	} catch (error) {
		throw new LiftRunError(
			'AGENT_NOT_FOUND',
			error instanceof Error ? error.message : String(error)
		);
	}
	const agent = deps.readAgents().find((record) => record.id === agentId);
	if (!agent) throw new LiftRunError('AGENT_NOT_FOUND', `Agent not found: ${agentRef}`);

	const remotes = deps.readRemotes();
	const refusal = liftRefusal(agent, remotes);
	if (refusal) throw new LiftRunError(liftErrorCode(refusal.code), refusal.message);
	const remote = remotes.find((candidate) => candidate.id === liftSshRemoteId(agent));
	if (!remote) throw new LiftRunError(liftErrorCode('remote-missing'), 'SSH remote not found');
	if (!remote.federation) {
		throw new LiftRunError('PEER_FEDERATION_OFF', federationOffMessage(remote));
	}

	const busy = deps.busyReason(agent.id);
	if (busy) {
		throw new LiftRunError(
			liftErrorCode('busy'),
			`"${agent.name}" is busy: ${busy}. A running turn cannot move: wait for it to finish, then lift again.`
		);
	}
	const local = deps.localRefusal?.();
	if (local) throw local;

	const peer = peerIdFor(remote, remotes);
	const plan = planAgentLift({
		agent,
		remote,
		peer,
		providerEnvVars: deps.providerEnvVars(agent.toolType),
		withEnv: options.withEnv === true,
	});

	const connection = await deps.connect(remote, peer);
	try {
		onPlan(plan);
		if (options.dryRun) return { plan: plan.summary, dryRun: true };

		const imported = await connection.client.agents.import(plan.input);
		if (!imported.ok) {
			throw (deps.hostCallError ?? defaultHostCallError)(connection.peer, imported.error);
		}
		const { agentId: hostAgentId, queued, notices } = imported.value;
		const pointer: LiftedToPointer = {
			peer: connection.peer,
			agentId: hostAgentId,
			at: (deps.now ?? Date.now)(),
		};

		try {
			await deps.setPointer(agent.id, pointer, plan.movedQueueItemIds);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const undo = await rollBack(connection, hostAgentId);
			throw new LiftRunError(
				'LIFT_POINTER_FAILED',
				`Could not mark "${agent.name}" as moved: ${message}. ${undo}`
			);
		}

		return {
			plan: plan.summary,
			dryRun: false,
			liftedTo: pointer,
			target: peerAgentRef(pointer.peer, pointer.agentId),
			queued,
			...(notices && notices.length > 0 ? { notices } : {}),
		};
	} finally {
		await connection.release();
	}
}
