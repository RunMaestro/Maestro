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
import { REMOTE_TOKEN_USAGE_TIMEOUT_MS, chunkProjects } from '../../../shared/projectTokenUsage';

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
	/**
	 * Counted agents whose host left conversations out (too large or unreadable), with how many: their
	 * totals are short by those and are named, never quietly short.
	 */
	partial: Array<{ agent: RemoteTokenAgent; skippedFiles: number }>;
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

/** Whether folder `a` should keep a shared conversation over folder `b`: deeper, then by name. */
function deeperFolder(a: string, b: string): boolean {
	return a.length !== b.length ? a.length > b.length : a > b;
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
 * Ask every remote, in parallel, for the usage of its agents' projects (once, or in chunks the
 * host accepts), and merge what they answer. A conversation two agents share (the same project)
 * is counted once.
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

	// A host reads at most MAX_PROJECT_TOKEN_USAGE_PROJECTS per request, so a remote with more
	// projects is asked in chunks (`chunkProjects`); each chunk stands or falls on its own.
	const asks = [...byRemote].flatMap(([remoteId, remoteAgents]) =>
		chunkProjects(
			remoteAgents.map((agent) => ({ provider: agent.provider, projectPath: agent.projectPath }))
		).map((chunk) => ({ remoteId, chunk }))
	);
	// A remote is done once every one of its chunks settles, whichever finishes last.
	const outstanding = new Map<string, number>();
	for (const { remoteId } of asks) outstanding.set(remoteId, (outstanding.get(remoteId) ?? 0) + 1);
	const answers = await Promise.all(
		asks.map(async ({ remoteId, chunk }) => {
			let usage: ProjectTokenUsage | undefined;
			try {
				usage = await withTimeout(request(remoteId, chunk, timeoutMs), timeoutMs);
			} catch (error) {
				options.onError?.(error);
				usage = undefined;
			}
			const left = (outstanding.get(remoteId) ?? 1) - 1;
			outstanding.set(remoteId, left);
			if (left === 0) options.onRemoteDone?.();
			return { remoteId, chunk, usage };
		})
	);

	// Only a project its host read whole counts, and only its numbers are merged: a project that
	// failed, was cut short, or held a record that did not check out leaves its agent named, so
	// "Not counted" is exactly true and a total is never quietly short.
	const breakdowns: SessionTokenBreakdown[] = [];
	/** `remoteId NUL provider NUL projectPath` of every project its host read whole. */
	const countedProjects = new Set<string>();
	/** Skipped transcripts per counted project, under the same key. */
	const skippedByProject = new Map<string, number>();
	/**
	 * One conversation per host identity. A host answers a conversation under every folder asked
	 * that holds it (a parent and a child folder both hold a rollout of the child), each copy under
	 * the folder asked, so the copies differ only in `projectPath`. The copy kept is the one under
	 * the deepest folder, whatever order the folders were asked in.
	 */
	const kept = new Map<string, SessionTokenBreakdown>();
	for (const { remoteId, chunk, usage } of answers) {
		if (!usage) continue;
		chunk.forEach((project, index) => {
			const result = usage.projects[index];
			if (!result?.complete) return;
			const projectId = `${remoteId}\u0000${project.provider}\u0000${project.projectPath}`;
			countedProjects.add(projectId);
			if (result.skippedFiles) skippedByProject.set(projectId, result.skippedFiles);
			for (const breakdown of result.breakdowns) {
				const key = `${remoteId}\u0000${breakdown.agentType}\u0000${breakdown.accountKey}\u0000${breakdown.sessionId}`;
				const previous = kept.get(key);
				if (!previous || deeperFolder(breakdown.projectPath, previous.projectPath)) {
					kept.set(key, breakdown);
				}
			}
		});
	}
	breakdowns.push(...kept.values());
	const projectIdOf = (agent: RemoteTokenAgent): string =>
		`${agent.remoteId}\u0000${agent.provider}\u0000${agent.projectPath}`;
	const counted = new Set(
		agents.filter((agent) => countedProjects.has(projectIdOf(agent))).map((agent) => agent.id)
	);

	return {
		breakdowns,
		notCounted: agents.filter((agent) => !counted.has(agent.id)),
		pairs,
		partial: agents
			.filter((agent) => counted.has(agent.id) && skippedByProject.has(projectIdOf(agent)))
			.map((agent) => ({ agent, skippedFiles: skippedByProject.get(projectIdOf(agent)) ?? 0 })),
	};
}
