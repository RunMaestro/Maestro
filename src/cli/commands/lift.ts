// `maestro-cli lift <agent>` - move an SSH remote agent onto the `maestro-cli host` on its remote
// (Federation over SSH, #1716 section 6).
//
// The provider already ran on the remote as the SSH user, so its session files are already there.
// The lift creates the agent on the host (`import_agent`) with the agent's REMOTE working
// directory, provider, model, effort and arguments, every visible tab with its transcript and the
// SAME provider session id, and its queued messages. Then the local agent gains `liftedTo` and
// becomes a pointer: every tab and transcript stays here, and a send to it is refused with the
// `peer:agentId` to use instead.
//
// Refusals come first and cost nothing: already lifted, not an SSH agent, its remote not opted in
// to Federation, a turn running, or a local `maestro-cli host` owning this machine's store. Then
// the host is reached (a host that is not running is refused with the fix), the plan is printed
// (`--json` gives the same plan), and `--dry-run` stops there.
//
// The two writes cannot be one transaction. The host's copy is made first; if the local pointer
// cannot be set, the host's copy is removed again, so the agent never has two owners.

import {
	liftRefusal,
	liftSshRemoteId,
	planAgentLift,
} from '../../shared/maestro-lib/agents/lift-plan';
import type { LiftPlan, LiftPlanSummary } from '../../shared/maestro-lib/agents/lift-plan';
import { peerAgentRef, type LiftedToPointer } from '../../shared/maestro-lib/agents/lift-pointer';
import { isPidAlive, readCliServerInfo } from '../../shared/maestro-lib/client/discovery';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../shared/types';
import {
	readSessionsStoreFile,
	writeSessionsStoreFile,
} from '../../main/stores/sessions-store-file';
import { ExitCode } from '../exit-codes';
import { formatError, formatSuccess, formatWarning } from '../output/formatter';
import { checkAgentBusy, type BusyCheckResult } from '../services/agent-busy';
import { MaestroNotRunningError } from '../services/maestro-not-running';
import {
	PeerResolveError,
	connectPeer,
	hostCallError,
	peerErrorCode,
	peerIdFor,
	requireFederationRemote,
	type PeerConnection,
} from '../services/peer-resolver';
import {
	errorFrameMessage,
	sendSimpleCommand,
	type SimpleResult,
} from '../services/session-command';
import {
	getSyncDir,
	readAgentConfig,
	readSessions,
	readSshRemotes,
	resolveAgentId,
} from '../services/storage';

export interface LiftOptions {
	json?: boolean;
	/** Print the plan and stop. */
	dryRun?: boolean;
	/** Send secret env vars too. */
	withEnv?: boolean;
}

/** Who owns this machine's agent store right now, and so who must write the pointer. */
export type LocalStoreOwner = 'desktop' | 'headless-host' | 'none';

/** What `lift` needs from the world, so a test can stand in for it. */
export interface LiftDeps {
	/** The stored agent records, as the desktop persisted them (tabs and transcripts included). */
	readAgents(): AgentRecord[];
	readRemotes(): SshRemoteConfig[];
	resolveAgentId(ref: string): string;
	/** The provider-level env vars (Settings -> Agents) for a provider. */
	providerEnvVars(provider: string): Record<string, string> | undefined;
	/** A run another CLI instance started on the agent. */
	cliBusy(agentId: string): BusyCheckResult;
	localStoreOwner(): LocalStoreOwner;
	connect(peerRef: string): Promise<PeerConnection>;
	/** Set the pointer through the running desktop, which owns the store while it runs. */
	setPointerInDesktop(
		agentId: string,
		pointer: LiftedToPointer,
		movedQueueItemIds: string[]
	): Promise<SimpleResult>;
	/** Set the pointer in the store file. Only while nothing else owns the store. */
	setPointerOnDisk(
		agentId: string,
		pointer: LiftedToPointer,
		movedQueueItemIds: string[]
	): Promise<void>;
	now(): number;
}

function envRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === 'string') out[key] = entry;
	}
	return out;
}

/** The agent record with the pointer set and the moved queue items taken off its queue. */
export function withLiftPointer(
	record: Record<string, unknown>,
	pointer: LiftedToPointer,
	movedQueueItemIds: readonly string[]
): Record<string, unknown> {
	const moved = new Set(movedQueueItemIds);
	const queue = Array.isArray(record.executionQueue) ? record.executionQueue : undefined;
	return {
		...record,
		liftedTo: pointer,
		...(queue
			? {
					executionQueue: queue.filter(
						(item) =>
							!(item && typeof item === 'object' && moved.has((item as { id?: string }).id ?? ''))
					),
				}
			: {}),
	};
}

const defaultDeps: LiftDeps = {
	readAgents: () => readSessions() as unknown as AgentRecord[],
	readRemotes: () => readSshRemotes(),
	resolveAgentId: (ref) => resolveAgentId(ref),
	providerEnvVars: (provider) => envRecord(readAgentConfig(provider).customEnvVars),
	cliBusy: (agentId) => checkAgentBusy(agentId),
	localStoreOwner: () => {
		const info = readCliServerInfo();
		if (!info || !isPidAlive(info.pid)) return 'none';
		return info.hostKind === 'headless' ? 'headless-host' : 'desktop';
	},
	connect: (peerRef) => connectPeer(peerRef),
	setPointerInDesktop: (agentId, pointer, movedQueueItemIds) =>
		sendSimpleCommand(
			{
				type: 'update_session_config',
				sessionId: agentId,
				configPatch: { liftedTo: pointer, liftedQueueItemIds: movedQueueItemIds },
			},
			'update_session_config_result'
		),
	setPointerOnDisk: async (agentId, pointer, movedQueueItemIds) => {
		const dir = getSyncDir();
		const { data, sessions } = readSessionsStoreFile(dir);
		if (!sessions.some((session) => session.id === agentId)) {
			throw new Error(`Agent ${agentId} is no longer in the agent store`);
		}
		const updated = sessions.map((session) =>
			session.id === agentId
				? (withLiftPointer(
						session as unknown as Record<string, unknown>,
						pointer,
						movedQueueItemIds
					) as unknown as typeof session)
				: session
		);
		await writeSessionsStoreFile(dir, { ...data, sessions: updated });
	},
	now: () => Date.now(),
};

/** A refusal or failure, with the `--json` code and the exit code it ends with. */
class LiftError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly exitCode: ExitCode = ExitCode.GeneralError
	) {
		super(message);
		this.name = 'LiftError';
	}
}

function refusalCode(code: string): string {
	return `LIFT_${code.toUpperCase().replace(/-/g, '_')}`;
}

/** The plan, as a person reads it before anything moves. */
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

/** Remove the host's copy after the pointer could not be set. Returns a line for the error. */
async function rollBack(connection: PeerConnection, hostAgentId: string): Promise<string> {
	const removed = await connection.client.agents.remove(hostAgentId);
	if (removed.ok) return `The host's copy was removed again, so the agent stays here, unchanged.`;
	return `The host's copy (${peerAgentRef(connection.peer, hostAgentId)}) could not be removed: ${removed.error.message} On the remote, run: maestro-cli remove-agent ${hostAgentId}`;
}

