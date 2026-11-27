/**
 * Running a Federation lift: every step from "which agent" to "the local copy is a pointer", shared
 * by `maestro-cli lift` and the desktop's "Move to Host" action (#1716 section 6).
 *
 * The rules live in `lift-plan.ts` (refusals, payload, summary) and `lift-pointer.ts` (the
 * pointer). This module runs them in order against what the caller injects, so the CLI and the
 * desktop make the same checks, print the same plan, and roll back the same way:
 *
 * 1. Record refusals (`liftRefusal()`), the remote's Federation opt-out, a running turn the record
 *    cannot show (`busyReason`), and the caller's own refusal (`localRefusal`). None costs a dial.
 * 2. The plan (`planAgentLift()`), handed to `onPlan` once the host is reached. A dry run stops.
 *    A copy of the SAME agent that an earlier Move Back left on this host (`leftOnHost`) is read
 *    first: its tabs merge into what moves, and the import replaces it (`replacesAgentId`), so the
 *    move is not refused for the name that copy holds and nothing said there is lost.
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
import { isFederationRemote } from '../../federationRemote';
import { LIFT_HOST_TOO_OLD } from '../../federationCommands';
import type { ClientError, MaestroClient } from '../client/types';
import type { AgentRecord } from '../store/records';
import { staleCopyMismatch } from './import-plan';
import { formatHostTabMerge, liftRefusal, liftSshRemoteId, planAgentLift } from './lift-plan';
import type { LiftPlan, LiftPlanSummary } from './lift-plan';
import { peerAgentRef, runningTurnWhere, type LiftedToPointer } from './lift-pointer';
import {
	containingTranscript,
	readLeftOnHost,
	withReturnedFromHost,
	type TranscriptSide,
} from './lift-return-record';
import { liftFollowUpPatch } from './lift-settings-sync';
import type { AITabRecord } from '../store/records';
import { truncateAtWordBoundary } from '../../formatters';
import { stripMarkdown } from '../../markdown';

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
	client: Pick<MaestroClient, 'agents' | 'tabs' | 'turns'>;
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
	if (summary.replaces) {
		lines.push(
			`Replaces the copy an earlier Move Back left on the host (${summary.replaces}): its tabs and transcripts are merged into what moves, its processes are stopped, and its History on the host stays filed under its old id, so the moved agent's History does not show it.`
		);
		const merge = formatHostTabMerge(summary.tabMerge);
		if (merge) lines.push(`  ${merge}`);
	}
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

/**
 * The host on `peer` does not know `import_agent`. A newer maestro-cli cannot fix this when the
 * remote's desktop app is the host: the handler lives in that app's main process. And the version
 * string cannot predict it, because builds inside one RC share a version.
 */
function importUnsupportedMessage(peer: string): string {
	return (
		`the Maestro running there is an older build that cannot accept a moved agent. ` +
		`Update Maestro.app on ${peer} and relaunch it (or, when no desktop app runs there, ` +
		`run \`maestro-cli remote-host install ${peer} --restart --force\`), then move again.`
	);
}

function defaultHostCallError(peer: string, error: Pick<ClientError, 'code' | 'message'>): Error {
	return new LiftRunError(
		error.code === 'unsupported' ? LIFT_HOST_TOO_OLD : 'LIFT_HOST_FAILED',
		`Peer "${peer}": ${error.message}`
	);
}

/** Remove the host's copy after the pointer could not be set. Returns a line for the error. */
async function rollBack(connection: LiftHostConnection, hostAgentId: string): Promise<string> {
	const removed = await connection.client.agents.remove(hostAgentId);
	if (removed.ok) return `The host's copy was removed again, so the agent stays here, unchanged.`;
	const ref = peerAgentRef(connection.peer, hostAgentId);
	return `The host's copy (${ref}) could not be removed: ${removed.error.message} Once the host answers, run: maestro-cli remove-agent ${ref}`;
}

/** The host copy an earlier Move Back left behind, read for a lift that replaces it. */
interface StaleHostCopy {
	pointer: LiftedToPointer;
	ref: string;
	/** The agent with that copy's tabs merged in, as an online Move Back would have left it. */
	merged: AgentRecord;
	/** How those tabs merged, for the plan (`LiftPlanSummary.tabMerge`). */
	tabMerge: NonNullable<LiftPlanSummary['tabMerge']>;
}

