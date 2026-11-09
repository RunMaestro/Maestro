/**
 * Wire shape of `federation_command`, the CLI half of the desktop's Federation peer mirror
 * (`maestro-cli federation peers|reconnect`, FED-SSH-05).
 *
 * The desktop answers it from the one main-process `PeerMirrorService`, the same instance the
 * `federation:*` IPC handlers and the Left Bar peer groups read, so the CLI prints what the
 * desktop shows. CLI only: a browser client is refused, as every `federation:` IPC channel is on
 * the web-desktop deny list.
 *
 * Lives in `shared/` because main answers it and the CLI prints it.
 */

import type { MirrorPeerSummary } from './maestro-lib/client/peer-mirror';

export const FEDERATION_COMMAND = 'federation_command';
export const FEDERATION_COMMAND_RESULT = 'federation_command_result';

/** `peers` lists what the desktop mirrors; `reconnect` forces one peer's reload. */
export type FederationCommandAction = 'peers' | 'reconnect';

export const FEDERATION_COMMAND_ACTIONS: readonly FederationCommandAction[] = [
	'peers',
	'reconnect',
];

export interface FederationCommandRequest {
	type: typeof FEDERATION_COMMAND;
	action: FederationCommandAction;
	/** `reconnect` only: a peer id, remote name, or remote id (prefix), as `findMirrorPeer()` reads it. */
	peer?: string;
}

export interface FederationCommandResult {
	success: boolean;
	error?: string;
	/** `peers`: every peer the desktop mirrors, in stored order. */
	peers?: MirrorPeerSummary[];
	/** `reconnect`: the peer after its reload, also on a failed reload. */
	peer?: MirrorPeerSummary;
}
