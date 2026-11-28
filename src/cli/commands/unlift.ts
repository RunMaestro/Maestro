// `maestro-cli unlift <agent>` - move a hosted agent back from its Federation host: the reverse of
// `maestro-cli lift`, and the CLI half of the desktop's "Move Back from Host" right-click action.
//
// The agent becomes an SSH agent again. The host's tabs come back with their transcripts and
// provider session ids (a tab that moved lands on its own local tab), the host's copy is removed
// unless --keep-host-copy, and automatic Federation leaves the agent here from then on. A turn
// running on the host, or a message still waiting in its queue there, is refused.
//
// --offline moves the agent back without reaching the host: only what this machine kept comes
// back, and the host's copy stays until it is removed there.
//
// Every step runs in `runReturnFromHost()` (`src/shared/maestro-lib/agents/lift-return.ts`), the
// function the desktop runs too. This file adds the CLI's own: its SSH forward, the store owner
// check, the write through the desktop or the store file, and the output.

import { LiftRunError } from '../../shared/maestro-lib/agents/lift-run';
import {
	runReturnFromHost,
	withReturnedFromHost,
	type ReturnedFromHost,
	type ReturnResult,
	type ReturnRunDeps,
} from '../../shared/maestro-lib/agents/lift-return';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import {
	readSessionsStoreFile,
	writeSessionsStoreFile,
} from '../../main/stores/sessions-store-file';
import { ExitCode } from '../exit-codes';
import { formatError, formatSuccess, formatWarning } from '../output/formatter';
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
import { getSyncDir, readSessions, resolveAgentId } from '../services/storage';
import { localStoreOwner, type LocalStoreOwner } from './lift';

export interface UnliftOptions {
	json?: boolean;
	/** Do not reach the host: restore from this machine's copy only. */
	offline?: boolean;
	/** Leave the agent on the host too. */
	keepHostCopy?: boolean;
}

/** What `unlift` needs from the world, so a test can stand in for it. */
export interface UnliftDeps {
	readAgents(): AgentRecord[];
	resolveAgentId(ref: string): string;
	localStoreOwner(): LocalStoreOwner;
	connect(remoteId: string): Promise<PeerConnection>;
	/** Restore through the running desktop, which owns the store while it runs. */
	restoreInDesktop(agentId: string, returned: ReturnedFromHost): Promise<SimpleResult>;
	/** Restore in the store file. Only while nothing else owns the store. */
	restoreOnDisk(agentId: string, returned: ReturnedFromHost): Promise<void>;
}

const defaultDeps: UnliftDeps = {
	readAgents: () => readSessions() as unknown as AgentRecord[],
	resolveAgentId: (ref) => resolveAgentId(ref),
	localStoreOwner,
	connect: (remoteId) => connectPeer(remoteId),
	restoreInDesktop: (agentId, returned) =>
		sendSimpleCommand(
			{
				type: 'update_session_config',
				sessionId: agentId,
				configPatch: { returnedFromHost: returned },
			},
			'update_session_config_result'
		),
	restoreOnDisk: async (agentId, returned) => {
		const dir = getSyncDir();
		const { data, sessions } = readSessionsStoreFile(dir);
		if (!sessions.some((session) => session.id === agentId)) {
			throw new Error(`Agent ${agentId} is no longer in the agent store`);
		}
		const updated = sessions.map((session) =>
			session.id === agentId
				? (withReturnedFromHost(
						session as unknown as Record<string, unknown>,
						returned
					) as unknown as typeof session)
				: session
		);
		await writeSessionsStoreFile(dir, { ...data, sessions: updated });
	},
};

/** Write the restored record through whoever owns the store. Throws on failure. */
async function restore(
	deps: UnliftDeps,
	agentId: string,
	returned: ReturnedFromHost
): Promise<void> {
	const owner = deps.localStoreOwner();
	if (owner === 'headless-host') {
		throw new Error(
			"A maestro-cli host owns this machine's agents. Stop it (maestro-cli host stop), or move the agent back from the desktop app"
		);
	}
	if (owner === 'desktop') {
		try {
			const result = await deps.restoreInDesktop(agentId, returned);
			if (result.success) return;
			throw new Error(result.error || errorFrameMessage(result) || 'The desktop refused');
		} catch (error) {
			// The desktop quit since the check: nothing owns the store now, so the file is ours.
			if (!(error instanceof MaestroNotRunningError)) throw error;
		}
	}
	await deps.restoreOnDisk(agentId, returned);
}

