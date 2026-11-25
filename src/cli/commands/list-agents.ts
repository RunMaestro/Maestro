// List agents command
// Lists all agents/sessions from Maestro storage, and, with Federation on, the agents a peer's
// host owns (`--peer <name>`, `--all-peers`). Peer agents are read from the host every time and
// never written to the local store.

import {
	liftedAgentRef,
	readLiftedTo,
	type LiftedToPointer,
} from '../../shared/maestro-lib/agents/lift-pointer';
import { agentGroupLookup, type AgentGroupInfo } from '../../shared/groupHierarchy';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { SessionInfo } from '../../shared/types';
import { ExitCode } from '../exit-codes';
import {
	readLiveSessions,
	readGroups,
	getSessionsByGroup,
	readPrimaryAgentId,
	resolveGroupId,
} from '../services/storage';
import {
	PeerResolveError,
	connectPeer,
	listFederationPeers,
	listHostAgents,
} from '../services/peer-resolver';
import { formatAgents, formatError, AgentDisplay } from '../output/formatter';

interface ListAgentsOptions {
	group?: string;
	json?: boolean;
	/** Federation: list the agents on this one peer (an SSH remote name or id). */
	peer?: string;
	/** Federation: list local agents, then every opted-in peer's, one peer at a time. */
	allPeers?: boolean;
	/** Only agents whose group is NOT hidden (ungrouped agents count as visible). */
	visibleOnly?: boolean;
	/** Only agents in a hidden group (or under a hidden parent group). */
	hiddenOnly?: boolean;
}

type GroupLookup = (groupId: string | undefined) => AgentGroupInfo;

/** One `list agents --json` row. `peer` is present only when a peer flag was passed. */
interface AgentJsonRow {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	groupId?: string;
	/** The group's name; null when the agent has no group (or the peer could not list groups). */
	groupName: string | null;
	/**
	 * True when the agent's group, or that group's parent, is hidden from the Left Bar. Null only
	 * on a peer's agent whose host could not list its groups.
	 */
	groupHidden: boolean | null;
	autoRunFolderPath?: string;
	worktreeBasePath: string | null;
	bookmarked: boolean;
	/** Whether this is the Primary Agent (Settings > General). Always false for a peer's agent. */
	primary: boolean;
	sessionSshRemoteConfig: unknown;
	/** Where a lifted local agent runs now (`peer`, `agentId`, `at`); null when it was not lifted. */
	liftedTo: LiftedToPointer | null;
	/** The peer whose host owns the agent; null for a local agent in an `--all-peers` list. */
	peer?: string | null;
}

/** A local agent as a JSON row. */
function localJsonRow(
	s: SessionInfo,
	groupOf: GroupLookup,
	primaryAgentId: string | null
): AgentJsonRow {
	return {
		id: s.id,
		name: s.name,
		toolType: s.toolType,
		cwd: s.cwd,
		groupId: s.groupId,
		...groupOf(s.groupId),
		autoRunFolderPath: s.autoRunFolderPath,
		// Where this agent's worktrees go, so a caller can honor it instead of
		// inventing a location the desktop never sees. Null when unset.
		worktreeBasePath: s.worktreeConfig?.basePath ?? null,
		bookmarked: !!s.bookmarked,
		primary: s.id === primaryAgentId,
		sessionSshRemoteConfig: s.sessionSshRemoteConfig ?? null,
		liftedTo: readLiftedTo(s.liftedTo) ?? null,
	};
}

/** A host's agent as a JSON row, in the same shape as a local one. */
function hostJsonRow(record: AgentRecord, peer: string, groupOf: GroupLookup | null): AgentJsonRow {
	const worktree = record.worktreeConfig as { basePath?: string } | undefined;
	return {
		id: record.id,
		name: record.name,
		toolType: record.toolType,
		cwd: record.cwd ?? '',
		groupId: record.groupId,
		...(groupOf ? groupOf(record.groupId) : { groupName: null, groupHidden: null }),
		autoRunFolderPath: record.autoRunFolderPath,
		worktreeBasePath: worktree?.basePath ?? null,
		bookmarked: !!record.bookmarked,
		// The Primary Agent is a setting of THIS machine; a peer's agent is never it.
		primary: false,
		sessionSshRemoteConfig: record.sessionSshRemoteConfig ?? null,
		liftedTo: readLiftedTo(record.liftedTo) ?? null,
		peer,
	};
}

function displayRow(row: AgentJsonRow): AgentDisplay {
	return {
		id: row.id,
		name: row.name,
		toolType: row.toolType,
		cwd: row.cwd,
		groupId: row.groupId,
		...(row.groupName ? { groupName: row.groupName } : {}),
		...(row.groupHidden ? { groupHidden: true } : {}),
		autoRunFolderPath: row.autoRunFolderPath,
		bookmarked: row.bookmarked,
		primary: row.primary,
		...(row.peer ? { peer: row.peer } : {}),
		...(row.liftedTo ? { liftedTo: liftedAgentRef(row) } : {}),
	};
}

/**
 * Apply `--visible-only` / `--hidden-only`. A row whose hidden state is unknown (a peer that could
 * not list its groups) passes neither filter: a caller asking for visible agents only is asking
 * NOT to touch what the user put away, so an unknown is left out.
 */
function filterByGroupVisibility(rows: AgentJsonRow[], options: ListAgentsOptions): AgentJsonRow[] {
	if (options.visibleOnly) return rows.filter((row) => row.groupHidden === false);
	if (options.hiddenOnly) return rows.filter((row) => row.groupHidden === true);
	return rows;
}