/**
 * The copy of this agent an earlier Move Back left on the host it moves to (`leftOnHost`), with
 * its tabs and transcripts, or undefined when there is none (never left, another host, or since
 * removed). A copy running a turn or holding queued messages is refused, as a Move Back refuses
 * it: replacing it would cut the turn or drop the messages.
 */
async function readStaleHostCopy(
	agent: AgentRecord,
	connection: LiftHostConnection,
	hostError: (peer: string, error: Pick<ClientError, 'code' | 'message'>) => Error
): Promise<StaleHostCopy | undefined> {
	const pointer = readLeftOnHost(agent);
	if (!pointer || pointer.peer !== connection.peer) return undefined;
	const { client } = connection;
	const hostCopy = await client.agents.get(pointer.agentId);
	if (!hostCopy.ok) {
		if (hostCopy.error.code === 'not-found') return undefined;
		throw hostError(connection.peer, hostCopy.error);
	}
	const ref = peerAgentRef(pointer.peer, pointer.agentId);
	// The host checks this too (`planAgentImport()`); asking first names the exact command.
	const mismatch = staleCopyMismatch(hostCopy.value, {
		name: agent.name,
		liftedFromAgentId: agent.id,
	});
	if (mismatch) {
		throw new LiftRunError(
			liftErrorCode('host-copy-foreign'),
			`${mismatch} Remove it (maestro-cli remove-agent ${ref}), then move again.`
		);
	}
	if (runningTurnWhere(hostCopy.value) !== null) {
		throw new LiftRunError(
			liftErrorCode('host-copy-busy'),
			`"${agent.name}" still has a copy on the host (${ref}) that is running a turn. Wait for it to finish, or stop it, then move again.`
		);
	}
	const queue = await client.turns.queue.list(pointer.agentId);
	if (!queue.ok) throw hostError(connection.peer, queue.error);
	if (queue.value.length > 0) {
		throw new LiftRunError(
			liftErrorCode('host-copy-queued'),
			`${queue.value.length} message(s) still wait in the queue of "${agent.name}"'s copy on the host (${ref}). Let them run or remove them, then move again.`
		);
	}
	const tabs = await client.tabs.list(pointer.agentId);
	if (!tabs.ok) throw hostError(connection.peer, tabs.error);
	const withLogs: AITabRecord[] = [];
	for (const tab of tabs.value) {
		const transcript = await client.tabs.transcript(pointer.agentId, tab.id);
		if (!transcript.ok) throw hostError(connection.peer, transcript.error);
		withLogs.push({ ...tab, logs: transcript.value });
	}
	const hostTabs = keepDivergentHostTabs(agent.aiTabs ?? [], withLogs);
	// The host's selection follows its tab when that tab comes in under another id.
	const hostActive = hostCopy.value.activeTabId;
	const activeIndex = hostActive ? withLogs.findIndex((tab) => tab.id === hostActive) : -1;
	const activeTabId = activeIndex >= 0 ? hostTabs.tabs[activeIndex].id : hostActive;
	const merged = withReturnedFromHost(agent as unknown as Record<string, unknown>, {
		tabs: hostTabs.tabs,
		transcriptSides: hostTabs.transcriptSides,
		...(activeTabId ? { activeTabId } : {}),
	}) as unknown as AgentRecord;
	return {
		pointer,
		ref,
		merged,
		tabMerge: { merged: hostTabs.merged, copies: hostTabs.copies, added: hostTabs.added },
	};
}

/** The text of a transcript's user messages, in order: the turns of its conversation. */
function userTurns(tab: AITabRecord): string[] {
	const turns: string[] = [];
	for (const entry of Array.isArray(tab.logs) ? tab.logs : []) {
		if (!entry || typeof entry !== 'object') continue;
		const { source, text } = entry as { source?: unknown; text?: unknown };
		if (source === 'user') turns.push(typeof text === 'string' ? text : '');
	}
	return turns;
}