function sharedDeps(deps: UnliftDeps): ReturnRunDeps {
	return {
		readAgents: deps.readAgents,
		resolveAgentId: deps.resolveAgentId,
		connect: (remoteId) => deps.connect(remoteId),
		hostCallError,
		restore: (agentId, returned) => restore(deps, agentId, returned),
	};
}

/** The code, exit code, and message `unlift` reports for a failed return. */
function failureOf(error: unknown): { code: string; exitCode: number; message: string } {
	const code =
		error instanceof LiftRunError
			? error.code
			: error instanceof PeerResolveError
				? peerErrorCode(error.code)
				: 'RETURN_FAILED';
	const exitCode = error instanceof PeerResolveError ? error.exitCode : ExitCode.GeneralError;
	const message = error instanceof Error ? error.message : String(error);
	return { code, exitCode, message };
}

/** `maestro-cli unlift <agent>`. */
export async function unlift(
	agentRef: string,
	options: UnliftOptions,
	overrides: Partial<UnliftDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	try {
		const result = await runReturnFromHost(
			agentRef,
			{ offline: options.offline === true, keepHostCopy: options.keepHostCopy === true },
			sharedDeps(deps)
		);
		if (options.json) {
			console.log(JSON.stringify({ success: true, ...result }, null, 2));
			return;
		}
		for (const notice of result.notices ?? []) console.log(formatWarning(notice));
		console.log(
			formatSuccess(
				`"${result.agent.name}" is an SSH agent again (${result.tabs} tab(s) back from ${result.from}${result.hostCopyRemoved ? ', host copy removed' : ''})`
			)
		);
	} catch (error) {
		const { code, exitCode, message } = failureOf(error);
		if (options.json)
			console.log(JSON.stringify({ success: false, error: message, code }, null, 2));
		else console.error(formatError(message));
		process.exitCode = exitCode;
	}
}

/** One agent's outcome in `unlift --all`. */
export type UnliftAllOutcome =
	| ({ ok: true } & ReturnResult)
	| { ok: false; agent: { id: string; name: string }; code: string; error: string };

/**
 * `maestro-cli unlift --all`: move every agent that is on a host back, one at a time (one SSH
 * connection at a time), and report each one. Each return reaches its host; one whose host does
 * not answer stays moved and is reported, unless --offline, which restores every agent from this
 * machine's copy without dialing.
 */
export async function unliftAll(
	options: UnliftOptions,
	overrides: Partial<UnliftDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	const moved = deps.readAgents().filter((agent) => readLiftedTo(agent.liftedTo));
	const outcomes: UnliftAllOutcome[] = [];
	for (const agent of moved) {
		try {
			const result = await runReturnFromHost(
				agent.id,
				{ offline: options.offline === true, keepHostCopy: options.keepHostCopy === true },
				// The id is already resolved: a name two agents share must not pick the wrong one.
				{ ...sharedDeps(deps), resolveAgentId: (id) => id }
			);
			outcomes.push({ ok: true, ...result });
		} catch (error) {
			const { code, message } = failureOf(error);
			outcomes.push({ ok: false, agent: { id: agent.id, name: agent.name }, code, error: message });
		}
	}
	const failed = outcomes.filter((outcome) => !outcome.ok).length;
	if (failed > 0) process.exitCode = ExitCode.GeneralError;
	if (options.json) {
		console.log(JSON.stringify({ success: failed === 0, agents: outcomes }, null, 2));
		return;
	}
	if (outcomes.length === 0) {
		console.log(formatSuccess('No agent is on a host: nothing to move back'));
		return;
	}
	for (const outcome of outcomes) {
		if (!outcome.ok) {
			console.error(formatError(`"${outcome.agent.name}" is still on its host: ${outcome.error}`));
			continue;
		}
		for (const notice of outcome.notices ?? []) console.log(formatWarning(notice));
		console.log(
			formatSuccess(
				`"${outcome.agent.name}" is an SSH agent again (${outcome.tabs} tab(s) back from ${outcome.from}${outcome.hostCopyRemoved ? ', host copy removed' : ''})`
			)
		);
	}
}
