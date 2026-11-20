// List agents command
// Lists all agents/sessions from Maestro storage, and, with Federation on, the agents a peer's
// host owns (`--peer <name>`, `--all-peers`). Peer agents are read from the host every time and
// never written to the local store.
//
// The list is a DISCOVERY surface: each row says what the agent is for (`peerDescription`), its
// group, and whether that group is hidden. `--reachable` narrows it to the agents the caller may
// reach right now, resolved live by `resolvePeerRoster()`, the resolver the prompt's Peer Agents
// table and the Delegation Graph read. Listing an agent never grants access to it.

import { readCallerIdentity } from '../../shared/agentDelegation';
import { collectHiddenGroupIds, type HiddenGroupInput } from '../../shared/hiddenGroups';
import {
	liftedAgentRef,
	readLiftedTo,
	type LiftedToPointer,
} from '../../shared/maestro-lib/agents/lift-pointer';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { peerAccessLabel, resolvePeerRoster, type ResolvedPeer } from '../../shared/peerAgents';
import type { SessionInfo } from '../../shared/types';
import { ExitCode } from '../exit-codes';
import {
	readLiveSessions,
	readGroups,
	getSessionsByGroup,
	resolveAgentId,
	resolveGroupId,
} from '../services/storage';
import {
	PeerResolveError,
	connectPeer,
	listFederationPeers,
	listHostAgents,
} from '../services/peer-resolver';
import { formatAgents, formatError, AgentDisplay } from '../output/formatter';
import { failCommand } from '../services/session-command';

interface ListAgentsOptions {
	group?: string;
	json?: boolean;
	/** Federation: list the agents on this one peer (an SSH remote name or id). */
	peer?: string;
	/** Federation: list local agents, then every opted-in peer's, one peer at a time. */
	allPeers?: boolean;
	/** Text output: print each agent's `peerDescription` under it. JSON always carries it. */
	descriptions?: boolean;
	/** Leave out agents whose group is hidden (or sits under a hidden parent). */
	visibleOnly?: boolean;
	/** Keep only the agents the caller may reach, each with its access. Local agents only. */
	reachable?: boolean;
	/** The caller `--reachable` resolves for; defaults to `MAESTRO_CALLER_AGENT_ID`. */
	from?: string;
}

/** What the caller may do with a row's agent. Present only under `--reachable`. */
interface AgentAccess {
	read: boolean;
	write: boolean;
	/** `peerAccessLabel`: "Consult only", "Delegate only", "Consult + Delegate". */
	label: string;
	/** Which grant gave it: an explicit row, the group grant, or the worktree family grant. */
	source: ResolvedPeer['source'];
	/** The caller's own note on this peer (its explicit row), or null. */
	note: string | null;
}

/** One `list agents --json` row. `peer` is present only when a peer flag was passed. */
interface AgentJsonRow {
	id: string;
	name: string;
	toolType: string;
	cwd: string;
	groupId?: string;
	/** The group's name; null when the agent has no group or the group is gone. */
	groupName: string | null;
	/** True when the group is hidden, or sits under a hidden parent. Hiding never blocks access. */
	groupHidden: boolean;
	/** What the agent is for, as its owner wrote it for peers; null when unset. */
	peerDescription: string | null;
	autoRunFolderPath?: string;
	worktreeBasePath: string | null;
	bookmarked: boolean;
	sessionSshRemoteConfig: unknown;
	/** Where a lifted local agent runs now (`peer`, `agentId`, `at`); null when it was not lifted. */
	liftedTo: LiftedToPointer | null;
	/** The peer whose host owns the agent; null for a local agent in an `--all-peers` list. */
	peer?: string | null;
	access?: AgentAccess;
}

/** Group names and the hidden set of one store (local, or one peer's host). */
interface GroupLabels {
	names: ReadonlyMap<string, string>;
	hidden: ReadonlySet<string>;
}

const NO_GROUP_LABELS: GroupLabels = { names: new Map(), hidden: new Set() };

function groupLabels(groups: ReadonlyArray<HiddenGroupInput & { name: string }>): GroupLabels {
	return {
		names: new Map(groups.map((g) => [g.id, g.name])),
		hidden: collectHiddenGroupIds(groups),
	};
}

/** The group fields of a row. */
function groupFields(
	groupId: string | undefined,
	labels: GroupLabels
): Pick<AgentJsonRow, 'groupName' | 'groupHidden'> {
	return {
		groupName: (groupId && labels.names.get(groupId)) || null,
		groupHidden: !!groupId && labels.hidden.has(groupId),
	};
}

