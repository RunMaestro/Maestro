/**
 * The A Cappella provider selection, persisted in the `acappella` settings blob.
 *
 * That blob is the same one `readVoiceProviderSettings()` reads in main, so this
 * hook writes what the provider registry and the capability gate already know how
 * to read. It deliberately does NOT add top-level settings keys: A Cappella's
 * configuration is one object, and splitting it across the settings store,
 * `settingsMetadata`, and `defaults.ts` would mean four places to keep in step
 * for a value only these panels and the voice session ever read.
 *
 * Provider ids come from the shared catalog rather than being spelled out here.
 * They used to be copied as literals because the capability gate reaches for
 * `electron` and the model store, which the renderer must not pull in; the
 * catalog is the pure-data half that both sides can import, and it is the only
 * reason a slot the gate blocks and a panel that says "ready" cannot disagree.
 */

import { useCallback, useEffect, useState } from 'react';
import { Brain, MessageSquare, Volume2, type LucideIcon } from 'lucide-react';

import {
	KOKORO_82M_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
} from '../../../../shared/acappella/model-catalog';
import {
	HOSTED_PROVIDER_IDS,
	LOCAL_PROVIDER_IDS,
	getVoiceProvider,
} from '../../../../shared/acappella/provider-catalog';
import type { VoicePipelineShape, VoiceProviderRole } from '../../../../shared/acappella/providers';

/** Where a slot runs. `hosted` is a stated choice, never a fallback. */
export type VoiceSlotMode = 'local' | 'cloud';

/** Settings key holding everything A Cappella persists. Mirrors the main-side constant. */
const ACAPPELLA_SETTINGS_KEY = 'acappella';

/**
 * What an unconfigured slot runs.
 *
 * The mock tier, matching `DEFAULT_PROVIDER_IDS` in the registry, because that is
 * the truth: A Cappella ships on the mock until the user picks something. Showing
 * "Local" for a slot that is actually running the mock would be the panel telling
 * a comfortable lie about a privacy-relevant fact.
 */
export const DEFAULT_SLOT_PROVIDER_IDS: Record<VoiceProviderRole, string> = {
	stt: 'mock-stt',
	tts: 'mock-tts',
	brain: 'mock-brain',
};

export interface VoiceSlotDefinition {
	slot: VoiceProviderRole;
	label: string;
	title: string;
	description: string;
	modelId: string;
	icon: LucideIcon;
}

/** The three independent slots, in the order the panels render them. */
export const SLOT_DEFINITIONS: readonly VoiceSlotDefinition[] = [
	{
		slot: 'stt',
		label: 'Speech-to-Text',
		title: 'Where your speech is transcribed',
		description:
			'Local keeps every sample of your voice on this machine. Hosted sends audio to a service you configure.',
		modelId: WHISPER_BASE_EN_ID,
		icon: MessageSquare,
	},
	{
		slot: 'tts',
		label: 'Text-to-Speech',
		title: 'Where replies are spoken from',
		description:
			'Local synthesises on this machine. Hosted streams audio back from a service you configure.',
		modelId: KOKORO_82M_ID,
		icon: Volume2,
	},
	{
		slot: 'brain',
		label: 'Conductor Brain',
		title: 'What decides which agent you meant',
		description:
			'Local runs a small model here. Hosted uses an API model, which is faster to set up and costs per request.',
		modelId: QWEN3_1_7B_ID,
		icon: Brain,
	},
];

export interface VoiceProviderSelection {
	/** What each slot is set to. Unset slots report the mock tier's id. */
	providerIds: Record<VoiceProviderRole, string>;
	setProvider: (slot: VoiceProviderRole, providerId: string) => Promise<void>;
	pipeline: VoicePipelineShape;
	setPipeline: (shape: VoicePipelineShape) => Promise<void>;
	/** Voice for the TTS slot, when its provider offers a choice. */
	voiceId: string | null;
	setVoiceId: (voiceId: string) => Promise<void>;
	/** Speech rate. 1 is the provider's natural pace. */
	rate: number;
	setRate: (rate: number) => Promise<void>;
	/** Local or cloud per slot, derived from the selected provider's tier. */
	modes: Record<VoiceProviderRole, VoiceSlotMode>;
	setMode: (slot: VoiceProviderRole, mode: VoiceSlotMode) => Promise<void>;
	/** False until the stored blob has been read, so a panel can say so. */
	loaded: boolean;
	/**
	 * Set when the running session refused to pick the change up yet. The setting
	 * IS saved; it takes effect at the end of the turn.
	 */
	notice: string | null;
}

const DEFAULT_RATE = 1;

