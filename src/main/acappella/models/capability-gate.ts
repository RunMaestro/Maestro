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
import type { NativeRuntimeId } from '../../../shared/acappella/native-runtimes';
import type { MicPermission } from '../../../shared/acappella/protocol';
import type {
	VoiceReadiness,
	VoiceSlot,
	VoiceSlotReadiness,
} from '../../../shared/acappella/readiness';
import { getMicPermission } from '../permissions/mic-permission';
import { lastNativeRuntimeFailure, type NativeRuntimeUnavailable } from '../runtime/native-loader';
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

/**
 * The microphone slot's "provider" id.
 *
 * The device is not a provider and there is nothing to choose here, but the slot
 * carries an id so the structure stays uniform for every consumer that renders
 * `slots` and `blocking` generically.
 */
export const MICROPHONE_PROVIDER_ID = 'system-microphone';

/** What a provider needs before it can run. */
type ProviderRequirement =
	| { kind: 'model'; modelId: string; runtimeId?: NativeRuntimeId }
	| { kind: 'api-key'; settingsKey: string; serviceLabel: string }
	| { kind: 'none' };

/**
 * The requirement table. Anything absent needs nothing, which is the mock tier's
 * contract: it opens no device, downloads nothing, and is always ready.
 *
 * A local provider needs BOTH its model and its native runtime, and the runtime
 * is checked first: a llama.cpp binary that will not load on this machine is not
 * fixed by downloading another gigabyte, so telling the user to download is the
 * wrong instruction even though the model may also be missing.
 */
const PROVIDER_REQUIREMENTS: Record<string, ProviderRequirement> = {
	[LOCAL_PROVIDER_IDS.stt]: { kind: 'model', modelId: WHISPER_BASE_EN_ID, runtimeId: 'whisper' },
	[LOCAL_PROVIDER_IDS.tts]: { kind: 'model', modelId: KOKORO_82M_ID, runtimeId: 'onnx' },
	[LOCAL_PROVIDER_IDS.brain]: { kind: 'model', modelId: QWEN3_1_7B_ID, runtimeId: 'llama' },
	[WAKE_WORD_PROVIDER_ID]: { kind: 'model', modelId: OPENWAKEWORD_BASE_ID, runtimeId: 'onnx' },
	'openai-realtime': { kind: 'api-key', settingsKey: 'openaiApiKey', serviceLabel: 'OpenAI' },
	'elevenlabs-tts': {
		kind: 'api-key',
		settingsKey: 'elevenLabsApiKey',
		serviceLabel: 'ElevenLabs',
	},
};

/**
 * Slot order, which is also the order Voice Setup renders and errors list them.
 *
 * The microphone comes first because it is the one requirement that is true
 * regardless of which providers are configured, and because a user who reads
 * "microphone access denied" first does not need to read the rest.
 */
const SLOT_ORDER: VoiceSlot[] = ['microphone', 'stt', 'tts', 'brain', 'wake-word'];

const SLOT_LABELS: Record<VoiceSlot, string> = {
	microphone: 'Microphone',
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
	/**
	 * The microphone permission. Defaults to the real OS query, which never
	 * prompts: readiness is resolved on every Settings render, and a gate that
	 * could raise a TCC dialog would turn drawing a panel into asking for the
	 * microphone.
	 */
	readMicPermission?: () => MicPermission;
	/**
	 * The last known native runtime failure, or null. Defaults to the loader's
	 * memory of what has already failed in this process; it deliberately does NOT
	 * attempt a load, because dlopen'ing an inference engine to draw a settings
	 * panel is exactly the startup cost the lazy loader exists to avoid.
	 */
	readRuntimeFailure?: (runtimeId: NativeRuntimeId) => NativeRuntimeUnavailable | null;
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
		if (slot === 'microphone') {
			slots.push(resolveMicrophone(options));
			continue;
		}
		const providerId = providerForSlot(slot, settings);
		slots.push(await resolveSlot(slot, providerId, options, readModelStatus));
	}

	const wakeWord = slots.find((slot) => slot.slot === 'wake-word');
	// A session needs a microphone, speech in, speech out, and routing. The wake
	// word is a hands-free capability, not a precondition for talking.
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
	if (slot === 'microphone') return MICROPHONE_PROVIDER_ID;
	return settings[slot] ?? DEFAULT_PROVIDER_IDS[slot];
}

/**
 * The microphone slot.
 *
 * Only `denied` and `restricted` block. `not-determined` and `unknown` are the
 * states of a machine that has never been asked, and blocking on them would mean
 * a first-run user is told voice is unavailable BEFORE the app has done the one
 * thing that would make it available. The ask happens at session start, in
 * `requestMicPermission()`, which is the moment the user asked for a microphone.
 */
function resolveMicrophone(options: ResolveVoiceReadinessOptions): VoiceSlotReadiness {
	const readPermission = options.readMicPermission ?? (() => getMicPermission().state);
	const permission = readPermission();
	const base = {
		slot: 'microphone' as const,
		providerId: MICROPHONE_PROVIDER_ID,
		micPermission: permission,
	};

	if (permission === 'denied') {
		return {
			...base,
			satisfied: false,
			reason: 'mic-permission-denied',
			// Named as a permission, never as "voice unavailable": a user with every
			// model on disk and a denied microphone has a one-checkbox problem, and
			// this sentence is the difference between fixing it and filing a bug.
			detail: 'Microphone: Maestro does not have microphone access.',
			suggestedAction: 'Grant microphone access to Maestro in your system privacy settings.',
		};
	}

	if (permission === 'restricted') {
		return {
			...base,
			satisfied: false,
			reason: 'mic-permission-restricted',
			detail: 'Microphone: access is blocked by a system policy.',
			// No privacy-pane link here on purpose. The user cannot change this one,
			// so sending them to a checkbox they are not allowed to tick is a dead end.
			suggestedAction: 'A device policy controls this. Ask whoever manages this machine.',
		};
	}

	return { ...base, satisfied: true };
}

/**
 * A native runtime that has already failed to load in this process, as a slot
 * verdict. Null when the runtime has never failed, which includes "never tried".
 */
function runtimeFailureFor(
	slot: VoiceSlot,
	providerId: string,
	runtimeId: NativeRuntimeId,
	options: ResolveVoiceReadinessOptions
): VoiceSlotReadiness | null {
	const read = options.readRuntimeFailure ?? lastNativeRuntimeFailure;
	const failure = read(runtimeId);
	if (!failure) return null;

	return {
		slot,
		providerId,
		satisfied: false,
		reason: 'runtime-unavailable',
		detail: `${SLOT_LABELS[slot]}: ${failure.message}`,
		suggestedAction: failure.suggestedAction,
	};
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
		// Runtime before model. A binary that will not load on this machine is not
		// repaired by a download, and "download 1.1 GB" is the wrong instruction to
		// give someone whose real problem is a missing redistributable.
		if (requirement.runtimeId) {
			const runtimeVerdict = runtimeFailureFor(slot, providerId, requirement.runtimeId, options);
			if (runtimeVerdict) return runtimeVerdict;
		}

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
