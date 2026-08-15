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
import type { VoiceStartSessionResult, WakeTestEvent } from '../ipc/handlers/acappella';
import type { GlobalHotkeyStatus } from '../../shared/global-hotkeys';
import type { VoiceHotkeyRefusalInfo } from '../acappella/hotkeys/voice-hotkeys';
import type { VoiceModelListing } from '../ipc/handlers/acappella-models';
import type { DownloadProgress, DownloadResult } from '../acappella/models/model-downloader';
import type { ModelFootprint, VerifyResult } from '../acappella/models/model-store';
import type { MicPermissionInfo } from '../acappella/permissions/mic-permission';
import type { RoutingLogEntry, RoutingQuality } from '../acappella/router/routing-log';
import type { CredentialState, CredentialValidation } from '../acappella/providers/credentials';
import type { VoiceCredentialService } from '../../shared/acappella/provider-catalog';
import type { TurnBreakdown } from '../acappella/telemetry/turn-metrics';

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
 * `window.maestro.voice.credentials.*` - API keys for the hosted tier.
 *
 * There is deliberately no `get`. Keys live in the OS keychain and are read only
 * in the main process; a channel that handed one back would put it in a renderer
 * heap, in a devtools frame, and in any crash dump taken afterwards, for no
 * capability the panel actually needs.
 */
function createVoiceCredentialsApi() {
	return {
		/** Which services have a key stored, and whether this machine has a keychain. */
		list: (): Promise<CredentialState[]> => ipcRenderer.invoke('acappella:list-credentials'),

		/** Store a key, or clear it when `key` is empty. */
		set: (service: VoiceCredentialService, key: string): Promise<{ ok: boolean; error?: string }> =>
			ipcRenderer.invoke('acappella:set-credential', { service, key }),

		/**
		 * Check a key against the service. Pass one to test before saving; omit it to
		 * test the stored one. Rate limiting comes back as its own status, because a
		 * throttled account is not a bad key.
		 */
		validate: (service: VoiceCredentialService, key?: string): Promise<CredentialValidation> =>
			ipcRenderer.invoke('acappella:validate-credential', { service, key }),
	};
}

/**
 * Creates the A Cappella voice API object for contextBridge exposure.
 */
export function createVoiceApi() {
	return {
		/** The model manager: catalog, downloads, verification, and disk. */
		models: createVoiceModelsApi(),

		/** API keys for the hosted tier, stored in the OS keychain. */
		credentials: createVoiceCredentialsApi(),

		/**
		 * Apply a provider change to the running app.
		 *
		 * Called after the settings panel writes a selection. Refused while a turn
		 * is in flight rather than queued, so two engines can never be spliced into
		 * one exchange.
		 */
		applyProviders: (): Promise<{
			status: 'swapped' | 'unchanged' | 'refused';
			reason?: string;
		}> => ipcRenderer.invoke('acappella:apply-providers'),

		/**
		 * The last turn's per-hop timings, or null before any turn has completed.
		 * What turns "voice feels slow" into a specific hop.
		 */
		lastTurn: (): Promise<TurnBreakdown | null> => ipcRenderer.invoke('acappella:last-turn'),

		/**
		 * Move the last dispatch to a different agent: the HUD's "wrong tab"
		 * control, and what a spoken "no, the other one" does.
		 *
		 * @returns false when there is nothing to correct, so a stray click is a
		 *          no-op rather than an error.
		 */
		correctRoute: (agentSessionId: string): Promise<boolean> =>
			ipcRenderer.invoke('acappella:correct-route', agentSessionId),

		/**
		 * Every routing decision this install has made, with what became of it.
		 *
		 * The point of the aggregate is that a decision the user immediately
		 * corrected is a miss even though nothing errored, so routing quality is
		 * measurable rather than anecdotal.
		 */
		routingLog: (): Promise<{ entries: RoutingLogEntry[]; quality: RoutingQuality }> =>
			ipcRenderer.invoke('acappella:routing-log'),

		/**
		 * Voices the configured TTS provider offers. Empty for a provider with one
		 * voice or none, which the picker shows as "Provider default".
		 */
		listVoices: (): Promise<Array<{ id: string; name: string }>> =>
			ipcRenderer.invoke('acappella:list-voices'),

		/**
		 * Speak one line through the configured voice.
		 *
		 * @returns false when nothing could be spoken: no audio host, a silent
		 *          provider, or a live session that the preview must not talk over.
		 */
		previewVoice: (text: string): Promise<boolean> =>
			ipcRenderer.invoke('acappella:preview-voice', text),

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

		/**
		 * Whether each voice hotkey is actually bound, and what a press can do on
		 * this platform.
		 *
		 * The settings rows render this inline rather than assuming success: a combo
		 * the OS already owns is the single most common way a global hotkey silently
		 * does nothing, and "registered" is the only honest thing to show next to a
		 * key the user just recorded.
		 */
		hotkeyStatus: (): Promise<{
			statuses: GlobalHotkeyStatus[];
			capability: 'hold-and-tap' | 'tap-only';
			note: string;
		}> => ipcRenderer.invoke('acappella:hotkey-status'),

		/**
		 * Start a wake-word tuning run: the local detector, no session, so a user can
		 * say the phrase and watch it fire while moving the sensitivity slider.
		 *
		 * @returns false when a session is already running or there is no audio host.
		 */
		wakeTest: (payload?: { phrase?: string; sensitivity?: number }): Promise<boolean> =>
			ipcRenderer.invoke('acappella:wake-test', payload),

		/** End a tuning run and close the microphone it opened. */
		wakeTestStop: (): Promise<void> => ipcRenderer.invoke('acappella:wake-test-stop'),

		/**
		 * Hits from a tuning run. Its own channel rather than a protocol event: a
		 * run has no session, and synthesising one so a settings panel can light a
		 * dot would put a fake session in every client's stream.
		 *
		 * @returns Cleanup function to unsubscribe.
		 */
		onWakeTest: (handler: (event: WakeTestEvent) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, hit: WakeTestEvent) =>
				handler(hit);
			ipcRenderer.on('acappella:wake-test', wrappedHandler);
			return () => ipcRenderer.removeListener('acappella:wake-test', wrappedHandler);
		},

		/**
		 * A voice hotkey was pressed and did nothing, with the reason. Subscribed by
		 * the HUD so a refused press says why rather than looking like a dead key.
		 *
		 * @returns Cleanup function to unsubscribe.
		 */
		onHotkeyRefused: (handler: (info: VoiceHotkeyRefusalInfo) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, info: VoiceHotkeyRefusalInfo) =>
				handler(info);
			ipcRenderer.on('acappella:event:hotkey-refused', wrappedHandler);
			return () => ipcRenderer.removeListener('acappella:event:hotkey-refused', wrappedHandler);
		},
	};
}

/**
 * TypeScript type for the A Cappella voice API.
 */
export type VoiceApi = ReturnType<typeof createVoiceApi>;
