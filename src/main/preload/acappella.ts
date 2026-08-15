/**
 * Preload API for A Cappella (voice sessions).
 *
 * Provides the `window.maestro.voice` namespace. Every channel is gated in the
 * main process on the `aCappella` Encore flag; when it is off they reject with
 * 'ACappellaDisabled', which callers treat as "feature off" rather than "no
 * session". `stop()` is the one exception and always works, so a client can
 * release the floor even after the flag is turned off mid-session.
 *
 * `onEvent` is the whole protocol: state, transcript, routing, dispatch, and
 * speech all arrive as `VoiceEvent`s on one ordered stream, so a client renders
 * from the stream rather than from the return values of these calls.
 */

import { ipcRenderer } from 'electron';
import type { RosterAgent, VoiceEvent, VoiceScope } from '../../shared/acappella/protocol';
import type { VoiceReadiness } from '../../shared/acappella/readiness';
import type { VoiceSessionSnapshot } from '../acappella';
import type { VoiceStartSessionResult } from '../ipc/handlers/acappella';
import type { VoiceModelListing } from '../ipc/handlers/acappella-models';
import type { DownloadProgress, DownloadResult } from '../acappella/models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../acappella/models/model-store';
import type { MicPermissionInfo } from '../acappella/permissions/mic-permission';

/**
 * `window.maestro.voice.models.*` - the model manager.
 *
 * Nothing in here touches the network except {@link download} and
 * {@link resume}. `list()` is a disk read against a frozen local catalog, which
 * is what lets Voice Setup show a full bill of materials (name, size, license,
 * install path) before the user has agreed to fetch a single byte.
 *
 * `remove`, `removeAll`, and `footprint` deliberately keep working when the
 * Encore Feature is off, because that is exactly when someone wants their disk
 * back.
 */
function createVoiceModelsApi() {
	return {
		/** Every catalog model joined to its on-disk status and install paths. */
		list: (): Promise<VoiceModelListing[]> => ipcRenderer.invoke('models:list'),

		/**
		 * Start or resume a download. The ONLY call in this namespace that opens a
		 * connection. Resolves when the model is installed, paused, cancelled, or
		 * has failed; watch {@link onProgress} for the intervening detail.
		 */
		download: (modelId: string): Promise<DownloadResult> =>
			ipcRenderer.invoke('models:download', modelId),

		/** Abort the transfer, keep the partial file. */
		pause: (modelId: string): Promise<boolean> => ipcRenderer.invoke('models:pause', modelId),

		/** Continue from the partial file rather than starting over. */
		resume: (modelId: string): Promise<DownloadResult> =>
			ipcRenderer.invoke('models:resume', modelId),

		/** Abort and delete everything the download wrote. */
		cancel: (modelId: string): Promise<boolean> => ipcRenderer.invoke('models:cancel', modelId),

		/**
		 * Re-hash an installed model. A mismatch is REPORTED, never repaired: the
		 * result carries both hashes so the UI can offer Re-verify or Re-download
		 * rather than silently spending a gigabyte.
		 */
		verify: (modelId: string): Promise<VerifyResult> =>
			ipcRenderer.invoke('models:verify', modelId),

		/** Delete one model. Resolves to the bytes reclaimed. */
		remove: (modelId: string): Promise<number> => ipcRenderer.invoke('models:remove', modelId),

		/** Delete every A Cappella model. Resolves to the bytes reclaimed. */
		removeAll: (): Promise<number> => ipcRenderer.invoke('models:remove-all'),

		/** Disk used by A Cappella models, including directories no longer in the catalog. */
		footprint: (): Promise<ModelFootprint> => ipcRenderer.invoke('models:footprint'),

		/**
		 * The capability gate's verdict. One source of truth for the HUD, the
		 * hotkeys, and Settings, so a disabled microphone button and the Voice Setup
		 * panel can never disagree about why.
		 */
		readiness: (): Promise<VoiceReadiness> => ipcRenderer.invoke('models:readiness'),

		/**
		 * Download progress, throttled at the source. Broadcast, so every window
		 * sees the same transfer.
		 *
		 * @returns Cleanup function to unsubscribe.
		 */
		onProgress: (handler: (progress: DownloadProgress) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, progress: DownloadProgress) =>
				handler(progress);
			ipcRenderer.on('models:progress', wrappedHandler);
			return () => ipcRenderer.removeListener('models:progress', wrappedHandler);
		},
	};
}

