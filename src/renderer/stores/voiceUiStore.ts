/**
 * voiceUiStore - the A Cappella surface state that is NOT part of the protocol.
 *
 * `voiceSessionStore` is a projection of the main-process session and holds
 * nothing authoritative. This store is the opposite: it owns things the session
 * has no opinion about - where the user dragged the HUD, whether the transcript
 * panel is open, whether the widget is collapsed, whether the speaker is muted -
 * and persists the durable ones into the `ui` section of the `acappella`
 * settings blob.
 *
 * A store rather than component state because three separate surfaces read the
 * same answers: the HUD, the Settings panel (which can reset the position and
 * toggle the transcript), and the Left Bar wake-phrase badge. Two of them
 * showing different values for one checkbox is the bug this prevents.
 *
 * The wake-phrase mirror is here for one reason: the Left Bar draws a badge per
 * agent row, and a per-row async `settings.get()` would be one disk read per
 * agent per render. It is a READ-ONLY copy - `useVoiceControls` still owns
 * writing phrases, and calls `refreshWakePhrases()` after each one.
 */

import { create } from 'zustand';
import {
	DEFAULT_VOICE_UI_PREFS,
	readVoiceUiPrefs,
	type VoiceHudMinimizeBehavior,
	type VoiceHudPosition,
	type VoiceUiPrefs,
} from '../../shared/acappella/ui-prefs';
import {
	DEFAULT_HOLD_THRESHOLD_MS,
	resolveHoldThresholdMs,
} from '../../shared/acappella/voice-controls';
import type { VoiceListenMode, VoiceSendWait } from '../../shared/acappella/listen-mode';
import {
	patchVoiceSettingsSection,
	readVoiceSettingsBlob,
	type VoiceSettingsBlob,
} from '../services/voiceSettings';

interface VoiceUiState extends VoiceUiPrefs {
	/** False until the stored blob has been read once. */
	loaded: boolean;
	/**
	 * The HUD is collapsed to its small indicator. Session-scoped on purpose: a
	 * minimized widget is a live session the user tucked away, and restoring the
	 * app into "minimized" with no session behind it would show a control for
	 * something that is not running.
	 */
	minimized: boolean;
	/**
	 * The user muted the assistant's voice from the HUD. Also session-scoped: a
	 * mute that survived a restart is how someone ends up with a voice assistant
	 * that has silently stopped talking to them.
	 */
	muted: boolean;
	/** Agent session id -> wake phrase. Read-only mirror; see the file comment. */
	wakePhrases: Record<string, string>;
	/**
	 * The tap-vs-hold threshold, mirrored from `controls`.
	 *
	 * The HUD's talk button classifies a press exactly the way the global hotkey
	 * does, off the same number. A button that decided "hold" at 300 ms while the
	 * key the user configured decided it at 800 ms would be two push-to-talk
	 * gestures wearing one name.
	 */
	holdThresholdMs: number;
	/**
	 * The send wait in force, mirrored from main, or null before the first read.
	 *
	 * Main owns it (the stored default plus the HUD's override, see
	 * `acappella:get-send-wait`); this is the copy the wait chip and its picker
	 * draw from, replaced whole by every read and every write.
	 */
	sendWait: VoiceSendWait | null;
	/**
	 * The HUD is on screen, on top, with a live session: Tab cycles its mode.
	 *
	 * Published by the HUD rather than derived by each reader, because it is the
	 * exact condition the HUD's own Tab listener is enabled under, and a second
	 * derivation would drift. See {@link voiceHudClaimsTab}.
	 */
	tabCyclesMode: boolean;
}

interface VoiceUiActions {
	/** Read the persisted prefs and the wake-phrase mirror. Safe to call twice. */
	load: () => Promise<void>;
	setTranscriptVisible: (visible: boolean) => Promise<void>;
	toggleTranscript: () => Promise<void>;
	setHudPosition: (position: VoiceHudPosition | null) => Promise<void>;
	setMinimizeBehavior: (behavior: VoiceHudMinimizeBehavior) => Promise<void>;
	setMinimized: (minimized: boolean) => void;
	setMuted: (muted: boolean) => void;
	/**
	 * Remember hands-free or push-to-talk. Persists only: what the choice does to
	 * a live microphone is `setVoiceListenMode` in `services/voiceListening.ts`,
	 * which is what every surface should call.
	 */
	setListenMode: (mode: VoiceListenMode) => Promise<void>;
	/** Re-read the send wait. The stored default can change in Settings at any time. */
	refreshSendWait: () => Promise<void>;
	/** Pick a wait for now, or null to return to the stored default. */
	setSendWait: (waitMs: number | null) => Promise<void>;
	/**
	 * Store the send phrases, as typed (comma separated). Unlike the wait this is
	 * the SETTING, not a "just for now": a phrase is something a person learns,
	 * and one that reverted when the HUD closed would be a phrase that stops
	 * working without saying so. An empty string turns the spoken send off.
	 */
	setSendPhrases: (phrases: string) => Promise<void>;
	setTabCyclesMode: (tabCyclesMode: boolean) => void;
	/** Re-read the wake-phrase mirror after `useVoiceControls` writes one. */
	refreshWakePhrases: () => Promise<void>;
}

