/**
 * IPC channels that only a window of the desktop app may invoke.
 *
 * The web bridge (`web-server/handlers/bridgeHandlers.ts`) hands any registered
 * `ipcMain` handler to a client that holds its token. A handler that must not
 * be reached that way proves its sender itself, since that is the check that
 * cannot be skipped. This list is the second lock: the bridge reads it before
 * it looks a handler up, and answers for a channel on it exactly as it answers
 * for a channel nobody registered. A caller on the bridge then cannot tell the
 * two apart, and a handler whose own check is later weakened by mistake is
 * still out of reach.
 *
 * It also keeps an event pushed on such a channel from fanning out to the
 * bridge's clients.
 *
 * It is not `web-server/handlers/bridgeDenyList.ts`. That list names its
 * channels in the web server's own source and answers with an error of its
 * own. This one is filled by the code that registers a handler, and a refusal
 * here reads as "no such channel".
 */

const desktopOnlyChannels = new Set<string>();

/** Keeps `channel` away from every caller but a window of the desktop app. */
export function markDesktopOnlyChannel(channel: string): void {
	desktopOnlyChannels.add(channel);
}

/** Whether `channel` was marked with `markDesktopOnlyChannel`. */
export function isDesktopOnlyChannel(channel: string): boolean {
	return desktopOnlyChannels.has(channel);
}

/** Empties the list. For tests. */
export function __resetDesktopOnlyChannelsForTests(): void {
	desktopOnlyChannels.clear();
}