export function listAgents(options: ListAgentsOptions): void | Promise<void> {
	if (options.visibleOnly && options.hiddenOnly) {
		const message = 'Pass --visible-only or --hidden-only, not both.';
		if (options.json) console.error(JSON.stringify({ error: message }));
		else console.error(formatError(message));
		process.exit(ExitCode.InvalidUsage);
	}
	if (options.peer !== undefined || options.allPeers) return listAgentsWithPeers(options);
	try {
		let sessions;
		let groupName: string | undefined;
		const groups = readGroups();
		const groupOf = agentGroupLookup(groups);

		if (options.group) {
			// Resolve partial group ID
			const groupId = resolveGroupId(options.group);
			sessions = getSessionsByGroup(groupId);
			// Get the group name for display
			groupName = groupOf(groupId).groupName ?? undefined;
		} else {
			sessions = readLiveSessions();
		}

		const primaryAgentId = readPrimaryAgentId();
		const rows = filterByGroupVisibility(
			sessions.map((s) => localJsonRow(s, groupOf, primaryAgentId)),
			options
		);
		if (options.json) {
			// JSON array output. Include sessionSshRemoteConfig so SSH execution
			// state is verifiable without reading raw store files.
			console.log(JSON.stringify(rows, null, 2));
		} else {
			// Human-readable output
			const displayAgents: AgentDisplay[] = rows.map(displayRow);
			console.log(formatAgents(displayAgents, groupName));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to list agents: ${message}`));
		}
		process.exit(1);
	}
}

/** A peer that could not be listed, kept so `--all-peers` can finish the others first. */
interface PeerFailure {
	peer?: string;
	code?: string;
	message: string;
	exitCode: ExitCode;
}

function toFailure(error: unknown, peer?: string): PeerFailure {
	if (error instanceof PeerResolveError) {
		return {
			peer: error.peer ?? peer,
			code: error.code,
			message: error.message,
			exitCode: error.exitCode,
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		peer,
		message: peer ? `Could not list the agents on peer "${peer}": ${message}` : message,
		exitCode: ExitCode.GeneralError,
	};
}

function reportFailure(failure: PeerFailure, json?: boolean): void {
	if (json) {
		console.error(
			JSON.stringify({
				error: failure.message,
				...(failure.peer ? { peer: failure.peer } : {}),
				...(failure.code ? { code: failure.code } : {}),
			})
		);
	} else {
		console.error(formatError(failure.message));
	}
}

/** Open the peer, read its agents, and always drop the connection. */
async function readPeerRows(peerRef: string): Promise<{ peer: string; rows: AgentJsonRow[] }> {
	const connection = await connectPeer(peerRef);
	try {
		const agents = await listHostAgents(connection);
		// Group names and hidden state are labels: a host that cannot list its groups still lists
		// its agents, with `groupName` and `groupHidden` null.
		const groups = await connection.client.groups.list();
		const groupOf = groups.ok ? agentGroupLookup(groups.value) : null;
		return {
			peer: connection.peer,
			rows: agents.map((record) => hostJsonRow(record, connection.peer, groupOf)),
		};
	} finally {
		await connection.release();
	}
}

function printRows(allRows: AgentJsonRow[], options: ListAgentsOptions, peer?: string): void {
	const rows = filterByGroupVisibility(allRows, options);
	if (options.json) {
		console.log(JSON.stringify(rows, null, 2));
	} else {
		console.log(formatAgents(rows.map(displayRow), undefined, { peer }));
	}
}

async function listAgentsWithPeers(options: ListAgentsOptions): Promise<void> {
	if (options.peer !== undefined && options.allPeers) {
		reportFailure(
			{ message: 'Pass --peer <name> or --all-peers, not both.', exitCode: ExitCode.InvalidUsage },
			options.json
		);
		process.exit(ExitCode.InvalidUsage);
	}
	if (options.group) {
		reportFailure(
			{
				message: '--group filters local agents and cannot be combined with --peer or --all-peers.',
				exitCode: ExitCode.InvalidUsage,
			},
			options.json
		);
		process.exit(ExitCode.InvalidUsage);
	}

	if (options.peer !== undefined) {
		let listed: { peer: string; rows: AgentJsonRow[] };
		try {
			listed = await readPeerRows(options.peer);
		} catch (error) {
			const failure = toFailure(error, options.peer);
			reportFailure(failure, options.json);
			process.exit(failure.exitCode);
		}
		printRows(listed.rows, options, listed.peer);
		return;
	}

	// --all-peers: local agents first, then each opted-in peer. One peer at a time, never side by
	// side: a tailcat remote fails under concurrent SSH dials. A peer that cannot be reached does
	// not hide the others; it is reported after the list, and the exit code is its exit code.
	let rows: AgentJsonRow[];
	try {
		const groupOf = agentGroupLookup(readGroups());
		const primaryAgentId = readPrimaryAgentId();
		rows = readLiveSessions().map((s) => ({
			...localJsonRow(s, groupOf, primaryAgentId),
			peer: null,
		}));
	} catch (error) {
		const failure = toFailure(error);
		reportFailure(
			{ ...failure, message: `Failed to list agents: ${failure.message}` },
			options.json
		);
		process.exit(ExitCode.GeneralError);
	}
	const failures: PeerFailure[] = [];
	for (const { peer } of listFederationPeers()) {
		try {
			rows.push(...(await readPeerRows(peer)).rows);
		} catch (error) {
			failures.push(toFailure(error, peer));
		}
	}
	printRows(rows, options);
	for (const failure of failures) reportFailure(failure, options.json);
	if (failures.length > 0) process.exit(failures[0].exitCode);
}
