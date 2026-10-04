import {
	agentsOf,
	buildAgentTree,
	groupsOf,
	readMaestroStores,
	type AgentRecord,
	type AgentTreeSection,
	type MaestroPaths,
	type StoreReadResult,
} from '../../shared/maestro-lib';

export interface AgentData {
	agents: AgentRecord[];
	sections: AgentTreeSection[];
	/** One line per store file that could not be read; empty when all is well. */
	problems: string[];
}

function describeProblem(label: string, result: StoreReadResult<unknown>): string | undefined {
	if (result.status === 'corrupt') return `${label} is corrupt: ${result.reason}`;
	if (result.status === 'unreadable') return `${label} is unreadable: ${result.reason}`;
	return undefined;
}

/**
 * Reads the sessions and groups files and derives the agent tree. A missing
 * file is normal before the desktop's first run and reads as "no agents"; a
 * corrupt or unreadable one is reported, and the other file is still used.
 * Read-only: the files are never touched.
 */
export function loadAgentData(
	paths: Pick<MaestroPaths, 'sessionsFile' | 'groupsFile' | 'settingsFile' | 'agentConfigsFile'>
): AgentData {
	const stores = readMaestroStores(paths);
	const agents = stores.sessions.status === 'ok' ? agentsOf(stores.sessions.data) : [];
	const groups = stores.groups.status === 'ok' ? groupsOf(stores.groups.data) : [];
	const problems = [
		describeProblem('Sessions file', stores.sessions),
		describeProblem('Groups file', stores.groups),
	].filter((problem): problem is string => problem !== undefined);
	return { agents, sections: buildAgentTree(agents, groups), problems };
}
