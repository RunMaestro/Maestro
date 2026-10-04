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
 * The same rule covers `computerHistory:*` (see the list below). Prefix
 * denial only stops the named channels; argument-level guards for other
 * channels live in bridgePathGuard.ts.
 *
 * Matching is by PREFIX rather than by exact channel name on purpose: a
 * channel added to the namespace later is denied the moment it is registered,
 * instead of being exposed until somebody remembers to extend a list.
 */

/** Channel prefixes refused before dispatch. */
export const BRIDGE_DENIED_CHANNELS: ReadonlySet<string> = new Set([
	'webLogin:',
	// Computer History is the user's screen and typing history. Denying the
	// namespace keeps a browser off the service's own verbs (status, query,
	// pause, rules, clear, config). It is NOT the whole wall: the store files
	// are also reachable through generic handlers such as `fs:readFile`, which
	// bridgePathGuard.ts covers (protected paths, the CLI discovery file, and
	// writes that would flip the Computer History flag). maestro-cli reaches
	// the service through its own `computer_history_command` WS message, which
	// refuses any socket that did not present the CLI secret.
	'computerHistory:',
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
