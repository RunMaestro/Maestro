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
	OPENWAKEWORD_BASE_ID,
	PARAKEET_TDT_V2_ID,
	getLocalModel,
} from '../../../shared/local-models/model-catalog';
import { findPretrainedWakePhrase } from '../../../shared/acappella/voice-models';
import { DEFAULT_WAKE_PHRASE } from '../../../shared/acappella/voice-controls';
import {
	credentialLabel,
	voiceProviderRequirement,
	type VoiceCredentialService,
	type VoiceProviderRequirement,
} from '../../../shared/acappella/provider-catalog';
import type { NativeRuntimeId } from '../../../shared/local-models/native-runtimes';
import type {
	LocalModelTaskReadiness,
	LocalModelTaskUnreadyReason,
} from '../../../shared/local-models/task-readiness';
import type { LocalModelTaskId } from '../../../shared/local-models/tasks';
import {
	modelsSettingsLocation,
	taskAssignmentLocation,
} from '../../../shared/local-models/settings-location';
import { resolveTaskReadiness } from '../../local-models/task-readiness';
import { hasCredential } from '../providers/credentials';
import type { MicPermission } from '../../../shared/acappella/protocol';
import type {
	VoiceReadiness,
	VoiceSlot,
	VoiceSlotReadiness,
	VoiceSlotUnsatisfiedReason,
} from '../../../shared/acappella/readiness';
import { getMicPermission } from '../permissions/mic-permission';
import {
	knownNativeRuntimeUnavailability,
	type NativeRuntimeUnavailable,
} from '../../local-models/runtime/native-loader';
import {
	systemVoiceUnavailability,
	type SystemVoiceUnavailable,
} from '../providers/local/system-tts';
import { DEFAULT_PROVIDER_IDS, type VoiceProviderSettings } from '../providers/provider-registry';
import { getStatus, modelFilePath, type ModelStatus } from '../../local-models/model-store';
import { hasEnrolledWakeModel } from '../wake/wake-enrollment-store';

/**
 * Provider ids for the local tier.
 *
 * Re-exported from the shared catalog rather than re-declared: the requirement
 * table, the registry's registrations, and the settings panel all have to spell
 * a provider id the same way, and three literals in three files is three chances
 * for a slot the gate blocks and the panel says is fine.
 */
export { LOCAL_PROVIDER_IDS } from '../../../shared/acappella/provider-catalog';

/** The wake word slot's classifier engine (openWakeWord). Always local. */
export const WAKE_WORD_PROVIDER_ID = 'openwakeword-local';

/**
 * The wake word slot's transcription engine: Parakeet transcribes each burst of
 * speech and the phrase is matched in the text. Also always local.
 */
export const TRANSCRIPTION_WAKE_PROVIDER_ID = 'transcription-wake-local';

/** The id of the always-present global wake phrase. */
export const GLOBAL_WAKE_PHRASE_ID = 'global';

/**
 * Where a wake phrase's trained classifier lives, or undefined when none exists.
 *
 * openWakeWord is a shared front end (mel spectrogram, embedding) plus one small
 * classifier PER PHRASE. Only the phrases in `PRETRAINED_WAKE_PHRASES` have one,
 * each as its own catalog model; any other phrase is scored by nothing and can
 * never fire. Both the detector that loads the classifier and the gate that
 * reports on it resolve it here. Defined in this module rather than the
 * detector's because the detector already imports this one.
 */
export function wakeClassifierPath(phrase: string): string | undefined {
	const pretrained = findPretrainedWakePhrase(phrase);
	return pretrained ? modelFilePath(pretrained.modelId, pretrained.file) : undefined;
}

/**
 * The microphone slot's "provider" id.
 *
 * The device is not a provider and there is nothing to choose here, but the slot
 * carries an id so the structure stays uniform for every consumer that renders
 * `slots` and `blocking` generically.
 */
export const MICROPHONE_PROVIDER_ID = 'system-microphone';

/**
 * What a provider needs before it can run.
 *
 * Every entry comes from the shared catalog except the wake word, which has no
 * provider slot of its own to be selected in and so is stated here.
 *
 * A local provider needs BOTH its model and its native runtime, and the runtime
 * is checked first: a llama.cpp binary that will not load on this machine is not
 * fixed by downloading another gigabyte, so telling the user to download is the
 * wrong instruction even though the model may also be missing.
 */