interface StoredBlob {
	providers?: Record<string, unknown>;
	pipeline?: unknown;
	voice?: { voiceId?: unknown; rate?: unknown };
	[key: string]: unknown;
}

function modeForProviderId(providerId: string): VoiceSlotMode {
	return getVoiceProvider(providerId)?.tier === 'cloud' ? 'cloud' : 'local';
}

export function useVoiceProviderSelection(enabled: boolean): VoiceProviderSelection {
	const [providerIds, setProviderIds] =
		useState<Record<VoiceProviderRole, string>>(DEFAULT_SLOT_PROVIDER_IDS);
	const [pipeline, setPipelineState] = useState<VoicePipelineShape>('cascade');
	const [voiceId, setVoiceIdState] = useState<string | null>(null);
	const [rate, setRateState] = useState(DEFAULT_RATE);
	const [loaded, setLoaded] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const stored = (await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) as
				| StoredBlob
				| undefined;
			if (cancelled) return;

			const providers = stored?.providers ?? {};
			setProviderIds({
				stt: asId(providers.stt) ?? DEFAULT_SLOT_PROVIDER_IDS.stt,
				tts: asId(providers.tts) ?? DEFAULT_SLOT_PROVIDER_IDS.tts,
				brain: asId(providers.brain) ?? DEFAULT_SLOT_PROVIDER_IDS.brain,
			});
			setPipelineState(stored?.pipeline === 'realtime' ? 'realtime' : 'cascade');
			setVoiceIdState(asId(stored?.voice?.voiceId) ?? null);
			setRateState(typeof stored?.voice?.rate === 'number' ? stored.voice.rate : DEFAULT_RATE);
			setLoaded(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [enabled]);

	/**
	 * Read-modify-write against the whole blob, then tell the running app.
	 *
	 * A Cappella keeps more than providers in there, so writing only the field
	 * being changed would drop the rest. The `applyProviders` call is what makes a
	 * change take effect without a restart; it can come back refused, which is
	 * correct and which the panel surfaces rather than retrying.
	 */
	const persist = useCallback(async (mutate: (blob: StoredBlob) => void) => {
		const stored = ((await window.maestro.settings.get(ACAPPELLA_SETTINGS_KEY)) ??
			{}) as StoredBlob;
		const next: StoredBlob = { ...stored, providers: { ...(stored.providers ?? {}) } };
		mutate(next);
		await window.maestro.settings.set(ACAPPELLA_SETTINGS_KEY, next);

		// The setting is saved either way; what can be refused is applying it to a
		// session that is mid-turn. That refusal is surfaced rather than swallowed:
		// a user who changed a voice and heard the old one needs to know why.
		const applied = await window.maestro.voice
			.applyProviders()
			.catch(() => ({ status: 'unchanged' as const, reason: undefined }));
		setNotice(applied.status === 'refused' ? (applied.reason ?? null) : null);
	}, []);

	const setProvider = useCallback(
		async (slot: VoiceProviderRole, providerId: string) => {
			setProviderIds((prev) => ({ ...prev, [slot]: providerId }));
			await persist((blob) => {
				blob.providers = { ...(blob.providers ?? {}), [slot]: providerId };
			});
		},
		[persist]
	);

	const setPipeline = useCallback(
		async (shape: VoicePipelineShape) => {
			setPipelineState(shape);
			await persist((blob) => {
				blob.pipeline = shape;
			});
		},
		[persist]
	);

	const setVoiceId = useCallback(
		async (next: string) => {
			setVoiceIdState(next);
			await persist((blob) => {
				blob.voice = { ...(blob.voice ?? {}), voiceId: next };
			});
		},
		[persist]
	);

	const setRate = useCallback(
		async (next: number) => {
			setRateState(next);
			await persist((blob) => {
				blob.voice = { ...(blob.voice ?? {}), rate: next };
			});
		},
		[persist]
	);

	const setMode = useCallback(
		async (slot: VoiceProviderRole, mode: VoiceSlotMode) => {
			await setProvider(
				slot,
				mode === 'cloud' ? HOSTED_PROVIDER_IDS[slot] : LOCAL_PROVIDER_IDS[slot]
			);
		},
		[setProvider]
	);

	return {
		providerIds,
		setProvider,
		pipeline,
		setPipeline,
		voiceId,
		setVoiceId,
		rate,
		setRate,
		modes: {
			stt: modeForProviderId(providerIds.stt),
			tts: modeForProviderId(providerIds.tts),
			brain: modeForProviderId(providerIds.brain),
		},
		setMode,
		loaded,
		notice,
	};
}

function asId(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
