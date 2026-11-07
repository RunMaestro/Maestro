// `maestro-cli federation` - the Federation peers the desktop mirrors in its Left Bar
// (FED-SSH-05).
//
// `peers` lists each peer with its connection state and agent count; `reconnect <peer>` forces the
// same reload the Left Bar's Reconnect runs. Both send `federation_command` over the WS bridge to
// the desktop's one `PeerMirrorService`, so they report what the desktop shows. Neither dials SSH
// from this process: the desktop holds the forwards (`remote-host status` is the direct probe).
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

/** One line per peer, then its error (with the fix) indented under it. */
export function formatFederationPeers(peers: readonly MirrorPeerSummary[]): string {
	if (peers.length === 0) {
		return 'No peers mirrored. Opt an SSH remote in with `maestro-cli update-ssh-remote <remote> --federation on`.';
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
