/**
 * A Cappella capability gate - may voice mode run, and if not, exactly why.
 *
 * This module answers one question with a structured verdict rather than a
 * boolean, because a boolean is what produces the two failure modes A Cappella
 * cannot ship with:
 *
 *   1. **Silent substitution.** "Local Whisper is missing, so use the cloud one"
 *      spends the user's money and ships their microphone to a service they did
 *      not choose. There is no code path in this file that can do that: a slot is
 *      satisfied by the provider it was configured with or it is UNSATISFIED. It
 *      never resolves to a different provider, and it never returns a provider at
 *      all - it returns a verdict. Choosing providers is the registry's job, and
 *      the registry's only fallback is the mock.
 *   2. **A disabled button with no explanation.** "Voice mode unavailable" with
 *      no reason is indistinguishable from a bug. Every unsatisfied slot carries
 *      a reason code, a sentence naming the missing piece, and a suggested action.
 *
 * The wake word is reported but does not block a session. Hands-free means
 * something is always listening, and that is a real capability with a real
 * requirement; click-to-talk is not, and refusing to open a session the user
 * explicitly asked for because an optional always-on model is missing would be
 * the gate getting in the way rather than doing its job.
 */

import {
	KOKORO_82M_ID,
	OPENWAKEWORD_BASE_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
	getVoiceModel,
} from '../../../shared/acappella/model-catalog';
import type {
	VoiceReadiness,
	VoiceSlot,
	VoiceSlotReadiness,
} from '../../../shared/acappella/readiness';
import { DEFAULT_PROVIDER_IDS, type VoiceProviderSettings } from '../providers/provider-registry';
import { getStatus, type ModelStatus } from './model-store';

/**
 * Provider ids for the local tier.
 *
 * Declared here rather than in the registry so the requirement table and the
 * registrations that Phases 05 and 07 add cannot drift into two different
 * spellings of the same provider. A local provider whose id is not in
 * {@link PROVIDER_REQUIREMENTS} is treated as needing nothing, which is correct
 * for the mock tier and wrong for a real one, so a new local provider MUST be
 * added below in the same change that registers it.
 */
export const LOCAL_PROVIDER_IDS = {
	stt: 'whisper-local',
	tts: 'kokoro-local',
	brain: 'qwen3-local',
} as const;

/** The wake word slot has one implementation and it is always local. */
export const WAKE_WORD_PROVIDER_ID = 'openwakeword-local';

/** What a provider needs before it can run. */
type ProviderRequirement =
	| { kind: 'model'; modelId: string }
	| { kind: 'api-key'; settingsKey: string; serviceLabel: string }
	| { kind: 'none' };

/**
 * The requirement table. Anything absent needs nothing, which is the mock tier's
 * contract: it opens no device, downloads nothing, and is always ready.
 */
const PROVIDER_REQUIREMENTS: Record<string, ProviderRequirement> = {
	[LOCAL_PROVIDER_IDS.stt]: { kind: 'model', modelId: WHISPER_BASE_EN_ID },
	[LOCAL_PROVIDER_IDS.tts]: { kind: 'model', modelId: KOKORO_82M_ID },
	[LOCAL_PROVIDER_IDS.brain]: { kind: 'model', modelId: QWEN3_1_7B_ID },
	[WAKE_WORD_PROVIDER_ID]: { kind: 'model', modelId: OPENWAKEWORD_BASE_ID },
	'openai-realtime': { kind: 'api-key', settingsKey: 'openaiApiKey', serviceLabel: 'OpenAI' },
	'elevenlabs-tts': {
		kind: 'api-key',
		settingsKey: 'elevenLabsApiKey',
		serviceLabel: 'ElevenLabs',
	},
};

/** Slot order, which is also the order Voice Setup renders and errors list them. */
const SLOT_ORDER: VoiceSlot[] = ['stt', 'tts', 'brain', 'wake-word'];

const SLOT_LABELS: Record<VoiceSlot, string> = {
	stt: 'Speech-to-Text',
	tts: 'Text-to-Speech',
	brain: 'Conductor Brain',
	'wake-word': 'Wake word',
};

