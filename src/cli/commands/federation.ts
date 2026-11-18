// `maestro-cli federation` - the Federation peers the desktop mirrors in its Left Bar
// (FED-SSH-05).
//
// `peers` lists each peer with its connection state and agent count; `reconnect <peer>` forces the
// same reload the Left Bar's Reconnect runs. Both send `federation_command` over the WS bridge to
// the desktop's one `PeerMirrorService`, so they report what the desktop shows. Neither dials SSH
// from this process: the desktop holds the forwards (`remote-host status` is the direct probe).
//
// `auto` prints what automatic Federation did, waits on, or could not do (with the fix), and
// `auto run` runs a pass now, the same as Run Now in Settings > SSH Hosts.
//
// `agents` lists every agent the peers' hosts run and which ones the Left Bar shows; `add
// <peer:agent>` adds one to the Left Bar, the same as the Add Hosted Agent modal. A host's agents
// stay out of the Left Bar until someone adds them.
//
// A headless host (`maestro-cli host`) mirrors no peers, so it does not serve this message.

import {
	FEDERATION_COMMAND,
	FEDERATION_COMMAND_RESULT,
	type FederationCommandAction,
	type FederationCommandRequest,
	type FederationCommandResult,
	type HostedAgentListing,
	type HostedSettingsConflictSummary,
} from '../../shared/federationCommands';
import type {
	MirrorPeerSummary,
	PeerMirrorConnection,
} from '../../shared/maestro-lib/client/peer-mirror';
import { formatRelativeTime } from '../../shared/formatters';
import type { AutoFederationSnapshot } from '../../shared/federationAuto';
import { colorize, formatSuccess } from '../output/formatter';
import { withMaestroClient } from '../services/maestro-client';
import { diskFallbackPeer, failCommand, failFromError } from '../services/session-command';

export interface FederationOptions {
	json?: boolean;
}

/** What a headless host answers: it serves its own agents, it mirrors no peers. */
export const FEDERATION_HEADLESS_MESSAGE =
	'The Federation peer mirror lives in the desktop app; the headless host (`maestro-cli host`) mirrors no peers. ' +
	'Run this while the desktop app is open, or probe a remote directly with `maestro-cli remote-host status <ssh-remote>`.';

/** A reload dials SSH and re-reads the host's agent list, one peer after another. */
export const FEDERATION_RECONNECT_TIMEOUT_MS = 120_000;

type FederationCommandExtra = Partial<
	Pick<
		FederationCommandRequest,
		'peer' | 'agent' | 'field' | 'take' | 'value' | 'group' | 'background'
	>
>;

async function sendFederationCommand(
	action: FederationCommandAction,
	extra: FederationCommandExtra = {},
	timeoutMs?: number
): Promise<FederationCommandResult> {
	return withMaestroClient((client) =>
		client.sendCommand<FederationCommandResult & { type: string }>(
			{ type: FEDERATION_COMMAND, action, ...extra },
			FEDERATION_COMMAND_RESULT,
			timeoutMs
		)
	);
}

async function request(
	action: FederationCommandAction,
	options: FederationOptions,
	extra?: FederationCommandExtra,
	timeoutMs?: number
): Promise<FederationCommandResult> {
	try {
		return await sendFederationCommand(action, extra, timeoutMs);
	} catch (error) {
		if (diskFallbackPeer(error) === 'headless-host') {
			failCommand(FEDERATION_HEADLESS_MESSAGE, options.json);
		}
		failFromError(error, options.json);
	}
}

function connectionLabel(connection: PeerMirrorConnection): string {
	if (connection === 'connected') return colorize('green', connection);
	if (connection === 'connecting' || connection === 'reconnecting') {
		return colorize('yellow', connection);
	}
	return colorize('red', connection);
}

/**
 * Ask the desktop app, when one runs here, to reload `peer` now: after `remote-host install
 * --start` the mirror then shows the new host at once instead of on its next probe. Best effort:
 * with no desktop (or a headless host) it does nothing, and a failure is the desktop's own state.
 */
