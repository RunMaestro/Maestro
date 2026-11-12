/**
 * IPC channels a web client may never invoke over the bridge.
 *
 * The bridge exposes every registered `ipcMain` handler to an authenticated
 * browser, which is what makes web-desktop the same app rather than a subset
 * of it. Account administration is the one thing that cannot ride that rule:
 * the desktop is the administrator, and a browser that could call
 * `webLogin:createUser` or `webLogin:resetPassword` could mint itself a second
 * account, or take over somebody else's, from inside the very session the gate
 * was meant to constrain. The `webLogin:*` channels also read and write
 * `web-users.json`, which holds every password hash.
 *
 * Matching is by PREFIX rather than by exact channel name on purpose: a
 * channel added to the namespace later is denied the moment it is registered,
 * instead of being exposed until somebody remembers to extend a list.
 */

/** Channel prefixes refused before dispatch. */
export const BRIDGE_DENIED_CHANNELS: ReadonlySet<string> = new Set(['webLogin:']);

/** Whether `channel` falls under a denied prefix. */
export function isBridgeDeniedChannel(channel: string): boolean {
	for (const prefix of BRIDGE_DENIED_CHANNELS) {
		if (channel.startsWith(prefix)) return true;
	}
	return false;
}

/** The error a denied channel answers with. Named so tests can pin the wording. */
export function bridgeDeniedChannelError(channel: string): string {
	return `Channel "${channel}" is not available over the web interface`;
}