export type VoiceUiStore = VoiceUiState & VoiceUiActions;

function phrasesFromBlob(blob: VoiceSettingsBlob | undefined): Record<string, string> {
	const raw = blob?.controls?.agentPhrases;
	if (!Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') continue;
		const { agentSessionId, phrase } = entry as { agentSessionId?: unknown; phrase?: unknown };
		if (typeof agentSessionId !== 'string' || typeof phrase !== 'string') continue;
		if (!phrase.trim()) continue;
		out[agentSessionId] = phrase.trim();
	}
	return out;
}

/** Write `ui` fields. Patch-only and queued: see `services/voiceSettings.ts`. */
function persistUi(patch: Partial<VoiceUiPrefs>): Promise<void> {
	return patchVoiceSettingsSection('ui', patch);
}

export const useVoiceUiStore = create<VoiceUiStore>()((set, get) => ({
	...DEFAULT_VOICE_UI_PREFS,
	loaded: false,
	minimized: false,
	muted: false,
	wakePhrases: {},
	holdThresholdMs: DEFAULT_HOLD_THRESHOLD_MS,
	sendWait: null,
	tabCyclesMode: false,

	/**
	 * Once, and only once.
	 *
	 * Several surfaces call this on mount (the HUD, the Settings panel), and the
	 * read is async: a second load whose disk read resolves after the user has
	 * flipped a toggle would silently put the toggle back. This store is the only
	 * writer of the `ui` section, so what is in memory after the first read is
	 * authoritative. `refreshWakePhrases` covers the one section with another
	 * writer.
	 */
	load: async () => {
		if (get().loaded) return;
		const stored = await readVoiceSettingsBlob();
		set({
			...readVoiceUiPrefs(stored.ui),
			wakePhrases: phrasesFromBlob(stored),
			holdThresholdMs: resolveHoldThresholdMs(stored.controls?.holdThresholdMs),
			loaded: true,
		});
	},

	setTranscriptVisible: async (transcriptVisible) => {
		set({ transcriptVisible });
		await persistUi({ transcriptVisible });
	},

	toggleTranscript: async () => {
		await get().setTranscriptVisible(!get().transcriptVisible);
	},

	setHudPosition: async (hudPosition) => {
		set({ hudPosition });
		await persistUi({ hudPosition });
	},

	setMinimizeBehavior: async (minimizeBehavior) => {
		set({ minimizeBehavior });
		await persistUi({ minimizeBehavior });
	},

	setMinimized: (minimized) => set({ minimized }),

	setMuted: (muted) => set({ muted }),

	setListenMode: async (listenMode) => {
		set({ listenMode });
		await persistUi({ listenMode });
	},

	refreshSendWait: async () => {
		set({ sendWait: await window.maestro.voice.getSendWait() });
	},

	setSendWait: async (waitMs) => {
		set({ sendWait: await window.maestro.voice.setSendWait(waitMs) });
	},

	setSendPhrases: async (phrases) => {
		await patchVoiceSettingsSection('controls', { sendPhrases: phrases });
		// Main parses the stored string, so the list the HUD shows is re-read from
		// it rather than re-derived here: one parser, and the mirror cannot drift.
		await get().refreshSendWait();
	},

	setTabCyclesMode: (tabCyclesMode) => set({ tabCyclesMode }),

	refreshWakePhrases: async () => {
		set({ wakePhrases: phrasesFromBlob(await readVoiceSettingsBlob()) });
	},
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** This agent's wake phrase, or null. Subscribes to one key, not the whole map. */
export const selectWakePhraseFor =
	(agentSessionId: string) =>
	(s: VoiceUiStore): string | null =>
		s.wakePhrases[agentSessionId] ?? null;

/**
 * Whether the voice HUD will cycle Tab / Agent / Conductor on the next Tab press.
 *
 * For a text surface that swallows Tab only to keep focus from wandering - the
 * AI composer does - and has no use for the key itself. The HUD's listener runs
 * in the bubble phase and stands down for a key somebody already claimed, so
 * such a surface asks this first and lets the key through. A surface that USES
 * Tab (a completion popup, a shell line, an editor's indent) never asks, and
 * keeps it.
 */
export function voiceHudClaimsTab(): boolean {
	return useVoiceUiStore.getState().tabCyclesMode;
}