/** Set the local pointer through whoever owns the store. Throws on failure. */
async function setPointer(
	deps: LiftDeps,
	owner: LocalStoreOwner,
	agentId: string,
	pointer: LiftedToPointer,
	moved: string[]
): Promise<void> {
	if (owner === 'desktop') {
		try {
			const result = await deps.setPointerInDesktop(agentId, pointer, moved);
			if (result.success) return;
			throw new Error(
				result.error || errorFrameMessage(result) || 'The desktop refused the pointer'
			);
		} catch (error) {
			// The desktop quit since the check: nothing owns the store now, so the file is ours.
			if (!(error instanceof MaestroNotRunningError)) throw error;
		}
	}
	await deps.setPointerOnDisk(agentId, pointer, moved);
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

/** Every step of a lift, without printing. Throws `LiftError` or `PeerResolveError`. */
export async function runLift(
	agentRef: string,
	options: LiftOptions,
	deps: LiftDeps,
	onPlan: (plan: LiftPlan) => void = () => {}
): Promise<LiftResult> {
	let agentId: string;
	try {
		agentId = deps.resolveAgentId(agentRef);
	} catch (error) {
		throw new LiftError('AGENT_NOT_FOUND', error instanceof Error ? error.message : String(error));
	}
	const agent = deps.readAgents().find((record) => record.id === agentId);
	if (!agent) throw new LiftError('AGENT_NOT_FOUND', `Agent not found: ${agentRef}`);

	const remotes = deps.readRemotes();
	const refusal = liftRefusal(agent, remotes);
	if (refusal) throw new LiftError(refusalCode(refusal.code), refusal.message);
	const remote = remotes.find((candidate) => candidate.id === liftSshRemoteId(agent));
	if (!remote) throw new LiftError(refusalCode('remote-missing'), 'SSH remote not found');
	requireFederationRemote(remote);

	const busy = deps.cliBusy(agent.id);
	if (busy.busy) {
		throw new LiftError(
			refusalCode('busy'),
			`"${agent.name}" is busy: ${busy.reason}. A running turn cannot move: wait for it to finish, then lift again.`
		);
	}
	const owner = deps.localStoreOwner();
	if (owner === 'headless-host') {
		throw new LiftError(
			'LIFT_LOCAL_HOST',
			"A maestro-cli host owns this machine's agents, so the lift cannot mark the local agent as moved. Stop it (maestro-cli host stop), or lift from the desktop app."
		);
	}

	const plan = planAgentLift({
		agent,
		remote,
		peer: peerIdFor(remote, remotes),
		providerEnvVars: deps.providerEnvVars(agent.toolType),
		withEnv: options.withEnv === true,
	});

	const connection = await deps.connect(remote.id);
	try {
		onPlan(plan);
		if (options.dryRun) return { plan: plan.summary, dryRun: true };

		const imported = await connection.client.agents.import(plan.input);
		if (!imported.ok) throw hostCallError(connection.peer, imported.error);
		const { agentId: hostAgentId, queued, notices } = imported.value;
		const pointer: LiftedToPointer = {
			peer: connection.peer,
			agentId: hostAgentId,
			at: deps.now(),
		};

		try {
			await setPointer(deps, owner, agent.id, pointer, plan.movedQueueItemIds);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const undo = await rollBack(connection, hostAgentId);
			throw new LiftError(
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

/** `maestro-cli lift <agent>`. */
export async function lift(
	agentRef: string,
	options: LiftOptions,
	overrides: Partial<LiftDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	try {
		const result = await runLift(agentRef, options, deps, (plan) => {
			if (!options.json) console.log(formatLiftPlan(plan.summary, options.dryRun === true));
		});
		if (options.json) {
			console.log(JSON.stringify({ success: true, ...result }, null, 2));
			return;
		}
		if (result.dryRun) {
			console.log('Dry run: nothing moved.');
			return;
		}
		for (const notice of result.notices ?? []) console.log(formatWarning(notice));
		console.log(
			formatSuccess(
				`Lifted "${result.plan.agent.name}". It runs on the host now: send to ${result.target}`
			)
		);
	} catch (error) {
		const code =
			error instanceof LiftError
				? error.code
				: error instanceof PeerResolveError
					? peerErrorCode(error.code)
					: 'LIFT_FAILED';
		const exitCode =
			error instanceof LiftError || error instanceof PeerResolveError
				? error.exitCode
				: ExitCode.GeneralError;
		const message = error instanceof Error ? error.message : String(error);
		if (options.json)
			console.log(JSON.stringify({ success: false, error: message, code }, null, 2));
		else console.error(formatError(message));
		process.exitCode = exitCode;
	}
}