/** A stored description, trimmed; null when unset or blank. */
function readPeerDescription(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A local agent as a JSON row. */
function localJsonRow(s: SessionInfo, labels: GroupLabels): AgentJsonRow {
	return {
		id: s.id,
		name: s.name,
		toolType: s.toolType,
		cwd: s.cwd,
		groupId: s.groupId,
		...groupFields(s.groupId, labels),
		peerDescription: readPeerDescription(s.peerDescription),
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
function hostJsonRow(record: AgentRecord, peer: string, labels: GroupLabels): AgentJsonRow {
	const worktree = record.worktreeConfig as { basePath?: string } | undefined;
	return {
		id: record.id,
		name: record.name,
		toolType: record.toolType,
		cwd: record.cwd ?? '',
		groupId: record.groupId,
		...groupFields(record.groupId, labels),
		peerDescription: readPeerDescription(record.peerDescription),
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
		...(row.groupName ? { groupName: row.groupName } : {}),
		...(row.groupHidden ? { groupHidden: true } : {}),
		...(row.peerDescription ? { peerDescription: row.peerDescription } : {}),
		...(row.access ? { access: row.access.label } : {}),
		...(row.peer ? { peer: row.peer } : {}),
		...(row.liftedTo ? { liftedTo: liftedAgentRef(row) } : {}),
	};
}

/** `--visible-only`: drop the rows whose group is hidden. */
function applyVisibility(rows: AgentJsonRow[], options: ListAgentsOptions): AgentJsonRow[] {
	return options.visibleOnly ? rows.filter((row) => !row.groupHidden) : rows;
}

/** A usage error, reported in the caller's format, then exit. */
function usageError(message: string, json?: boolean): never {
	reportFailure({ message, exitCode: ExitCode.InvalidUsage }, json);
	process.exit(ExitCode.InvalidUsage);
}

/**
 * `--reachable`: keep the rows the caller may reach, each with its access. The roster is
 * resolved from the live agent list now, not read from a prompt snapshot, so a grant changed
 * mid-turn shows at once.
 */
function applyReachable(
	rows: AgentJsonRow[],
	live: readonly SessionInfo[],
	callerId: string
): AgentJsonRow[] {
	const caller = live.find((s) => s.id === callerId);
	if (!caller) return [];
	const roster = new Map(resolvePeerRoster(caller, live).map((peer) => [peer.sessionId, peer]));
	return rows.flatMap((row) => {
		const peer = roster.get(row.id);
		if (!peer) return [];
		const access: AgentAccess = {
			read: peer.read,
			write: peer.write,
			label: peerAccessLabel(peer),
			source: peer.source,
			note: peer.description ?? null,
		};
		return [{ ...row, access }];
	});
}

/** The agent `--reachable` resolves for: `--from`, else the shell's own agent. */
function resolveReachableCaller(options: ListAgentsOptions): string {
	if (options.from !== undefined) {
		try {
			return resolveAgentId(options.from);
		} catch (error) {
			usageError(`--from: ${error instanceof Error ? error.message : String(error)}`, options.json);
		}
	}
	const callerId = readCallerIdentity(process.env)?.agentId;
	if (!callerId) {
		usageError(
			'--reachable needs a caller: pass --from <agent>, or run it from an agent shell (MAESTRO_CALLER_AGENT_ID).',
			options.json
		);
	}
	return callerId;
}

export function listAgents(options: ListAgentsOptions): void | Promise<void> {
	if (options.from !== undefined && !options.reachable) {
		usageError('--from names the caller for --reachable; pass --reachable too.', options.json);
	}
	if (options.peer !== undefined || options.allPeers) return listAgentsWithPeers(options);
	const callerId = options.reachable ? resolveReachableCaller(options) : undefined;
	try {
		let sessions;
		let groupName: string | undefined;
		const groups = readGroups();

		if (options.group) {
			// Resolve partial group ID
			const groupId = resolveGroupId(options.group);
			sessions = getSessionsByGroup(groupId);
			// Get the group name for display
			groupName = groups.find((g) => g.id === groupId)?.name;
		} else {
			sessions = readLiveSessions();
		}

		const labels = groupLabels(groups);
		let rows = applyVisibility(
			sessions.map((s) => localJsonRow(s, labels)),
			options
		);
		let reachableFrom: string | undefined;
		if (callerId) {
			const live = options.group ? readLiveSessions() : sessions;
			rows = applyReachable(rows, live, callerId);
			reachableFrom = live.find((s) => s.id === callerId)?.name ?? callerId;
		}

		if (options.json) {
			// JSON array output. Include sessionSshRemoteConfig so SSH execution
			// state is verifiable without reading raw store files.
			console.log(JSON.stringify(rows, null, 2));
		} else {
			// Human-readable output
			const displayAgents: AgentDisplay[] = rows.map(displayRow);
			console.log(
				formatAgents(displayAgents, groupName, {
					descriptions: options.descriptions,
					reachableFrom,
				})
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		failCommand(`Failed to list agents: ${message}`, options.json);
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
		// Group names are labels only: a host that cannot list its groups still lists its agents.
		const groups = await connection.client.groups.list();
		const labels = groups.ok
			? groupLabels(
					groups.value.map((g) => ({
						id: g.id,
						name: g.name,
						parentGroupId: g.parentGroupId,
						hidden: g.hidden === true,
					}))
				)
			: NO_GROUP_LABELS;
		return {
			peer: connection.peer,
			rows: agents.map((record) => hostJsonRow(record, connection.peer, labels)),
		};
	} finally {
		await connection.release();
	}
}

function printRows(rows: AgentJsonRow[], options: ListAgentsOptions, peer?: string): void {
	const shown = applyVisibility(rows, options);
	if (options.json) {
		console.log(JSON.stringify(shown, null, 2));
	} else {
		console.log(
			formatAgents(shown.map(displayRow), undefined, { peer, descriptions: options.descriptions })
		);
	}
}

async function listAgentsWithPeers(options: ListAgentsOptions): Promise<void> {
	if (options.peer !== undefined && options.allPeers) {
		usageError('Pass --peer <name> or --all-peers, not both.', options.json);
	}
	if (options.group) {
		usageError(
			'--group filters local agents and cannot be combined with --peer or --all-peers.',
			options.json
		);
	}
	if (options.reachable) {
		// Peer grants name local agents; a peer's host resolves its own agents' grants.
		usageError(
			'--reachable lists the local agents the caller may reach and cannot be combined with --peer or --all-peers.',
			options.json
		);
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
		const labels = groupLabels(readGroups());
		rows = readLiveSessions().map((s) => ({ ...localJsonRow(s, labels), peer: null }));
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
