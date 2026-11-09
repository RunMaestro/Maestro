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
//
// Every step runs in `runLift()` (`src/shared/maestro-lib/agents/lift-run.ts`), the function the
// desktop's "Move to Host" action runs too. This file adds what is the CLI's own: its SSH forward,
// the store owner check, the pointer write through the desktop or the store file, and the output.

import {
	LiftRunError,
	formatLiftPlan,
	providerEnvVarsOf,
	runLift,
	type LiftRunDeps,
} from '../../shared/maestro-lib/agents/lift-run';
import type { LiftedToPointer } from '../../shared/maestro-lib/agents/lift-pointer';
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
	providerEnvVars: (provider) => providerEnvVarsOf(readAgentConfig(provider).customEnvVars),
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

/** The CLI's world as the shared runner's deps. */
function sharedDeps(deps: LiftDeps): LiftRunDeps {
	let owner: LocalStoreOwner = 'none';
	return {
		readAgents: deps.readAgents,
		readRemotes: deps.readRemotes,
		resolveAgentId: deps.resolveAgentId,
		providerEnvVars: deps.providerEnvVars,
		busyReason: (agentId) => {
			const busy = deps.cliBusy(agentId);
			return busy.busy ? busy.reason : undefined;
		},
		localRefusal: () => {
			owner = deps.localStoreOwner();
			if (owner !== 'headless-host') return undefined;
			return new LiftRunError(
				'LIFT_LOCAL_HOST',
				"A maestro-cli host owns this machine's agents, so the lift cannot mark the local agent as moved. Stop it (maestro-cli host stop), or lift from the desktop app."
			);
		},
		connect: (remote) => deps.connect(remote.id),
		hostCallError,
		setPointer: (agentId, pointer, moved) => setPointer(deps, owner, agentId, pointer, moved),
		now: deps.now,
	};
}

/** `maestro-cli lift <agent>`. */
export async function lift(
	agentRef: string,
	options: LiftOptions,
	overrides: Partial<LiftDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	try {
		const result = await runLift(agentRef, options, sharedDeps(deps), (plan) => {
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
			error instanceof LiftRunError
				? error.code
				: error instanceof PeerResolveError
					? peerErrorCode(error.code)
					: 'LIFT_FAILED';
		const exitCode = error instanceof PeerResolveError ? error.exitCode : ExitCode.GeneralError;
		const message = error instanceof Error ? error.message : String(error);
		if (options.json)
			console.log(JSON.stringify({ success: false, error: message, code }, null, 2));
		else console.error(formatError(message));
		process.exitCode = exitCode;
	}
}