export interface ResolveVoiceReadinessOptions {
	/** The persisted provider selection. Omitted roles take the build default. */
	settings?: VoiceProviderSettings;
	/**
	 * Whether hands-free is switched on. When off, the wake word slot is still
	 * REPORTED (Voice Setup shows what it would need) but nothing is downloaded
	 * or required on its account.
	 */
	handsFreeEnabled?: boolean;
	/** Reads an API key by settings key. Absent means "no keys are configured". */
	getApiKey?: (settingsKey: string) => string | undefined;
	/**
	 * Optional reachability probe for cloud providers, keyed by provider id.
	 * Absent means "assume reachable": a gate that reported every cloud provider
	 * unreachable because nobody wired a probe would be worse than one that lets
	 * the provider's own start() report the truth.
	 */
	probeProvider?: (providerId: string) => Promise<boolean> | boolean;
	/** Injected for tests. Defaults to the real model store. */
	readModelStatus?: (modelId: string) => Promise<ModelStatus>;
}

/**
 * Resolve the readiness of all four slots.
 *
 * Every branch either satisfies the slot with the provider that was ASKED for or
 * marks it unsatisfied. There is deliberately no `else` that reaches for a
 * different provider.
 */
export async function resolveVoiceReadiness(
	options: ResolveVoiceReadinessOptions = {}
): Promise<VoiceReadiness> {
	const settings = options.settings ?? {};
	const readModelStatus = options.readModelStatus ?? getStatus;

	const slots: VoiceSlotReadiness[] = [];
	for (const slot of SLOT_ORDER) {
		const providerId = providerForSlot(slot, settings);
		slots.push(await resolveSlot(slot, providerId, options, readModelStatus));
	}

	const wakeWord = slots.find((slot) => slot.slot === 'wake-word');
	// A session needs speech in, speech out, and routing. The wake word is a
	// hands-free capability, not a precondition for talking.
	const blocking = slots.filter((slot) => slot.slot !== 'wake-word' && !slot.satisfied);

	return {
		canStartSession: blocking.length === 0,
		canRunHandsFree: blocking.length === 0 && (wakeWord?.satisfied ?? false),
		slots,
		blocking,
	};
}

function providerForSlot(slot: VoiceSlot, settings: VoiceProviderSettings): string {
	if (slot === 'wake-word') return WAKE_WORD_PROVIDER_ID;
	return settings[slot] ?? DEFAULT_PROVIDER_IDS[slot];
}

async function resolveSlot(
	slot: VoiceSlot,
	providerId: string,
	options: ResolveVoiceReadinessOptions,
	readModelStatus: (modelId: string) => Promise<ModelStatus>
): Promise<VoiceSlotReadiness> {
	const label = SLOT_LABELS[slot];
	const requirement = PROVIDER_REQUIREMENTS[providerId] ?? { kind: 'none' };

	if (requirement.kind === 'none') {
		return { slot, providerId, satisfied: true };
	}

	if (requirement.kind === 'model') {
		const model = getVoiceModel(requirement.modelId);
		const modelName = model?.displayName ?? requirement.modelId;
		const status = await readModelStatus(requirement.modelId);

		if (status.status === 'installed') {
			return { slot, providerId, satisfied: true, requiredModelId: requirement.modelId };
		}
		if (status.status === 'corrupt') {
			return {
				slot,
				providerId,
				satisfied: false,
				reason: 'model-corrupt',
				requiredModelId: requirement.modelId,
				detail: `${label}: ${modelName} is installed but failed verification${
					status.detail ? ` (${status.detail})` : ''
				}.`,
				suggestedAction: 'Re-verify or re-download it in Settings > Plugins > A Cappella > Models.',
			};
		}
		return {
			slot,
			providerId,
			satisfied: false,
			reason: 'model-not-installed',
			requiredModelId: requirement.modelId,
			detail: `${label}: ${modelName} is not installed.`,
			suggestedAction: 'Download it in Settings > Plugins > A Cappella > Voice Setup.',
		};
	}

	const key = options.getApiKey?.(requirement.settingsKey);
	if (!key || !key.trim()) {
		return {
			slot,
			providerId,
			satisfied: false,
			reason: 'api-key-missing',
			detail: `${label}: ${providerId} needs a ${requirement.serviceLabel} API key.`,
			// Naming the alternative matters: the honest recovery for "no key" is
			// often "use the local model instead", and the gate is the only place
			// that knows both options exist.
			suggestedAction: `Add the key in Settings, or switch ${label} to a local model.`,
		};
	}

	const reachable = (await options.probeProvider?.(providerId)) ?? true;
	if (!reachable) {
		return {
			slot,
			providerId,
			satisfied: false,
			reason: 'provider-unreachable',
			detail: `${label}: ${providerId} could not be reached.`,
			suggestedAction: `Check your connection, or switch ${label} to a local model.`,
		};
	}

	return { slot, providerId, satisfied: true };
}

// Re-exported so a caller that already has the gate does not need a second
// import for the one-line formatting of its verdict.
export { readinessErrorMessage } from '../../../shared/acappella/readiness';