/** The longest name a host tab is given from its first message. */
const MAX_FIRST_MESSAGE_TAB_NAME_CHARS = 40;

/**
 * A name for a host tab that has none (a turn run on the host copy itself, which no client named):
 * the first line of its first message, as plain text. Undefined when it has no message.
 */
function firstMessageTabName(tab: AITabRecord): string | undefined {
	for (const turn of userTurns(tab)) {
		const line = stripMarkdown(turn)
			.split('\n')
			.map((part) => part.trim())
			.find(Boolean);
		if (line) return truncateAtWordBoundary(line, MAX_FIRST_MESSAGE_TAB_NAME_CHARS);
	}
	return undefined;
}

/** How the host copy's tabs merge into what moves (`keepDivergentHostTabs()`). */
export interface HostTabMerge {
	/** The host's tabs, in its order, ready for `withReturnedFromHost()`. */
	tabs: AITabRecord[];
	/** Host tabs that are a local tab's conversation: merged into it, one tab each. */
	merged: number;
	/** Host tabs of a conversation both sides went on in: kept as their own "(on the host)" tab. */
	copies: number;
	/** Host tabs this machine never had (a conversation started on the host copy). */
	added: number;
	/**
	 * For each merged tab, by its (local) id, the side whose transcript holds the other's: what
	 * `withReturnedFromHost()` keeps (`ReturnedFromHost.transcriptSides`).
	 */
	transcriptSides: Record<string, TranscriptSide>;
}

/**
 * The host copy's tabs, ready to merge into the local agent (`withReturnedFromHost()`). A host tab
 * is the local tab with its id, else the one that resumes its provider session. It is one
 * conversation, so one tab (U4), only when one transcript holds the other entry for entry
 * (`containingTranscript()`); that side's transcript is kept (`transcriptSides`), so a merge never
 * drops an entry. After a Move Back while the host was down, both sides may have gone on in it:
 * the host's tab comes in as a tab of its own, "(on the host)", so neither side's entries are lost. A host
 * tab with no name is named from its first message, never left to read as its session id.
 */
export function keepDivergentHostTabs(
	localTabs: readonly AITabRecord[],
	hostTabs: readonly AITabRecord[]
): HostTabMerge {
	const localById = new Map(localTabs.map((tab) => [tab.id, tab]));
	const localBySession = new Map<string, AITabRecord>();
	for (const tab of localTabs) {
		if (tab.agentSessionId && !localBySession.has(tab.agentSessionId)) {
			localBySession.set(tab.agentSessionId, tab);
		}
	}
	const taken = new Set([...localTabs, ...hostTabs].map((tab) => tab.id));
	const freshId = (base: string) => {
		let id = `${base}-host`;
		for (let n = 2; taken.has(id); n++) id = `${base}-host-${n}`;
		taken.add(id);
		return id;
	};
	// Which local tab each host tab is: its own id first, then its provider session. A local tab
	// takes at most one host tab; a second host tab of the same conversation is a copy of its own.
	const localOf = new Map<AITabRecord, AITabRecord>();
	const claimed = new Set<string>();
	// A host that lists two tabs under one id (a value from the host is untrusted) gets the second
	// as a copy, so no two tabs end with one id and neither overwrites the other.
	const extra = new Set<AITabRecord>();
	for (const host of hostTabs) {
		const local = localById.get(host.id);
		if (!local) continue;
		localOf.set(host, local);
		if (claimed.has(local.id)) extra.add(host);
		else claimed.add(local.id);
	}
	for (const host of hostTabs) {
		if (localOf.has(host) || !host.agentSessionId) continue;
		const local = localBySession.get(host.agentSessionId);
		if (!local) continue;
		localOf.set(host, local);
		if (claimed.has(local.id)) extra.add(host);
		else claimed.add(local.id);
	}
	const result: HostTabMerge = {
		tabs: [],
		merged: 0,
		copies: 0,
		added: 0,
		transcriptSides: Object.create(null) as Record<string, TranscriptSide>,
	};
	const added = new Set<string>();
	for (const host of hostTabs) {
		const local = localOf.get(host);
		if (!local) {
			result.added += 1;
			const named = host.name ? host : { ...host, name: firstMessageTabName(host) ?? host.name };
			const id = added.has(host.id) ? freshId(host.id) : host.id;
			added.add(id);
			result.tabs.push(id === host.id ? named : { ...named, id });
			continue;
		}
		const side = extra.has(host) ? undefined : containingTranscript(host.logs, local.logs);
		if (side) {
			result.merged += 1;
			result.transcriptSides[local.id] = side;
			result.tabs.push(local.id === host.id ? host : { ...host, id: local.id });
			continue;
		}
		result.copies += 1;
		result.tabs.push({
			...host,
			id: freshId(host.id),
			name: `${host.name || local.name || 'Tab'} (on the host)`,
		});
	}
	return result;
}

