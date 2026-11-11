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
// A headless host (`maestro-cli host`) mirrors no peers, so it does not serve this message.

import {
	FEDERATION_COMMAND,
	FEDERATION_COMMAND_RESULT,
	type FederationCommandAction,
	type FederationCommandResult,
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

async function sendFederationCommand(
	action: FederationCommandAction,
	extra: { peer?: string } = {},
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
	extra?: { peer?: string },
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
		if (remote.fix) lines.push(`    To fix: ${remote.fix}`);
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
		snapshot.remotes.some((remote) => remote.state === 'blocked') ||
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
