/**
 * Token breakdowns of the agents whose conversations are on another computer: SSH agents (the
 * transcripts are on the remote) and hosted agents (they are on the Federation host, which is the
 * same remote). Both are counted the same way, so a remote and a hosted agent add to the
 * dashboard's totals exactly as a local one does.
 *
 * The totals are computed where the transcripts are: this machine sends the remote's host one
 * `get_project_token_usage` with the provider and the remote working directory of each agent on it,
 * over the connection the peer mirror already holds (`PeerMirrorService.projectTokenUsage()`), and
 * merges the numbers it answers. No transcript is copied here.
 *
 * Every call is bounded in time and runs beside the local scan. A remote with no host connected
 * (a plain SSH remote with no `maestro-cli host`, or a host that is down), an older host that does
 * not know the message, a provider the host cannot read, a timeout, or a failure all leave the
 * agent "not counted", by name, and never raise an error.
 */

import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { liftRemoteCwd, liftSshRemoteId } from '../../../shared/maestro-lib/agents/lift-plan';
import type { SessionTokenBreakdown } from '../../../shared/tokenUsage';
import type {
	ProjectTokenUsage,
	ProjectTokenUsageProject,
} from '../../../shared/projectTokenUsage';
import { uniqueProjects } from '../../../shared/projectTokenUsage';

/** How long one remote may take to answer before its agents are left "not counted". */
export const REMOTE_TOKEN_USAGE_TIMEOUT_MS = 30_000;

/** One agent whose conversations are on another computer. */
export interface RemoteTokenAgent {
	id: string;
	name: string;
	provider: string;
	/** The SSH remote the conversations are on. */
	remoteId: string;
	/** The agent's working directory on that remote. */
	projectPath: string;
}

/** Asks one remote for its projects' usage. Undefined: the remote could not answer. */
export type RemoteTokenUsageRequest = (
	remoteId: string,
	projects: ProjectTokenUsageProject[],
	timeoutMs: number
) => Promise<ProjectTokenUsage | undefined>;

export interface RemoteBreakdowns {
	breakdowns: SessionTokenBreakdown[];
	/** The agents whose usage could not be read, in the order given. */
	notCounted: RemoteTokenAgent[];
	/** Every `provider|projectPath` pair of the agents given, counted or not. */
	pairs: Set<string>;
}

/** The pair key the stats lifecycle rows are compared by. */
export function remoteProjectPairKey(provider: string, projectPath: string): string {
	return `${provider}|${projectPath}`;
}

/**
 * The agents in `records` whose conversations are on another computer: every agent bound to an
 * SSH remote, hosted or not (a hosted record keeps its SSH fields). The terminal has no model
 * behind it, and an agent with no working directory has no project to ask about.
 */
export function remoteTokenAgentsOf(records: readonly AgentRecord[]): RemoteTokenAgent[] {
	const agents: RemoteTokenAgent[] = [];
	for (const record of records) {
		if (!record || typeof record.id !== 'string' || record.toolType === 'terminal') continue;
		const remoteId = liftSshRemoteId(record);
		const projectPath = liftRemoteCwd(record);
		if (!remoteId || !projectPath) continue;
		agents.push({
			id: record.id,
			name: typeof record.name === 'string' && record.name ? record.name : record.id,
			provider: record.toolType,
			remoteId,
			projectPath,
		});
	}
	return agents;
}

/** Resolve `promise`, or undefined once `ms` passes. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface CollectRemoteBreakdownsOptions {
	timeoutMs?: number;
	/** One remote finished (answered, failed, or timed out). */
	onRemoteDone?(): void;
	/** A request threw: a bug, not a down host. The remote's agents are still left "not counted". */
	onError?(error: unknown): void;
}

/**
 * Ask every remote once, in parallel, for the usage of its agents' projects, and merge what they
 * answer. A conversation two agents share (the same project) is counted once.
 */
export async function collectRemoteBreakdowns(
	agents: readonly RemoteTokenAgent[],
	request: RemoteTokenUsageRequest,
	options: CollectRemoteBreakdownsOptions = {}
): Promise<RemoteBreakdowns> {
	const timeoutMs = options.timeoutMs ?? REMOTE_TOKEN_USAGE_TIMEOUT_MS;
	const byRemote = new Map<string, RemoteTokenAgent[]>();
	const pairs = new Set<string>();
	for (const agent of agents) {
		pairs.add(remoteProjectPairKey(agent.provider, agent.projectPath));
		const list = byRemote.get(agent.remoteId);
		if (list) list.push(agent);
		else byRemote.set(agent.remoteId, [agent]);
	}

	const answers = await Promise.all(
		[...byRemote].map(async ([remoteId, remoteAgents]) => {
			const projects = uniqueProjects(
				remoteAgents.map((agent) => ({ provider: agent.provider, projectPath: agent.projectPath }))
			);
			let usage: ProjectTokenUsage | undefined;
			try {
				usage = await withTimeout(request(remoteId, projects, timeoutMs), timeoutMs);
			} catch (error) {
				options.onError?.(error);
				usage = undefined;
			}
			options.onRemoteDone?.();
			return { remoteId, remoteAgents, usage };
		})
	);

	const breakdowns: SessionTokenBreakdown[] = [];
	const counted = new Set<string>();
	for (const { remoteId, remoteAgents, usage } of answers) {
		if (!usage) continue;
		const unsupported = new Set(usage.unsupportedProviders);
		for (const agent of remoteAgents) {
			if (!unsupported.has(agent.provider)) counted.add(agent.id);
		}
		const seen = new Set<string>();
		for (const breakdown of usage.breakdowns) {
			const key = `${remoteId}\u0000${breakdown.agentType}\u0000${breakdown.accountKey}\u0000${breakdown.projectPath}\u0000${breakdown.sessionId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			breakdowns.push(breakdown);
		}
	}

	return {
		breakdowns,
		notCounted: agents.filter((agent) => !counted.has(agent.id)),
		pairs,
	};
}