function requirementFor(providerId: string): VoiceProviderRequirement {
	if (providerId === WAKE_WORD_PROVIDER_ID) {
		return { kind: 'model', modelId: OPENWAKEWORD_BASE_ID, runtimeId: 'onnx' };
	}
	if (providerId === TRANSCRIPTION_WAKE_PROVIDER_ID) {
		return { kind: 'model', modelId: PARAKEET_TDT_V2_ID, runtimeId: 'onnx' };
	}
	return voiceProviderRequirement(providerId);
}

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
	/**
	 * Whether a service's API key is stored. Defaults to the OS keychain.
	 *
	 * A boolean, not the key: the gate has no business holding a credential, and a
	 * seam that returned one would put keys in every test fixture that configures
	 * a hosted provider.
	 */
	hasApiKey?: (service: VoiceCredentialService) => boolean;
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
	 * Why a native runtime will not load, or null when it will. Defaults to the
	 * loader's answer: a remembered failure if there is one, otherwise whether a
	 * downloaded copy is on disk, otherwise the facts knowable from the registry
	 * alone (not a dependency of this build, no binary for this platform). It
	 * deliberately does NOT attempt a load, because dlopen'ing an inference engine
	 * to draw a settings panel is exactly the startup cost the lazy loader exists
	 * to avoid.
	 */
	readRuntimeFailure?: (
		runtimeId: NativeRuntimeId
	) => NativeRuntimeUnavailable | null | Promise<NativeRuntimeUnavailable | null>;
	/**
	 * Why the operating system's speech engine cannot run, or null when it can.
	 * Defaults to the real PATH check. Injected so a test on a Linux runner
	 * without `espeak-ng` can still describe a machine that has one.
	 */
	readSystemVoiceFailure?: () => Promise<SystemVoiceUnavailable | null>;
	/**
	 * Whether a Local Models task's assigned source can run. Defaults to the
	 * core's own resolver, handed this gate's model and runtime readers so a test
	 * that describes a machine describes it once. Asked only when the Brain is
	 * one the `voice-routing` assignment selects.
	 */
	readTaskReadiness?: (taskId: LocalModelTaskId) => Promise<LocalModelTaskReadiness>;
	/**
	 * Whether the user trained a wake phrase from their own recordings. Defaults
	 * to the enrollment store. Injected so a test describes a machine without
	 * writing a model to disk.
	 */
	hasEnrolledWakePhrase?: (phrase: string) => boolean;
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
	if (slot === 'wake-word') {
		return settings.wakeEngine === 'transcription'
			? TRANSCRIPTION_WAKE_PROVIDER_ID
			: WAKE_WORD_PROVIDER_ID;
	}
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
 * A native runtime that will not load, as a slot verdict. Null when it will.
 *
 * "Will not load" rather than "has already failed": a runtime that is not part
 * of this build, or has no binary for this platform, is unusable before anything
 * tries it, and a gate that waited for an attempt would call the slot ready
 * right up until the session died in the provider's `start()`.
 */