/**
 * Creates the A Cappella voice API object for contextBridge exposure.
 */
export function createVoiceApi() {
	return {
		/** The model manager: catalog, downloads, verification, and disk. */
		models: createVoiceModelsApi(),

		/**
		 * Open a voice session. Omit the scope for conductor scope. Any live
		 * session is replaced rather than stacked.
		 *
		 * Returns the snapshot plus any provider substitutions: a role that fell
		 * back to the mock tier is reported here, never applied silently.
		 */
		start: (scope?: VoiceScope): Promise<VoiceStartSessionResult> =>
			ipcRenderer.invoke('acappella:start-session', scope),

		/** End the session and return to idle. Safe to call when already idle. */
		stop: (): Promise<void> => ipcRenderer.invoke('acappella:stop-session'),

		/**
		 * Hand the service a settled utterance. This is the same seam a real STT
		 * final transcript lands on, so the dev harness and a microphone are
		 * indistinguishable downstream.
		 *
		 * @returns false when the session cannot take an utterance right now.
		 */
		submitUtterance: (text: string): Promise<boolean> =>
			ipcRenderer.invoke('acappella:submit-utterance', text),

		/**
		 * Barge-in: cancel speech and KEEP the floor. Distinct from {@link stopWord}
		 * on purpose - talking over the assistant must not hang up on it.
		 *
		 * @returns false when nothing was speaking.
		 */
		interrupt: (source: 'voice' | 'client-button' = 'client-button'): Promise<boolean> =>
			ipcRenderer.invoke('acappella:interrupt', source),

		/** The stop word: end the session from any state. */
		stopWord: (payload?: { phrase?: string; source?: 'voice' | 'client-button' }): Promise<void> =>
			ipcRenderer.invoke('acappella:stop-word', payload),

		/**
		 * Hand the service an agent's answer, which it reshapes for the ear and
		 * speaks. Phase 05 feeds real agent output to the same seam in-process;
		 * this channel is what lets a client drive a turn past `dispatching`.
		 *
		 * @returns false when the session was not waiting on a reply.
		 */
		submitAgentReply: (params: {
			agentSessionId: string;
			tabId: string;
			text: string;
		}): Promise<boolean> => ipcRenderer.invoke('acappella:submit-agent-reply', params),

		/** Current agents and their AI tabs, as the Brain sees them. */
		getRoster: (): Promise<RosterAgent[]> => ipcRenderer.invoke('acappella:get-roster'),

		/**
		 * Open the OS microphone permission settings, the one recovery for a denied
		 * microphone that the app itself cannot perform.
		 *
		 * @returns false on a platform with no such link (Linux), so a caller can
		 *          offer words instead of a button that would do nothing.
		 */
		openMicSettings: (): Promise<boolean> => ipcRenderer.invoke('acappella:open-mic-settings'),

		/**
		 * The microphone permission as the OS reports it, plus whether asking would
		 * actually show a prompt and where the privacy pane is.
		 *
		 * A pure query: calling this NEVER prompts. The prompt happens once, at the
		 * first session start, because asking for the microphone before the user has
		 * asked for voice is a trust problem rather than a convenience.
		 *
		 * Kept separate from `models.readiness()` on purpose. A denied microphone
		 * and a missing model are different failures with different recoveries, and
		 * a UI that can only say "voice unavailable" has already lost the user.
		 */
		micPermission: (): Promise<MicPermissionInfo> => ipcRenderer.invoke('acappella:mic-permission'),

		/**
		 * Catch-up snapshot. Null when no session service exists yet (nothing is
		 * constructed until the first `start`), which a client reads as idle.
		 */
		getState: (): Promise<VoiceSessionSnapshot | null> => ipcRenderer.invoke('acappella:get-state'),

		/**
		 * Subscribe to the protocol event stream. Events carry a monotonic `seq`
		 * per voice session, so a gap means events were lost.
		 *
		 * @returns Cleanup function to unsubscribe.
		 */
		onEvent: (handler: (event: VoiceEvent) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, voiceEvent: VoiceEvent) =>
				handler(voiceEvent);
			ipcRenderer.on('acappella:event', wrappedHandler);
			return () => ipcRenderer.removeListener('acappella:event', wrappedHandler);
		},
	};
}

/**
 * TypeScript type for the A Cappella voice API.
 */
export type VoiceApi = ReturnType<typeof createVoiceApi>;
