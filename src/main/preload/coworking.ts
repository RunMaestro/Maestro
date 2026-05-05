/**
 * Preload API for the coworking subsystem.
 *
 * Exposes:
 *  - install / uninstall / install-status (Settings UI)
 *  - registry sync (renderer pushes terminal state to main)
 *  - buffer-request listener (main asks renderer for a tab's scrollback)
 */

import { ipcRenderer } from 'electron';

export interface CoworkingTerminalEntry {
	id: string;
	cwd: string;
	title: string;
}

export interface CoworkingTerminalRecord extends CoworkingTerminalEntry {
	tabUuid: string;
	sessionId: string;
}

export interface CoworkingInstallStatus {
	agentId: string;
	configPath: string;
	installed: boolean;
}

export interface CoworkingApi {
	// ---- Settings panel ----
	getInstallStatus(): Promise<CoworkingInstallStatus[]>;
	install(agentId: string): Promise<void>;
	uninstall(agentId: string): Promise<void>;
	installAll(): Promise<Array<{ agentId: string; ok: boolean; error?: string }>>;

	// ---- Registry sync (renderer → main) ----
	//
	// The renderer pushes terminal state for *every* Maestro session, not just the
	// focused one. There is no setActiveSession — scoping happens via the MCP
	// subprocess's bridge handshake (see coworking-bridge.ts) so an agent only
	// ever sees its own session's terminals.
	syncSessionTerminals(sessionId: string, records: CoworkingTerminalRecord[]): Promise<void>;
	upsertTerminal(record: CoworkingTerminalRecord): Promise<void>;
	removeTerminal(tabUuid: string): Promise<void>;
	removeSession(sessionId: string): Promise<void>;

	// ---- Buffer request (main → renderer) ----
	/**
	 * Subscribe to "give me the scrollback of <tabUuid> in <sessionId>" requests from main.
	 * The renderer must send the buffer back via the supplied responseChannel. `sessionId`
	 * is the owning session id (used to pick the correct TerminalView ref) — always set,
	 * because the bridge enforces per-connection session binding at handshake.
	 */
	onRequestBuffer(
		callback: (tabUuid: string, sessionId: string, responseChannel: string) => void
	): () => void;
	sendBufferResponse(responseChannel: string, content: string): void;
}

export function createCoworkingApi(): CoworkingApi {
	return {
		getInstallStatus: () => ipcRenderer.invoke('coworking:getInstallStatus'),
		install: (agentId) => ipcRenderer.invoke('coworking:install', agentId),
		uninstall: (agentId) => ipcRenderer.invoke('coworking:uninstall', agentId),
		installAll: () => ipcRenderer.invoke('coworking:installAll'),

		syncSessionTerminals: (sessionId, records) =>
			ipcRenderer.invoke('coworking:syncSessionTerminals', sessionId, records),
		upsertTerminal: (record) => ipcRenderer.invoke('coworking:upsertTerminal', record),
		removeTerminal: (tabUuid) => ipcRenderer.invoke('coworking:removeTerminal', tabUuid),
		removeSession: (sessionId) => ipcRenderer.invoke('coworking:removeSession', sessionId),

		onRequestBuffer: (callback) => {
			const handler = (_: unknown, tabUuid: string, sessionId: string, responseChannel: string) =>
				callback(tabUuid, sessionId, responseChannel);
			ipcRenderer.on('coworking:requestBuffer', handler);
			return () => ipcRenderer.removeListener('coworking:requestBuffer', handler);
		},
		sendBufferResponse: (responseChannel, content) => {
			ipcRenderer.send(responseChannel, content);
		},
	};
}