/** The plan, with the import replacing the stale copy and the summary saying so. */
function withReplacement(
	plan: LiftPlan,
	ref: string,
	replacesAgentId: string,
	tabMerge: LiftPlanSummary['tabMerge']
): LiftPlan {
	return {
		...plan,
		summary: { ...plan.summary, replaces: ref, ...(tabMerge ? { tabMerge } : {}) },
		input: { ...plan.input, replacesAgentId },
	};
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
	if (!isFederationRemote(remote)) {
		throw new LiftRunError('PEER_FEDERATION_OFF', federationOffMessage(remote));
	}
	// A disabled remote is not mirrored, so its pointer would lead nowhere.
	if (remote.enabled === false) {
		throw new LiftRunError(
			liftErrorCode('remote-disabled'),
			`SSH remote "${remote.name}" is disabled. Enable it in Settings > SSH Hosts first.`
		);
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
	const planFor = (record: AgentRecord) =>
		planAgentLift({
			agent: record,
			remote,
			peer,
			providerEnvVars: deps.providerEnvVars(record.toolType),
			withEnv: options.withEnv === true,
		});

	const connection = await deps.connect(remote, peer);
	try {
		const hostError = deps.hostCallError ?? defaultHostCallError;
		const stale = await readStaleHostCopy(agent, connection, hostError);
		const plan = stale
			? withReplacement(planFor(stale.merged), stale.ref, stale.pointer.agentId, stale.tabMerge)
			: planFor(agent);
		onPlan(plan);
		if (options.dryRun) return { plan: plan.summary, dryRun: true };

		const imported = await connection.client.agents.import(plan.input);
		if (!imported.ok) {
			const error =
				imported.error.code === 'unsupported'
					? { ...imported.error, message: importUnsupportedMessage(connection.peer) }
					: imported.error;
			throw hostError(connection.peer, error);
		}
		const { agentId: hostAgentId, queued } = imported.value;
		const notices = [...(imported.value.notices ?? [])];
		// The settings an import cannot carry go right after it, so the hosted copy starts whole
		// and the first settings sync finds nothing to ask about. A refusal here does not undo the
		// lift: the agent moved, and the sync shows what still differs.
		const followUp = liftFollowUpPatch(agent);
		if (followUp) {
			const updated = await connection.client.agents.update(hostAgentId, followUp);
			if (!updated.ok) {
				notices.push(`Some settings did not reach the host: ${updated.error.message}`);
			}
		}
		const pointer: LiftedToPointer = {
			peer: connection.peer,
			agentId: hostAgentId,
			at: (deps.now ?? Date.now)(),
		};

		try {
			await deps.setPointer(agent.id, pointer, plan.movedQueueItemIds);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// A lift that replaced the earlier copy holds tabs only the host had, and that copy is
			// gone: removing the new one would lose them. It stays, and the error says where.
			const kept = peerAgentRef(connection.peer, hostAgentId);
			const undo = stale
				? `The host's copy (${kept}) is kept: it holds tabs from its earlier copy that this machine does not have. To get the agent back with them, add it to the Left Bar (maestro-cli federation add ${kept}) and move it back from there; to drop them instead: maestro-cli remove-agent ${kept}`
				: await rollBack(connection, hostAgentId);
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
			...(notices.length > 0 ? { notices } : {}),
		};
	} finally {
		await connection.release();
	}
}
