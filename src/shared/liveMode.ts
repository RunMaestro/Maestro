/**
 * Live mode (the web interface switch) state, and the wire shape of the
 * `live_command` message - the CLI half of the Left Bar LIVE pill.
 *
 * Live state lives in main (`src/main/web-server/live-mode.ts`): the truth is
 * "a LAN server is running", which only main can see. The renderer, the
 * `live:*` IPC channels, and `maestro-cli live` all read and switch it there.
 *
 * Lives in `shared/` because all three processes need it: main answers, the
 * renderer draws the pill from it, and the CLI prints it.
 */

/** What `live status` (and every switch) reports. */
export interface LiveModeStatus {
	/** A LAN server is running: the web interface is open to other devices. */
	live: boolean;
	/** The tokenized LAN URL while Live is on, else `null`. */
	url: string | null;
	/** The Cloudflare tunnel (Remote Control) is running. */
	remoteControl: boolean;
	/** The tokenized public URL while Remote Control is running, else `null`. */
	remoteControlUrl: string | null;
	/** Why Remote Control is down, when the tunnel reported a failure. */
	remoteControlError?: string;
	/** Increases after every finished switch, success or failure. */
	revision: number;
	/** The most recent switch failure, cleared by the next success. */
	lastError?: string;
}

/**
 * What every window is told after a switch, so each LIVE pill and its Remote
 * Control row follow main, whichever surface made the switch.
 */
export type LiveModeStateEvent = Pick<
	LiveModeStatus,
	'live' | 'url' | 'remoteControl' | 'remoteControlUrl' | 'remoteControlError'
>;

/** What starting or stopping Remote Control answers. */
export interface RemoteControlSetResult {
	success: boolean;
	/** The tokenized public URL once the tunnel is up. */
	url?: string;
	error?: string;
	status: LiveModeStatus;
}

/** What `set(live)` answers: the status after the switch. */
export interface LiveModeSetResult {
	success: boolean;
	/** `false` when Live was already in the requested state (nothing ran). */
	changed: boolean;
	status: LiveModeStatus;
	error?: string;
}

export const LIVE_COMMAND = 'live_command';
export const LIVE_COMMAND_RESULT = 'live_command_result';

/**
 * The verbs a `live_command` can carry. Explicit sets only, no toggle.
 * `remote-on` / `remote-off` drive Remote Control (the Cloudflare tunnel); they
 * do not replace the server, so they answer after the switch, not before.
 */
export const LIVE_COMMAND_ACTIONS = ['status', 'on', 'off', 'remote-on', 'remote-off'] as const;

export type LiveCommandAction = (typeof LIVE_COMMAND_ACTIONS)[number];

/** Narrow an unknown value to a Live command action. */
export function isLiveCommandAction(value: unknown): value is LiveCommandAction {
	return typeof value === 'string' && LIVE_COMMAND_ACTIONS.includes(value as LiveCommandAction);
}

/**
 * The reply to a `live_command`.
 *
 * A switch replaces the server the CLI's socket is on, so the handler answers
 * BEFORE it switches: `changed: true` carries `awaitRevision`, and the caller
 * reconnects and polls `status` until `status.revision` reaches it.
 */
export interface LiveCommandResult {
	success: boolean;
	error?: string;
	status?: LiveModeStatus;
	changed?: boolean;
	awaitRevision?: number;
}
