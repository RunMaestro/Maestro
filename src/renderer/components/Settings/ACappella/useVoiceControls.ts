/**
 * The A Cappella voice-control settings: wake word, stop word, and floor timing.
 *
 * Persisted under `controls` inside the same `acappella` settings blob the
 * provider selection uses, and read back in main by
 * `readVoiceControlSettings()`. Same reasoning as
 * `useVoiceProviderSelection`: A Cappella's configuration is ONE object, and
 * splitting a wake phrase across `settingsMetadata`, `defaults.ts`, and the
 * settings store would mean four files to keep in step for a value only this
 * panel and the voice session ever read.
 *
 * The two hotkeys are the exception and deliberately do NOT live here. They are
 * in the ordinary `shortcuts` map, so the Shortcuts tab rebinds them like any
 * other key and there is one persisted binding rather than two that can disagree.
 */

import { useCallback, useEffect, useState } from 'react';

import {
	DEFAULT_HOLD_THRESHOLD_MS,
	DEFAULT_CONVERSATIONAL_MODE,
	DEFAULT_SEND_PHRASES,
	formatSendPhrases,
	isLegacyDefaultSendPhrases,
	DEFAULT_HOLD_UNTIL_SEND,
	DEFAULT_SEND_HOLD_MS,
	clampSendHoldMs,
	DEFAULT_TURN_SETTLE_MS,
	clampTurnSettleMs,
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFAULT_STOP_PHRASE,
	DEFAULT_WAKE_DEBOUNCE_MS,
	DEFAULT_WAKE_PHRASE,
	DEFAULT_WAKE_SENSITIVITY,
	DEFAULT_WAKE_ENGINE,
	asWakeEngine,
	type WakeEngine,
} from '../../../../shared/acappella/voice-controls';
import {
	readAgentWakePhrases,
	withAgentWakePhrase,
	type AgentWakePhrase,
} from '../../../../shared/acappella/voice-settings-schema';
import { patchVoiceSettingsSection, readVoiceSettingsBlob } from '../../../services/voiceSettings';
import { useVoiceUiStore } from '../../../stores/voiceUiStore';

/** The idle timeout in the unit the panel shows. Stored in ms, shown in seconds. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = DEFAULT_IDLE_TIMEOUT_MS / 1000;

// One agent's wake phrase, so saying it jumps straight into that agent's
// context. The type and the two rules about the stored list (what a malformed
// entry reads as, and how one agent's entry is rewritten) are shared with
// `maestro-cli voice wake-phrase`, which writes the same list.
export type { AgentWakePhrase };

export interface VoiceControlSettings {
	/** Whether the always-local wake detector runs at all. */
	wakeWordEnabled: boolean;
	/** The global phrase, bound to the Conductor. */
	wakePhrase: string;
	/** 0 to 1. Higher fires more easily. */
	wakeSensitivity: number;
	/** Minimum gap between two hits of the same phrase. */
	wakeDebounceMs: number;
	/** Trained classifier (default) or transcription matching. See `WakeEngine`. */
	wakeEngine: WakeEngine;
	/** Per-agent phrases, keyed by agent session id. */
	agentPhrases: AgentWakePhrase[];
	/** The configurable stop phrase. "nevermind" is always armed alongside it. */
	stopPhrase: string;
	stopWordEnabled: boolean;
	/** Below this a hotkey press is a tap; above it, a hold. */
	holdThresholdMs: number;
	/** Silence after a sentence before it counts as a finished thought. */
	turnSettleMs: number;
	/** Whether the Conductor talks with you before dispatching anything. */
	conversationalMode: boolean;
	/** Whether a request waits for a spoken send phrase rather than for silence. */
	holdUntilSend: boolean;
	/** The pause that sends a held request when no phrase was said. */
	sendHoldMs: number;
	/** Comma-separated phrases that mean "send it". Blank turns the spoken send off. */
	sendPhrases: string;
	/** Listening silence that closes the session. Seconds in the UI, ms on disk. */
	idleTimeoutSeconds: number;
}

export const DEFAULT_VOICE_CONTROLS: VoiceControlSettings = {
	wakeWordEnabled: false,
	wakePhrase: DEFAULT_WAKE_PHRASE,
	wakeSensitivity: DEFAULT_WAKE_SENSITIVITY,
	wakeDebounceMs: DEFAULT_WAKE_DEBOUNCE_MS,
	wakeEngine: DEFAULT_WAKE_ENGINE,
	agentPhrases: [],
	stopPhrase: DEFAULT_STOP_PHRASE,
	stopWordEnabled: true,
	holdThresholdMs: DEFAULT_HOLD_THRESHOLD_MS,
	turnSettleMs: DEFAULT_TURN_SETTLE_MS,
	conversationalMode: DEFAULT_CONVERSATIONAL_MODE,
	holdUntilSend: DEFAULT_HOLD_UNTIL_SEND,
	sendHoldMs: DEFAULT_SEND_HOLD_MS,
	sendPhrases: formatSendPhrases(DEFAULT_SEND_PHRASES),
	idleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
};

