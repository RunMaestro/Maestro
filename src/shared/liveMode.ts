/**
 * Live Mode state as main reports it: to `maestro-cli live status`, and to
 * every window through the `live:stateChanged` push.
 */
export interface LiveModeState {
	/** True while the LAN web interface is running. */
	live: boolean;
	/** The LAN URL (with token), or null while Live is off. */
	url: string | null;
	/** Cloudflare tunnel state; `url` already carries the token path. */
	tunnel: {
		isRunning: boolean;
		url: string | null;
		error: string | null;
	};
}
