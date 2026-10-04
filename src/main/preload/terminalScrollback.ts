/**
 * Preload API for terminal scrollback persistence.
 *
 * A terminal tab's history lives only in its xterm instance; this namespace
 * writes a serialized snapshot to disk (see src/main/terminal-scrollback-store.ts)
 * so the tab comes back with its scrollback after an app restart. Keys are the
 * terminal's IPC routing key, `{agentId}-terminal-{tabId}`.
 */

import { ipcRenderer } from 'electron';

export function createTerminalScrollbackApi() {
	return {
		/** Write a snapshot (an empty string removes it). Resolves false when refused. */
		save: (key: string, data: string): Promise<boolean> =>
			ipcRenderer.invoke('terminalScrollback:save', key, data),
		/** Read a snapshot, or null when none was saved. */
		load: (key: string): Promise<string | null> =>
			ipcRenderer.invoke('terminalScrollback:load', key),
		/** Delete every snapshot not named in `keepKeys`; resolves the number removed. */
		prune: (keepKeys: string[]): Promise<number> =>
			ipcRenderer.invoke('terminalScrollback:prune', keepKeys),
	};
}

export type TerminalScrollbackApi = ReturnType<typeof createTerminalScrollbackApi>;