export interface VoiceControls extends VoiceControlSettings {
	/** Patch one or more fields. Read-modify-write against the whole blob. */
	update: (patch: Partial<VoiceControlSettings>) => Promise<void>;
	/** Set (or clear, with an empty phrase) one agent's wake phrase. */
	setAgentPhrase: (agentSessionId: string, phrase: string) => Promise<void>;
	/** False until the stored blob has been read, so a panel can say so. */
	loaded: boolean;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim() ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Widen a stored `controls` object into a complete settings object. */
export function readVoiceControls(
	stored: Record<string, unknown> | undefined
): VoiceControlSettings {
	const raw = stored ?? {};
	return {
		wakeWordEnabled: raw.wakeWordEnabled === true,
		wakePhrase: asString(raw.wakePhrase, DEFAULT_VOICE_CONTROLS.wakePhrase),
		wakeSensitivity: asNumber(raw.wakeSensitivity, DEFAULT_VOICE_CONTROLS.wakeSensitivity),
		wakeDebounceMs: asNumber(raw.wakeDebounceMs, DEFAULT_VOICE_CONTROLS.wakeDebounceMs),
		wakeEngine: asWakeEngine(raw.wakeEngine),
		agentPhrases: readAgentWakePhrases(raw.agentPhrases),
		stopPhrase: asString(raw.stopPhrase, DEFAULT_VOICE_CONTROLS.stopPhrase),
		stopWordEnabled: raw.stopWordEnabled !== false,
		holdThresholdMs: asNumber(raw.holdThresholdMs, DEFAULT_VOICE_CONTROLS.holdThresholdMs),
		turnSettleMs: clampTurnSettleMs(raw.turnSettleMs),
		conversationalMode: raw.conversationalMode === true,
		holdUntilSend: raw.holdUntilSend === true,
		sendHoldMs: clampSendHoldMs(raw.sendHoldMs),
		// An absent value takes the defaults; a stored empty string is a deliberate
		// "no spoken send", so the two must not collapse into each other. The old
		// shipped list reads as absent too: the startup migration clears it, and
		// this covers a blob read before that has run.
		sendPhrases:
			typeof raw.sendPhrases === 'string' && !isLegacyDefaultSendPhrases(raw.sendPhrases)
				? raw.sendPhrases
				: DEFAULT_VOICE_CONTROLS.sendPhrases,
		// Stored in milliseconds because that is what `FloorControlConfig` speaks;
		// shown in seconds because that is what people speak.
		idleTimeoutSeconds: Math.round(asNumber(raw.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS) / 1000),
	};
}

/**
 * A patch of panel fields as the fields `controls` stores.
 *
 * The same names, with one exception: the idle timeout is stored in
 * MILLISECONDS because that is the unit `FloorControlConfig` speaks, and shown
 * in seconds because that is the unit people speak.
 */
export function toStoredControls(patch: Partial<VoiceControlSettings>): Record<string, unknown> {
	const { idleTimeoutSeconds, ...stored } = patch;
	return idleTimeoutSeconds === undefined
		? stored
		: { ...stored, idleTimeoutMs: Math.max(0, Math.round(idleTimeoutSeconds * 1000)) };
}

export function useVoiceControls(enabled: boolean): VoiceControls {
	const [settings, setSettings] = useState<VoiceControlSettings>(DEFAULT_VOICE_CONTROLS);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const stored = await readVoiceSettingsBlob();
			if (cancelled) return;
			setSettings(readVoiceControls(stored.controls));
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	/**
	 * Next state is computed from the CURRENT render's settings rather than
	 * inside the state updater. An updater that also wrote to disk would run
	 * twice under StrictMode and persist the same change twice.
	 *
	 * Only the patched fields are written (`toStoredControls`). This used to save
	 * all fifteen on every change, which froze every default the panel happened
	 * to be showing into the user's settings the first time they moved a slider.
	 */
	const update = useCallback(
		async (patch: Partial<VoiceControlSettings>) => {
			setSettings({ ...settings, ...patch });
			await patchVoiceSettingsSection('controls', toStoredControls(patch));
		},
		[settings]
	);

	const setAgentPhrase = useCallback(
		async (agentSessionId: string, phrase: string) => {
			// A blank phrase removes the assignment (see `withAgentWakePhrase`).
			const agentPhrases = withAgentWakePhrase(settings.agentPhrases, agentSessionId, phrase);
			setSettings({ ...settings, agentPhrases });
			await patchVoiceSettingsSection('controls', { agentPhrases });
			// The Left Bar draws a badge per agent from a mirror of this list. There
			// is no settings-change broadcast, so the one writer tells it directly -
			// otherwise a phrase just assigned shows no badge until the next restart.
			await useVoiceUiStore.getState().refreshWakePhrases();
		},
		[settings]
	);

	return { ...settings, update, setAgentPhrase, loaded };
}
