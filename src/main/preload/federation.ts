/**
 * Preload API for the Federation peer mirror (`window.maestro.federation`).
 *
 * Mirrors the `federation:*` channels in `src/main/ipc/handlers/federation.ts`. Read-only in
 * FED-SSH-05: a window reads what the main-process service mirrors and follows its pushes. What a
 * window gets here lives in memory only; nothing here writes a store. Desktop-only: no
 * `federation:` channel is on the web-desktop allowlist.
 */

import { ipcRenderer } from 'electron';
import type { MirrorPeerSummary, MirrorPush } from '../../shared/maestro-lib/client/peer-mirror';
import type { LogEntryRecord } from '../../shared/maestro-lib/store/transcript';
import type {
	PeerMirrorSnapshot,
	PeerReconnectResult,
	TranscriptReadOptions,
} from '../federation/peer-mirror-service';

/** Creates the Federation API object for contextBridge exposure. */
export function createFederationApi() {
	return {
		/** `enabled` is false while the Federation Encore Feature is off. */
		status: (): Promise<{ enabled: boolean }> => ipcRenderer.invoke('federation:status'),
		/** Every mirrored peer, in stored order, with its connection and agent count. */
		peers: (): Promise<MirrorPeerSummary[]> => ipcRenderer.invoke('federation:peers'),
		/** Every peer with its agents and live turns, for a window that just loaded. */
		snapshot: (): Promise<PeerMirrorSnapshot> => ipcRenderer.invoke('federation:snapshot'),
		/** A tab's transcript as the host persisted it (newest 500 entries by default). */
		transcript: (
			peerId: string,
			agentId: string,
			tabId: string,
			options?: TranscriptReadOptions
		): Promise<LogEntryRecord[]> =>
			ipcRenderer.invoke('federation:transcript', peerId, agentId, tabId, options ?? {}),
		/** Restart the forward or the client when down, then reload the peer's agents. */
		reconnect: (peerId: string): Promise<PeerReconnectResult> =>
			ipcRenderer.invoke('federation:reconnect', peerId),
		/** Fires on every change to a mirrored peer. */
		onEvent: (handler: (payload: MirrorPush) => void): (() => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, payload: MirrorPush) => handler(payload);
			ipcRenderer.on('federation:event', wrapped);
			return () => {
				ipcRenderer.removeListener('federation:event', wrapped);
			};
		},
		/** Fires when the feature turns off: drop everything mirrored. */
		onReset: (handler: () => void): (() => void) => {
			const wrapped = () => handler();
			ipcRenderer.on('federation:reset', wrapped);
			return () => {
				ipcRenderer.removeListener('federation:reset', wrapped);
			};
		},
	};
}

export type FederationApi = ReturnType<typeof createFederationApi>;