export async function nudgeDesktopReconnect(peer: string): Promise<boolean> {
	try {
		const reply = await sendFederationCommand(
			'reconnect',
			{ peer },
			FEDERATION_RECONNECT_TIMEOUT_MS
		);
		return reply.success === true;
	} catch {
		return false;
	}
}

/** One line per peer, then its error (with the fix) indented under it. */
export function formatFederationPeers(peers: readonly MirrorPeerSummary[]): string {
	if (peers.length === 0) {
		return 'No peers yet. Every enabled SSH remote is checked for a Maestro host: install one with `maestro-cli remote-host install <ssh-remote> --start`.';
	}
	const lines: string[] = [];
	for (const peer of peers) {
		const agents = `${peer.agentCount} agent${peer.agentCount === 1 ? '' : 's'}`;
		const synced =
			peer.lastSyncAt !== undefined ? `, synced ${formatRelativeTime(peer.lastSyncAt)}` : '';
		const remote = peer.peerId === peer.name ? '' : ` (${peer.name})`;
		lines.push(
			`${colorize('cyan', peer.peerId)}${remote}  ${connectionLabel(peer.connection)}  ${agents}${synced}`
		);
		if (peer.error) {
			for (const line of peer.error.split('\n')) lines.push(`  ${line}`);
		}
	}
	return lines.join('\n');
}

/** `maestro-cli federation peers` */
export async function federationPeers(options: FederationOptions): Promise<void> {
	const reply = await request('peers', options);
	if (!reply.success) failCommand(reply.error || 'Could not read the mirrored peers', options.json);
	const peers = reply.peers ?? [];
	if (options.json) {
		console.log(JSON.stringify({ success: true, peers }, null, 2));
		return;
	}
	console.log(formatFederationPeers(peers));
}

/** `maestro-cli federation reconnect <peer>` */
export async function federationReconnect(peer: string, options: FederationOptions): Promise<void> {
	const reply = await request('reconnect', options, { peer }, FEDERATION_RECONNECT_TIMEOUT_MS);
	if (options.json) {
		// Only the answer: the bridge envelope (`type`, `requestId`, `timestamp`) is wire detail.
		const { success, error, peer: answered } = reply;
		console.log(JSON.stringify({ success, error, peer: answered }, null, 2));
		if (!success) process.exit(1);
		return;
	}
	if (!reply.success) {
		if (reply.peer) console.error(formatFederationPeers([reply.peer]));
		failCommand(reply.error || `Could not reconnect ${peer}`, false);
	}
	console.log(formatSuccess(`Reconnected ${reply.peer?.peerId ?? peer}`));
	if (reply.peer) console.log(formatFederationPeers([reply.peer]));
}

/** A pass of automatic Federation can install a host and move agents: give it time. */
export const FEDERATION_AUTO_RUN_TIMEOUT_MS = 15 * 60_000;

/** The automatic Federation snapshot for a person: each remote and agent, and what needs them. */
export function formatAutoFederation(snapshot: AutoFederationSnapshot): string {
	const lines = [
		`Automatic moves: ${snapshot.autoMove ? colorize('green', 'on') : colorize('yellow', 'off')}${
			snapshot.lastPassAt !== undefined
				? `, last pass ${formatRelativeTime(snapshot.lastPassAt)}`
				: ''
		}${snapshot.running ? ' (a pass is running)' : ''}`,
	];
	const mark = (state: string) =>
		state === 'blocked'
			? colorize('red', 'needs you')
			: state === 'ready' || state === 'moved'
				? colorize('green', state)
				: colorize('yellow', state);
	if (snapshot.remotes.length > 0) lines.push('', 'Remotes:');
	for (const remote of snapshot.remotes) {
		lines.push(
			`  ${colorize('cyan', remote.name)}  ${mark(remote.state)}${remote.reason ? `  ${remote.reason}` : ''}`
		);
		if (remote.service) lines.push(`    Service: ${remote.service}`);
		if (remote.fix) {
			lines.push(`    ${remote.needsYou ? colorize('red', 'To fix:') : 'Note:'} ${remote.fix}`);
		}
	}
	if (snapshot.agents.length > 0) lines.push('', 'SSH agents:');
	for (const agent of snapshot.agents) {
		lines.push(
			`  ${agent.agentName}  ${mark(agent.state)}${agent.reason ? `  ${agent.reason}` : ''}${agent.target ? `  (${agent.target})` : ''}`
		);
		if (agent.fix) lines.push(`    To fix: ${agent.fix}`);
	}
	if (snapshot.remotes.length === 0 && snapshot.agents.length === 0) {
		lines.push('Nothing to do: no SSH remote has run a pass yet.');
	}
	return lines.join('\n');
}

