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
 * The `promptLinks:*` channels are refused for a related reason: a browser can
 * send prompts only while it is connected, and minting a Prompt Link would let
 * it keep that power after it disconnects or its account is disabled. Listing
 * them would also hand it every stored prompt.
 *
 * `updates:rollback` is refused because it replaces the host's app with an
 * OLDER build, which can reopen vulnerabilities a later release closed. Only
 * the person at the desktop (or its CLI) may decide to run a downgraded app.
 *
 * Matching is by PREFIX rather than by exact channel name on purpose: a
 * channel added to the namespace later is denied the moment it is registered,
 * instead of being exposed until somebody remembers to extend a list.
 */

/** Channel prefixes refused before dispatch. */
export const BRIDGE_DENIED_CHANNELS: ReadonlySet<string> = new Set([
	'webLogin:',
	'promptLinks:',
	'updates:rollback',
]);

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
