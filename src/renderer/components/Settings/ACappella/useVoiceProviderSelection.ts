/**
 * The three slot choices, persisted in the `acappella` settings blob.
 *
 * That blob is the same one `readVoiceProviderSettings()` reads in main, so this
 * hook writes what the provider registry and the capability gate already know
 * how to read. It deliberately does NOT add three new top-level settings keys:
 * A Cappella's configuration is one object, and splitting it across the settings
 * store, `settingsMetadata`, and `defaults.ts` would mean four places to keep in
 * step for a value only this panel and the voice session ever read.
 *
 * Local is the default for every slot. Nothing about "cloud" is easier, cheaper,
 * or more private, so it is a choice the user makes rather than one they inherit.
 */

import { useCallback, useEffect, useState } from 'react';
import { Brain, MessageSquare, Volume2, type LucideIcon } from 'lucide-react';

import {
	KOKORO_82M_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
} from '../../../../shared/acappella/model-catalog';
import type { VoiceProviderRole } from '../../../../shared/acappella/providers';

/** Where a slot runs. `cloud` is a stated choice, never a fallback. */
export type VoiceSlotMode = 'local' | 'cloud';

/** Settings key holding everything A Cappella persists. Mirrors the main-side constant. */
const ACAPPELLA_SETTINGS_KEY = 'acappella';

/**
 * Provider ids, kept in step with `capability-gate.ts`. Duplicated as literals
 * rather than imported because that module reaches for `electron` and the model
 * store; the renderer must not pull main-process code into its bundle.
 */
const LOCAL_PROVIDER_IDS: Record<VoiceProviderRole, string> = {
	stt: 'whisper-local',
	tts: 'kokoro-local',
	brain: 'qwen3-local',
};

const CLOUD_PROVIDER_IDS: Record<VoiceProviderRole, string> = {
	stt: 'openai-realtime',
	tts: 'elevenlabs-tts',
	brain: 'openai-realtime',
};

export interface VoiceSlotDefinition {
	slot: VoiceProviderRole;
	label: string;
	title: string;
	description: string;
	modelId: string;
	icon: LucideIcon;
}

/** The three independent slots, in the order Voice Setup renders them. */
export const SLOT_DEFINITIONS: readonly VoiceSlotDefinition[] = [
	{
		slot: 'stt',
		label: 'Speech-to-Text',
		title: 'Where your speech is transcribed',
		description:
			'Local keeps every sample of your voice on this machine. Cloud sends audio to a service you configure.',
		modelId: WHISPER_BASE_EN_ID,
		icon: MessageSquare,
	},
	{
		slot: 'tts',
		label: 'Text-to-Speech',
		title: 'Where replies are spoken from',
		description:
			'Local synthesises on this machine. Cloud streams audio back from a service you configure.',
		modelId: KOKORO_82M_ID,
		icon: Volume2,
	},
	{
		slot: 'brain',
		label: 'Conductor Brain',
		title: 'What decides which agent you meant',
		description:
			'Local runs a small model here. Cloud uses an API model, which is faster to set up and costs per request.',
		modelId: QWEN3_1_7B_ID,
		icon: Brain,
	},
];

export interface VoiceProviderSelection {
	modes: Record<VoiceProviderRole, VoiceSlotMode>;
	setMode: (slot: VoiceProviderRole, mode: VoiceSlotMode) => Promise<void>;
	/** False until the stored blob has been read, so the panel can say so. */
	loaded: boolean;
}

const DEFAULT_MODES: Record<VoiceProviderRole, VoiceSlotMode> = {
	stt: 'local',
	tts: 'local',
	brain: 'local',
};

function modeForProviderId(slot: VoiceProviderRole, providerId: unknown): VoiceSlotMode {
	return providerId === CLOUD_PROVIDER_IDS[slot] ? 'cloud' : 'local';
}

export function useVoiceProviderSelection(enabled: boolean): VoiceProviderSelection {
	const [modes, setModes] = useState<Record<VoiceProviderRole, VoiceSlotMode>>(DEFAULT_MODES);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const stored = (await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) as
				| { providers?: Record<string, unknown> }
				| undefined;
			if (cancelled) return;
			const providers = stored?.providers ?? {};
			setModes({
				stt: modeForProviderId('stt', providers.stt),
				tts: modeForProviderId('tts', providers.tts),
				brain: modeForProviderId('brain', providers.brain),
			});
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	const setMode = useCallback(async (slot: VoiceProviderRole, mode: VoiceSlotMode) => {
		setModes((prev) => ({ ...prev, [slot]: mode }));
		// Read-modify-write against the whole blob: A Cappella keeps more than
		// providers in there, and writing only `providers` would drop the rest.
		const stored = ((await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) ?? {}) as Record<
			string,
			unknown
		>;
		const providers = { ...((stored.providers as Record<string, unknown>) ?? {}) };
		providers[slot] = mode === 'cloud' ? CLOUD_PROVIDER_IDS[slot] : LOCAL_PROVIDER_IDS[slot];
		await window.maestro.settings.set(ACAPPELLA_SETTINGS_KEY, { ...stored, providers });
	}, []);

	return { modes, setMode, loaded };
}