async function runtimeFailureFor(
	slot: VoiceSlot,
	providerId: string,
	runtimeId: NativeRuntimeId,
	options: ResolveVoiceReadinessOptions
): Promise<VoiceSlotReadiness | null> {
	const read = options.readRuntimeFailure ?? knownNativeRuntimeUnavailability;
	const failure = await read(runtimeId);
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
	const requirement = requirementFor(providerId);

	if (requirement.kind === 'none') {
		return { slot, providerId, satisfied: true };
	}

	if (requirement.kind === 'local-models-task') {
		return resolveAssignedSource(slot, providerId, requirement.taskId, options, readModelStatus);
	}

	if (requirement.kind === 'system-voice') {
		// Present by construction on macOS and Windows; on Linux only with
		// `espeak-ng` installed. Checked here so a machine without one refuses
		// before the microphone opens rather than on the first reply, when the user
		// has no screen in front of them.
		const readFailure = options.readSystemVoiceFailure ?? systemVoiceUnavailability;
		const failure = await readFailure();
		if (!failure) return { slot, providerId, satisfied: true };
		return {
			slot,
			providerId,
			satisfied: false,
			reason: 'runtime-unavailable',
			detail: `${label}: ${failure.message}`,
			suggestedAction: failure.suggestedAction,
		};
	}

	if (requirement.kind === 'model') {
		// Runtime before model. A binary that will not load on this machine is not
		// repaired by a download, and "download 1.1 GB" is the wrong instruction to
		// give someone whose real problem is a missing redistributable.
		if (requirement.runtimeId) {
			const runtimeVerdict = await runtimeFailureFor(
				slot,
				providerId,
				requirement.runtimeId,
				options
			);
			if (runtimeVerdict) return { ...runtimeVerdict, requiredModelId: requirement.modelId };
		}

		const model = getLocalModel(requirement.modelId);
		const modelName = model?.displayName ?? requirement.modelId;
		const status = await readModelStatus(requirement.modelId);

		if (status.status === 'installed') {
			// The transcription engine matches any phrase, so only the classifier
			// engine needs a model trained for the phrase.
			if (slot === 'wake-word' && providerId === WAKE_WORD_PROVIDER_ID) {
				// The front end alone scores nothing: without the phrase's own
				// classifier the detector listens forever and never fires, which is
				// exactly what a Test button that never lights up looks like.
				const classifierVerdict = await resolveWakeClassifier(
					providerId,
					options.settings?.wakePhrase ?? DEFAULT_WAKE_PHRASE,
					readModelStatus,
					options.hasEnrolledWakePhrase ?? hasEnrolledWakeModel
				);
				if (classifierVerdict) return classifierVerdict;
			}
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
				suggestedAction: `Re-verify or re-download it in ${modelsSettingsLocation('library', 'speech')}.`,
			};
		}
		return {
			slot,
			providerId,
			satisfied: false,
			reason: 'model-not-installed',
			requiredModelId: requirement.modelId,
			detail: `${label}: ${modelName} is not installed.`,
			suggestedAction: `Download it in ${modelsSettingsLocation('library', 'speech')}.`,
		};
	}

	const readKey = options.hasApiKey ?? hasCredential;
	if (!readKey(requirement.service)) {
		return {
			slot,
			providerId,
			satisfied: false,
			reason: 'api-key-missing',
			detail: `${label}: ${providerId} needs a ${credentialLabel(requirement.service)} API key.`,
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

/**
 * How a Local Models readiness reason travels as a voice slot reason.
 *
 * The three a model row can act on keep their meaning (the slot offers the
 * download for the first two). Every endpoint fault but a missing key, and an
 * assignment that names a model this build cannot run, is "the source this slot
 * was pointed at cannot be reached": the sentence beside it says which. A System
 * One engine that is not chosen or not set up is that too.
 */
const TASK_REASON_TO_SLOT_REASON: Record<LocalModelTaskUnreadyReason, VoiceSlotUnsatisfiedReason> =
	{
		'model-not-installed': 'model-not-installed',
		'model-corrupt': 'model-corrupt',
		'runtime-unavailable': 'runtime-unavailable',
		'endpoint-key-missing': 'api-key-missing',
		'model-unknown': 'provider-unreachable',
		'model-wrong-kind': 'provider-unreachable',
		'endpoint-unknown': 'provider-unreachable',
		'endpoint-disabled': 'provider-unreachable',
		'endpoint-unsupported': 'provider-unreachable',
		'endpoint-rejected': 'provider-unreachable',
		'endpoint-unreachable': 'provider-unreachable',
		'endpoint-model-missing': 'provider-unreachable',
		'system-one-off': 'provider-unreachable',
		'system-one-not-ready': 'provider-unreachable',
	};

/**
 * A slot filled by a Local Models assignment: ready exactly when the task's
 * assigned source is.
 *
 * The verdict is the core's (`resolveTaskReadiness`), restated for the slot, so
 * this panel, Settings > Models, and `maestro-cli models status` cannot
 * disagree about whether the assigned model can route. It is never satisfied by
 * a different source: an assignment that is off, or that cannot run, leaves the
 * slot unsatisfied and says which model or endpoint it was.
 */
async function resolveAssignedSource(
	slot: VoiceSlot,
	providerId: string,
	taskId: LocalModelTaskId,
	options: ResolveVoiceReadinessOptions,
	readModelStatus: (modelId: string) => Promise<ModelStatus>
): Promise<VoiceSlotReadiness> {
	const label = SLOT_LABELS[slot];
	const readRuntimeFailure = options.readRuntimeFailure;
	const readTaskReadiness =
		options.readTaskReadiness ??
		((id: LocalModelTaskId) =>
			resolveTaskReadiness(id, {
				readModelStatus,
				...(readRuntimeFailure
					? { readRuntimeFailure: async (runtimeId) => readRuntimeFailure(runtimeId) }
					: {}),
			}));
	const readiness = await readTaskReadiness(taskId);
	const requiredModelId =
		readiness.assignment.type === 'local' ? readiness.assignment.modelId : undefined;

	if (readiness.state === 'ready') {
		return { slot, providerId, satisfied: true, ...(requiredModelId ? { requiredModelId } : {}) };
	}

	if (readiness.state === 'unavailable' && readiness.reason) {
		const reason = TASK_REASON_TO_SLOT_REASON[readiness.reason];
		// Recovery needs the model id to find its engine too. The installer must
		// check the engine's install state before offering a runtime download:
		// an installed binary that cannot load needs a different recovery.
		const downloadable =
			reason === 'model-not-installed' ||
			reason === 'model-corrupt' ||
			reason === 'runtime-unavailable';
		return {
			slot,
			providerId,
			satisfied: false,
			reason,
			...(downloadable && requiredModelId ? { requiredModelId } : {}),
			detail: `${label}: ${readiness.detail}`,
			suggestedAction: readiness.suggestedAction,
		};
	}

	// The slot holds an assigned Brain while the assignment names no model: a
	// settings file that spells the provider id out, or an assignment switched
	// off since. Refused by name; nothing else is put in its place.
	return {
		slot,
		providerId,
		satisfied: false,
		reason: 'provider-unreachable',
		detail: `${label}: ${readiness.label} has no model assigned.`,
		suggestedAction: `Assign one in ${taskAssignmentLocation(readiness.taskId)}, or pick another Conductor Brain in Settings > Plugins > A Cappella > Voice Providers.`,
	};
}

/**
 * The wake phrase's own classifier, after the shared front end is known good.
 *
 * Returns null when the phrase has a pretrained classifier that is installed;
 * otherwise the verdict to report. A phrase with no classifier at all is
 * `wake-phrase-untrained`, because no download fixes it; a pretrained one that
 * is merely missing is an ordinary download.
 */
async function resolveWakeClassifier(
	providerId: string,
	phrase: string,
	readModelStatus: (modelId: string) => Promise<ModelStatus>,
	hasEnrolledWakePhrase: (phrase: string) => boolean
): Promise<VoiceSlotReadiness | null> {
	const label = SLOT_LABELS['wake-word'];
	// A phrase the user recorded themselves needs nothing but the front end,
	// which the caller has already found installed. It also outranks a pretrained
	// classifier for the same words, exactly as it does in the detector.
	if (hasEnrolledWakePhrase(phrase)) return null;

	const pretrained = findPretrainedWakePhrase(phrase);
	if (!pretrained) {
		return {
			slot: 'wake-word',
			providerId,
			satisfied: false,
			reason: 'wake-phrase-untrained',
			detail: `${label}: no detector has been trained for "${phrase}", so it cannot fire.`,
			suggestedAction: `Train it from your own voice under Voice Controls, switch Detection to Transcription, or use "${DEFAULT_WAKE_PHRASE}".`,
		};
	}

	const model = getLocalModel(pretrained.modelId);
	const modelName = model?.displayName ?? pretrained.modelId;
	const status = await readModelStatus(pretrained.modelId);
	if (status.status === 'installed') return null;
	if (status.status === 'corrupt') {
		return {
			slot: 'wake-word',
			providerId,
			satisfied: false,
			reason: 'model-corrupt',
			requiredModelId: pretrained.modelId,
			detail: `${label}: ${modelName} is installed but failed verification${
				status.detail ? ` (${status.detail})` : ''
			}.`,
			suggestedAction: `Re-verify or re-download it in ${modelsSettingsLocation('library', 'speech')}.`,
		};
	}
	return {
		slot: 'wake-word',
		providerId,
		satisfied: false,
		reason: 'model-not-installed',
		requiredModelId: pretrained.modelId,
		detail: `${label}: ${modelName} is not installed.`,
		suggestedAction: `Download it in ${modelsSettingsLocation('library', 'speech')}.`,
	};
}

// Re-exported so a caller that already has the gate does not need a second
// import for the one-line formatting of its verdict.
export { readinessErrorMessage } from '../../../shared/acappella/readiness';
