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

/** Settings key holding everything A Cappella persists. Mirrors the main-side constant. */
const ACAPPELLA_SETTINGS_KEY = 'acappella';

interface StoredBlob {
	ui?: Record<string, unknown>;
	controls?: { agentPhrases?: unknown; holdThresholdMs?: unknown };
	[key: string]: unknown;
}

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
	/** Re-read the wake-phrase mirror after `useVoiceControls` writes one. */
	refreshWakePhrases: () => Promise<void>;
}

export type VoiceUiStore = VoiceUiState & VoiceUiActions;

function phrasesFromBlob(blob: StoredBlob | undefined): Record<string, string> {
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

async function readBlob(): Promise<StoredBlob> {
	return ((await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) ?? {}) as StoredBlob;
}

/**
 * Read-modify-write the `ui` section.
 *
 * Whole-blob, like every other A Cappella writer: providers, voices, controls,
 * and prefs live in one object, so writing only this section would drop the
 * rest.
 */
async function persistUi(patch: Partial<VoiceUiPrefs>): Promise<void> {
	const stored = await readBlob();
	await window.maestro.settings.set(ACAPPELLA_SETTINGS_KEY, {
		...stored,
		ui: { ...(stored.ui ?? {}), ...patch },
	});
}

export const useVoiceUiStore = create<VoiceUiStore>()((set, get) => ({
	...DEFAULT_VOICE_UI_PREFS,
	loaded: false,
	minimized: false,
	muted: false,
	wakePhrases: {},
	holdThresholdMs: DEFAULT_HOLD_THRESHOLD_MS,

	load: async () => {
		const stored = await readBlob();
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

	refreshWakePhrases: async () => {
		set({ wakePhrases: phrasesFromBlob(await readBlob()) });
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
