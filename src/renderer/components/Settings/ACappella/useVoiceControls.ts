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
	DEFAULT_TURN_SETTLE_MS,
	clampTurnSettleMs,
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFAULT_STOP_PHRASE,
	DEFAULT_WAKE_DEBOUNCE_MS,
	DEFAULT_WAKE_PHRASE,
	DEFAULT_WAKE_SENSITIVITY,
} from '../../../../shared/acappella/voice-controls';
import { useVoiceUiStore } from '../../../stores/voiceUiStore';

/** The idle timeout in the unit the panel shows. Stored in ms, shown in seconds. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = DEFAULT_IDLE_TIMEOUT_MS / 1000;

/** Settings key holding everything A Cappella persists. Mirrors the main-side constant. */
const ACAPPELLA_SETTINGS_KEY = 'acappella';

/** One agent's wake phrase, so saying it jumps straight into that agent's context. */
export interface AgentWakePhrase {
	agentSessionId: string;
	phrase: string;
}

export interface VoiceControlSettings {
	/** Whether the always-local wake detector runs at all. */
	wakeWordEnabled: boolean;
	/** The global phrase, bound to the Conductor. */
	wakePhrase: string;
	/** 0 to 1. Higher fires more easily. */
	wakeSensitivity: number;
	/** Minimum gap between two hits of the same phrase. */
	wakeDebounceMs: number;
	/** Per-agent phrases, keyed by agent session id. */
	agentPhrases: AgentWakePhrase[];
	/** The configurable stop phrase. "nevermind" is always armed alongside it. */
	stopPhrase: string;
	stopWordEnabled: boolean;
	/** Below this a hotkey press is a tap; above it, a hold. */
	holdThresholdMs: number;
	/** Silence after a sentence before it counts as a finished thought. */
	turnSettleMs: number;
	/** Listening silence that closes the session. Seconds in the UI, ms on disk. */
	idleTimeoutSeconds: number;
}

export const DEFAULT_VOICE_CONTROLS: VoiceControlSettings = {
	wakeWordEnabled: false,
	wakePhrase: DEFAULT_WAKE_PHRASE,
	wakeSensitivity: DEFAULT_WAKE_SENSITIVITY,
	wakeDebounceMs: DEFAULT_WAKE_DEBOUNCE_MS,
	agentPhrases: [],
	stopPhrase: DEFAULT_STOP_PHRASE,
	stopWordEnabled: true,
	holdThresholdMs: DEFAULT_HOLD_THRESHOLD_MS,
	turnSettleMs: DEFAULT_TURN_SETTLE_MS,
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

interface StoredBlob {
	controls?: Record<string, unknown>;
	[key: string]: unknown;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim() ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asAgentPhrases(value: unknown): AgentWakePhrase[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(entry): entry is AgentWakePhrase =>
				!!entry &&
				typeof (entry as AgentWakePhrase).agentSessionId === 'string' &&
				typeof (entry as AgentWakePhrase).phrase === 'string'
		)
		.map((entry) => ({ agentSessionId: entry.agentSessionId, phrase: entry.phrase }));
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
		agentPhrases: asAgentPhrases(raw.agentPhrases),
		stopPhrase: asString(raw.stopPhrase, DEFAULT_VOICE_CONTROLS.stopPhrase),
		stopWordEnabled: raw.stopWordEnabled !== false,
		holdThresholdMs: asNumber(raw.holdThresholdMs, DEFAULT_VOICE_CONTROLS.holdThresholdMs),
		turnSettleMs: clampTurnSettleMs(raw.turnSettleMs),
		// Stored in milliseconds because that is what `FloorControlConfig` speaks;
		// shown in seconds because that is what people speak.
		idleTimeoutSeconds: Math.round(asNumber(raw.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS) / 1000),
	};
}

export function useVoiceControls(enabled: boolean): VoiceControls {
	const [settings, setSettings] = useState<VoiceControlSettings>(DEFAULT_VOICE_CONTROLS);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const stored = (await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) as
				| StoredBlob
				| undefined;
			if (cancelled) return;
			setSettings(readVoiceControls(stored?.controls));
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	/**
	 * Read-modify-write against the whole blob.
	 *
	 * A Cappella keeps providers, voices, and controls in one object, so writing
	 * only the section being changed would drop the rest. The idle timeout is
	 * stored in MILLISECONDS because that is the unit `FloorControlConfig` speaks;
	 * the panel shows seconds because that is the unit people speak.
	 */
	const persist = useCallback(async (next: VoiceControlSettings) => {
		const stored = ((await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) ??
			{}) as StoredBlob;
		await window.maestro.settings.set(ACAPPELLA_SETTINGS_KEY, {
			...stored,
			controls: {
				...(stored.controls ?? {}),
				wakeWordEnabled: next.wakeWordEnabled,
				wakePhrase: next.wakePhrase,
				wakeSensitivity: next.wakeSensitivity,
				wakeDebounceMs: next.wakeDebounceMs,
				agentPhrases: next.agentPhrases,
				stopPhrase: next.stopPhrase,
				stopWordEnabled: next.stopWordEnabled,
				holdThresholdMs: next.holdThresholdMs,
				turnSettleMs: next.turnSettleMs,
				idleTimeoutMs: Math.max(0, Math.round(next.idleTimeoutSeconds * 1000)),
			},
		});
	}, []);

	/**
	 * Next state is computed from the CURRENT render's settings rather than
	 * inside the state updater. An updater that also wrote to disk would run
	 * twice under StrictMode and persist the same change twice.
	 */
	const update = useCallback(
		async (patch: Partial<VoiceControlSettings>) => {
			const next = { ...settings, ...patch };
			setSettings(next);
			await persist(next);
		},
		[persist, settings]
	);

	const setAgentPhrase = useCallback(
		async (agentSessionId: string, phrase: string) => {
			const rest = settings.agentPhrases.filter((entry) => entry.agentSessionId !== agentSessionId);
			// A blank phrase removes the assignment rather than storing an empty one:
			// a phrase nobody can say would arm a classifier that never fires.
			const agentPhrases = phrase.trim()
				? [...rest, { agentSessionId, phrase: phrase.trim() }]
				: rest;
			const next = { ...settings, agentPhrases };
			setSettings(next);
			await persist(next);
			// The Left Bar draws a badge per agent from a mirror of this list. There
			// is no settings-change broadcast, so the one writer tells it directly -
			// otherwise a phrase just assigned shows no badge until the next restart.
			await useVoiceUiStore.getState().refreshWakePhrases();
		},
		[persist, settings]
	);

	return { ...settings, update, setAgentPhrase, loaded };
}