/** Something needs a person: exit 1 so a script notices. */
function needsAttention(snapshot: AutoFederationSnapshot): boolean {
	return (
		snapshot.remotes.some((remote) => remote.state === 'blocked' || remote.needsYou === true) ||
		snapshot.agents.some((agent) => agent.state === 'blocked')
	);
}

async function printAuto(
	action: 'auto-status' | 'auto-run',
	options: FederationOptions
): Promise<void> {
	const reply = await request(
		action,
		options,
		undefined,
		action === 'auto-run' ? FEDERATION_AUTO_RUN_TIMEOUT_MS : undefined
	);
	if (!reply.success || !reply.auto) {
		failCommand(
			reply.error || 'The desktop did not answer with an automatic Federation status',
			options.json
		);
	}
	const snapshot = reply.auto as AutoFederationSnapshot;
	console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatAutoFederation(snapshot));
	if (needsAttention(snapshot)) process.exitCode = 1;
}

/** `maestro-cli federation auto`: what automatic Federation did, waits on, or needs from you. */
export async function federationAuto(options: FederationOptions): Promise<void> {
	await printAuto('auto-status', options);
}

/** `maestro-cli federation auto run`: run a pass now (Run Now in Settings > SSH Hosts). */
export async function federationAutoRun(options: FederationOptions): Promise<void> {
	await printAuto('auto-run', options);
}

// ---------------------------------------------------------------------------
// Settings conflicts of hosted agents
// ---------------------------------------------------------------------------

