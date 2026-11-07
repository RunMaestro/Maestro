// List agents command
// Lists all agents/sessions from Maestro storage, and, with Federation on, the agents a peer's
// host owns (`--peer <name>`, `--all-peers`). Peer agents are read from the host every time and
// never written to the local store.

import {
	liftedAgentRef,
	readLiftedTo,
	type LiftedToPointer,
} from '../../shared/maestro-lib/agents/lift-pointer';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import type { SessionInfo } from '../../shared/types';
import { ExitCode } from '../exit-codes';
import {
	readLiveSessions,
	readGroups,
	getSessionsByGroup,
	resolveGroupId,
} from '../services/storage';
import {
	PeerResolveError,
	connectPeer,
	listFederationPeers,
	listHostAgents,
} from '../services/peer-resolver';
import { formatAgents, formatError, AgentDisplay } from '../output/formatter';
import { requireEncore } from '../utils/encore-gate';

interface ListAgentsOptions {
	group?: string;
	json?: boolean;
	/** Federation: list the agents on this one peer (an SSH remote name or id). */
	peer?: string;
	/** Federation: list local agents, then every opted-in peer's, one peer at a time. */
	allPeers?: boolean;
}

/** One `list agents --json` row. `peer` is present only when a peer flag was passed. */
interface AgentJsonRow {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	groupId?: string;
	autoRunFolderPath?: string;
	worktreeBasePath: string | null;
	bookmarked: boolean;
	sessionSshRemoteConfig: unknown;
	/** Where a lifted local agent runs now (`peer`, `agentId`, `at`); null when it was not lifted. */
	liftedTo: LiftedToPointer | null;
	/** The peer whose host owns the agent; null for a local agent in an `--all-peers` list. */
	peer?: string | null;
}

/** A local agent as a JSON row. */
function localJsonRow(s: SessionInfo): AgentJsonRow {
	return {
		id: s.id,
		name: s.name,
		toolType: s.toolType,
		cwd: s.cwd,
		groupId: s.groupId,
		autoRunFolderPath: s.autoRunFolderPath,
		// Where this agent's worktrees go, so a caller can honor it instead of
		// inventing a location the desktop never sees. Null when unset.
		worktreeBasePath: s.worktreeConfig?.basePath ?? null,
		bookmarked: !!s.bookmarked,
		sessionSshRemoteConfig: s.sessionSshRemoteConfig ?? null,
		liftedTo: readLiftedTo(s.liftedTo) ?? null,
	};
}

/** A host's agent as a JSON row, in the same shape as a local one. */
function hostJsonRow(record: AgentRecord, peer: string): AgentJsonRow {
	const worktree = record.worktreeConfig as { basePath?: string } | undefined;
	return {
		id: record.id,
		name: record.name,
		toolType: record.toolType,
		cwd: record.cwd ?? '',
		groupId: record.groupId,
		autoRunFolderPath: record.autoRunFolderPath,
		worktreeBasePath: worktree?.basePath ?? null,
		bookmarked: !!record.bookmarked,
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
		autoRunFolderPath: row.autoRunFolderPath,
		bookmarked: row.bookmarked,
		...(row.peer ? { peer: row.peer } : {}),
		...(row.liftedTo ? { liftedTo: liftedAgentRef(row) } : {}),
	};
}

export function listAgents(options: ListAgentsOptions): void | Promise<void> {
	if (options.peer !== undefined || options.allPeers) return listAgentsWithPeers(options);
	try {
		let sessions;
		let groupName: string | undefined;

		if (options.group) {
			// Resolve partial group ID
			const groupId = resolveGroupId(options.group);
			sessions = getSessionsByGroup(groupId);
			// Get the group name for display
			const groups = readGroups();
			const group = groups.find((g) => g.id === groupId);
			groupName = group?.name;
		} else {
			sessions = readLiveSessions();
		}

		if (options.json) {
			// JSON array output. Include sessionSshRemoteConfig so SSH execution
			// state is verifiable without reading raw store files.
			const output = sessions.map(localJsonRow);
			console.log(JSON.stringify(output, null, 2));
		} else {
			// Human-readable output
			const displayAgents: AgentDisplay[] = sessions.map((s) => displayRow(localJsonRow(s)));
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
		return {
			peer: connection.peer,
			rows: agents.map((record) => hostJsonRow(record, connection.peer)),
		};
	} finally {
		await connection.release();
	}
}

function printRows(rows: AgentJsonRow[], options: ListAgentsOptions, peer?: string): void {
	if (options.json) {
		console.log(JSON.stringify(rows, null, 2));
	} else {
		console.log(formatAgents(rows.map(displayRow), undefined, { peer }));
	}
}

async function listAgentsWithPeers(options: ListAgentsOptions): Promise<void> {
	// The peer flags belong to the Federation Encore Feature: refused while it is off.
	requireEncore('federation', options.json);
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
		rows = readLiveSessions().map((s) => ({ ...localJsonRow(s), peer: null }));
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