function shownValue(value: unknown): string {
	if (value === undefined || value === null) return '(not set)';
	if (typeof value === 'boolean') return value ? 'on' : 'off';
	const text = String(value);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** The text `federation conflicts` prints: each hosted agent, its fields, and both values. */
export function formatSettingsConflicts(sets: HostedSettingsConflictSummary[]): string {
	const waiting = sets.filter((set) => set.conflicts.length > 0);
	if (waiting.length === 0) return 'Every hosted agent matches its host.';
	const lines: string[] = [];
	for (const set of waiting) {
		lines.push(`${set.agentName}  (${set.agent})`);
		for (const conflict of set.conflicts) {
			const extras = [conflict.firstSync ? 'first sync' : '', conflict.mergeable ? 'mergeable' : '']
				.filter(Boolean)
				.join(', ');
			lines.push(`  ${conflict.id}: ${conflict.label}${extras ? `  [${extras}]` : ''}`);
			lines.push(`    host:  ${shownValue(conflict.host)}`);
			lines.push(`    local: ${shownValue(conflict.local)}`);
		}
	}
	lines.push('');
	lines.push(
		'Settle one with: maestro-cli federation resolve <peer:agent> <field> --take host|local (or --value <merged text>)'
	);
	return lines.join('\n');
}

function printConflicts(reply: FederationCommandResult, options: FederationOptions): void {
	const sets = reply.conflicts ?? [];
	console.log(options.json ? JSON.stringify(sets, null, 2) : formatSettingsConflicts(sets));
	if (sets.some((set) => set.conflicts.length > 0)) process.exitCode = 1;
}

/**
 * `maestro-cli federation conflicts`: the settings of hosted agents that this machine and the host
 * both changed, the same list the Federation Settings Conflicts modal shows. Exit 1 while any wait.
 */
export async function federationConflicts(options: FederationOptions): Promise<void> {
	const reply = await request('conflicts', options);
	if (!reply.success)
		failCommand(reply.error || 'The desktop did not list the conflicts', options.json);
	printConflicts(reply, options);
}

export interface FederationResolveOptions extends FederationOptions {
	take?: string;
	value?: string;
}

/**
 * `maestro-cli federation resolve <peer:agent> <field>`: settle one conflict the way the modal's
 * buttons do. `--take host` keeps the host's value, `--take local` sends this machine's, and
 * `--value <text>` sends a merged text (free-text fields only).
 */
export async function federationResolve(
	agent: string,
	field: string,
	options: FederationResolveOptions
): Promise<void> {
	const take = options.value !== undefined ? 'value' : options.take;
	if (take !== 'host' && take !== 'local' && take !== 'value') {
		failCommand('Pass --take host, --take local, or --value <merged text>.', options.json);
	}
	const reply = await request('resolve-conflict', options, {
		agent,
		field,
		take,
		...(options.value !== undefined ? { value: options.value } : {}),
	});
	if (!reply.success)
		failCommand(reply.error || 'The desktop did not settle the conflict', options.json);
	if (!options.json)
		console.log(formatSuccess(`Settled ${field} on ${agent}; the host follows shortly.`));
	printConflicts(reply, options);
}

// ---------------------------------------------------------------------------
// Hosted agents in the Left Bar
// ---------------------------------------------------------------------------

export interface FederationAgentsOptions extends FederationOptions {
	/** Only this peer's agents (a peer id). */
	peer?: string;
	/** Only the agents the Left Bar does not show yet. */
	notAdded?: boolean;
}

/** The text `federation agents` prints: per peer, each host agent and whether the Left Bar shows it. */
export function formatHostedAgents(listings: readonly HostedAgentListing[]): string {
	if (listings.length === 0) {
		return 'No host agents. `maestro-cli federation peers` shows which remotes run a Maestro host.';
	}
	const lines: string[] = [];
	let peerId: string | undefined;
	for (const listing of listings) {
		if (listing.peerId !== peerId) {
			peerId = listing.peerId;
			if (lines.length > 0) lines.push('');
			const remote = listing.peerId === listing.peerName ? '' : ` (${listing.peerName})`;
			lines.push(`${colorize('cyan', listing.peerId)}${remote}`);
		}
		const mark = listing.addedAs
			? colorize('green', 'in Left Bar')
			: colorize('yellow', 'not added');
		const group = listing.hostGroupName ? `  [${listing.hostGroupName}]` : '';
		lines.push(`  ${listing.name}  ${listing.ref}  ${mark}${group}`);
	}
	if (listings.some((listing) => !listing.addedAs)) {
		lines.push('');
		lines.push('Add one with: maestro-cli federation add <peer:agent> [--group <group>]');
	}
	return lines.join('\n');
}

/** `maestro-cli federation agents` */
export async function federationAgents(options: FederationAgentsOptions): Promise<void> {
	const reply = await request('hosted-agents', options);
	if (!reply.success)
		failCommand(reply.error || 'The desktop did not list the host agents', options.json);
	const listings = (reply.hostedAgents ?? []).filter(
		(listing) =>
			(!options.peer || listing.peerId === options.peer) && (!options.notAdded || !listing.addedAs)
	);
	console.log(
		options.json
			? JSON.stringify({ success: true, agents: listings }, null, 2)
			: formatHostedAgents(listings)
	);
}

export interface FederationAddOptions extends FederationOptions {
	group?: string;
	background?: boolean;
}

/** `maestro-cli federation add <peer:agent>` */
export async function federationAdd(agent: string, options: FederationAddOptions): Promise<void> {
	const reply = await request('add-agent', options, {
		agent,
		...(options.group ? { group: options.group } : {}),
		...(options.background ? { background: true } : {}),
	});
	if (!reply.success || !reply.added) {
		failCommand(reply.error || `Could not add ${agent}`, options.json);
	}
	const added = reply.added;
	if (options.json) {
		console.log(JSON.stringify({ success: true, agent: added }, null, 2));
		return;
	}
	console.log(formatSuccess(`Added "${added.name}" (${added.ref}) to the Left Bar`));
	console.log(`  Local agent id: ${added.id}`);
}
