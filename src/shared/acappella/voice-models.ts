/**
 * A Cappella's view of the Local Models catalog.
 *
 * The models themselves (ids, pinned files, hashes, licenses, which runtime
 * reads them) live in the core catalog, `src/shared/local-models/`, because
 * voice is one consumer of local models among several. This module holds only
 * what is true FOR VOICE: the capability each model unlocks in Voice Setup's
 * words, the voice slot each model kind fills, the bundle Voice Setup offers, and
 * the wake phrases a pretrained classifier exists for. Everything here is keyed
 * by model id or derived from the core table, so the core never has to learn a
 * voice word.
 */

import { formatSize } from '../formatters';
import {
	HEY_JARVIS_WAKE_ID,
	KOKORO_82M_ID,
	LOCAL_MODEL_CATALOG,
	OPENWAKEWORD_BASE_ID,
	PARAKEET_TDT_V2_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
	getLocalModel,
	sumModelBytes,
} from '../local-models/model-catalog';
import {
	NATIVE_RUNTIMES,
	type NativeRuntimeDescriptor,
	type NativeRuntimeId,
} from '../local-models/native-runtimes';
import {
	LOCAL_MODEL_TASK_IDS,
	resolveLocalModelAssignment,
	type LocalModelAssignments,
} from '../local-models/tasks';
import type { LocalModelEntry, LocalModelKind } from '../local-models/types';
import type { VoiceSlot } from './readiness';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * The capability a model unlocks, in the words Voice Setup uses. Distinct from
 * the model's `kind` because the reason a user is asked for 1 GB of disk is not
 * the same thing as the interface slot it lands in.
 */
export type VoiceModelCapability =
	| 'local-speech-to-text'
	| 'local-text-to-speech'
	| 'local-conductor-brain'
	| 'hands-free-wake-word';

/**
 * What each catalog model unlocks for voice. A model absent from this table is
 * not a voice model at all (a future embedding model, say), which is a real
 * answer rather than a gap.
 */
export const VOICE_MODEL_CAPABILITIES: Readonly<Record<string, VoiceModelCapability>> =
	Object.freeze({
		[PARAKEET_TDT_V2_ID]: 'local-speech-to-text',
		[WHISPER_BASE_EN_ID]: 'local-speech-to-text',
		[OPENWAKEWORD_BASE_ID]: 'hands-free-wake-word',
		[HEY_JARVIS_WAKE_ID]: 'hands-free-wake-word',
		[KOKORO_82M_ID]: 'local-text-to-speech',
		[QWEN3_1_7B_ID]: 'local-conductor-brain',
	});

/** The voice capability a model unlocks, or undefined for a non-voice model. */
export function voiceModelCapability(modelId: string): VoiceModelCapability | undefined {
	return VOICE_MODEL_CAPABILITIES[modelId];
}

/** How each capability reads in a cross-consumer "in use by" list. */
const VOICE_USAGE_LABELS: Readonly<Record<VoiceModelCapability, string>> = Object.freeze({
	'local-speech-to-text': 'Voice (speech-to-text)',
	'local-text-to-speech': 'Voice (text-to-speech)',
	'local-conductor-brain': 'Voice (Conductor)',
	'hands-free-wake-word': 'Voice (wake word)',
});

/**
 * The words a shared surface (the Local Models tab) uses to say voice relies on
 * a model, or undefined when voice does not.
 *
 * Two exclusions, both because naming voice as the user would be untrue:
 * - A pending model, which voice cannot run in this build.
 * - A Conductor Brain model. Voice reaches a text model ONLY through the
 *   `voice-routing` assignment, and an assigned task is already named beside
 *   the model by the task list. Saying "Voice (Conductor)" for a model nothing
 *   routes with would claim a use that does not exist.
 */
export function voiceModelUsageLabel(modelId: string): string | undefined {
	const capability = voiceModelCapability(modelId);
	if (!capability || capability === 'local-conductor-brain') return undefined;
	if (getLocalModel(modelId)?.pending) return undefined;
	return VOICE_USAGE_LABELS[capability];
}

/** The model ids a task other than voice routing is assigned to run on this machine. */
export function modelsAssignedOutsideVoice(
	assignments: LocalModelAssignments | undefined
): Set<string> {
	const ids = new Set<string>();
	for (const taskId of LOCAL_MODEL_TASK_IDS) {
		if (taskId === 'voice-routing') continue;
		const assignment = resolveLocalModelAssignment(assignments, taskId);
		if (assignment.type === 'local') ids.add(assignment.modelId);
	}
	return ids;
}

/**
 * Whether a model directory is voice's to delete when the user reclaims disk
 * after switching voice off.
 *
 * Voice models, plus directories no catalog entry claims any more (a model since
 * dropped from the catalog has no other owner to keep it). Two kinds of model
 * are spared, because another consumer still runs them:
 * - A catalog model voice does not use (an embedding model, the injection
 *   classifier).
 * - A voice-capable model that a task other than voice routing is ASSIGNED to
 *   (`assignedElsewhere`): the recogniser dictation uses, the text model that
 *   names tabs. Without this, switching voice off and reclaiming its disk
 *   silently broke every other task that shared a model with it.
 */
export function isVoiceReclaimableModelDir(
	id: string,
	assignedElsewhere: ReadonlySet<string> = new Set()
): boolean {
	if (assignedElsewhere.has(id)) return false;
	return voiceModelCapability(id) !== undefined || getLocalModel(id) === undefined;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * The voice slot a model kind fills. `text-gen` is the Conductor Brain; kinds
 * voice does not use map to null.
 */
const SLOT_BY_KIND: Readonly<Record<LocalModelKind, VoiceSlot | null>> = Object.freeze({
	'wake-word': 'wake-word',
	stt: 'stt',
	tts: 'tts',
	'text-gen': 'brain',
	embedding: null,
	classifier: null,
});

/** Slot order every derived list follows, so the UI never reorders on a catalog edit. */
const SLOT_ORDER: readonly VoiceSlot[] = ['stt', 'tts', 'brain', 'wake-word', 'microphone'];

/** The voice slot a model fills, or null when voice does not use its kind. */
export function voiceSlotForModel(entry: Pick<LocalModelEntry, 'kind'>): VoiceSlot | null {
	return SLOT_BY_KIND[entry.kind];
}

/**
 * Which voice slots stop working when a runtime cannot load.
 *
 * Derived from the catalog (every voice model that runtime reads) rather than
 * written on the runtime, so the core registry stays free of voice vocabulary
 * and a catalog change cannot leave the two disagreeing.
 */
export function voiceSlotsForRuntime(runtimeId: NativeRuntimeId): VoiceSlot[] {
	const slots = new Set<VoiceSlot>();
	for (const entry of LOCAL_MODEL_CATALOG) {
		if (entry.runtime !== runtimeId || !voiceModelCapability(entry.id)) continue;
		const slot = voiceSlotForModel(entry);
		if (slot) slots.add(slot);
	}
	return SLOT_ORDER.filter((slot) => slots.has(slot));
}

/** Every runtime a slot depends on. Empty for slots with no native tier. */
export function runtimesForSlot(slot: VoiceSlot): NativeRuntimeDescriptor[] {
	return NATIVE_RUNTIMES.filter((runtime) => voiceSlotsForRuntime(runtime.id).includes(slot));
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export type VoiceModelSetId = 'hands-free-local';

export interface VoiceModelSet {
	readonly id: VoiceModelSetId;
	readonly displayName: string;
	readonly description: string;
	readonly modelIds: readonly string[];
	/** Computed sum over `modelIds`. Never a hard-coded number. */
	readonly bytes: number;
}

function defineSet(
	id: VoiceModelSetId,
	displayName: string,
	description: string,
	modelIds: readonly string[]
): VoiceModelSet {
	return Object.freeze({
		id,
		displayName,
		description,
		modelIds: Object.freeze([...modelIds]),
		bytes: sumModelBytes(modelIds),
	});
}

/**
 * The bundle Voice Setup offers.
 *
 * One set, and it is exactly the downloads the local trio needs: the recogniser
 * and the wake word. The voice is the operating system's own and the router is
 * built in, so neither costs a download. Kokoro and Qwen3 are deliberately NOT
 * in it. Kokoro is the better local voice, but the system voice already
 * speaks, so its 326 MB is a choice the user makes in the Text-to-Speech
 * picker, not part of "make voice work". Qwen3 is not offered for voice
 * routing (see `unofferedLocalModels` on that task), so a voice bundle that
 * fetched a gigabyte of weights voice would not use would be a lie on the
 * Download button. Both are installed from the Local Models tab.
 */
export const MODEL_SETS: Readonly<Record<VoiceModelSetId, VoiceModelSet>> = Object.freeze({
	'hands-free-local': defineSet(
		'hands-free-local',
		'Local speech',
		"Speech recognition and the wake word run on this machine. Replies use your computer's own voice and routing is built in, so nothing else is needed and nothing leaves this machine.",
		[PARAKEET_TDT_V2_ID, OPENWAKEWORD_BASE_ID, HEY_JARVIS_WAKE_ID]
	),
});

/** The models in a set, in catalog order. */
export function getModelSetEntries(setId: VoiceModelSetId): LocalModelEntry[] {
	const ids = new Set(MODEL_SETS[setId].modelIds);
	return LOCAL_MODEL_CATALOG.filter((entry) => ids.has(entry.id));
}

/**
 * Total download size of a set, formatted. This is the string on the download
 * button, which is why it is derived here rather than written into copy.
 */
export function formatModelSetSize(setId: VoiceModelSetId): string {
	return formatSize(MODEL_SETS[setId].bytes);
}

// ---------------------------------------------------------------------------
// Pretrained wake phrases
// ---------------------------------------------------------------------------

/**
 * A wake phrase that has a trained classifier in the catalog.
 *
 * openWakeWord detects only phrases it was trained on: the front end
 * (`openwakeword-base`) is shared, and each phrase needs its own small model.
 * This table is the whole list of phrases a fresh install can wake on with the
 * classifier engine. Any other phrase needs the transcription engine, which
 * matches the phrase in Parakeet's text instead.
 */
export interface PretrainedWakePhrase {
	/** What the user says, lower case. */
	readonly phrase: string;
	/** Catalog model holding the classifier. */
	readonly modelId: string;
	/** The classifier file inside that model's directory. */
	readonly file: string;
}

export const PRETRAINED_WAKE_PHRASES: readonly PretrainedWakePhrase[] = Object.freeze([
	Object.freeze({
		phrase: 'hey jarvis',
		modelId: HEY_JARVIS_WAKE_ID,
		file: 'hey_jarvis_v0.1.onnx',
	}),
]);

/** Lower case, punctuation stripped, single spaces: how phrases are compared. */
export function normalizeWakePhrase(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The pretrained classifier for a phrase, or undefined when none was trained for it. */
export function findPretrainedWakePhrase(text: string): PretrainedWakePhrase | undefined {
	const wanted = normalizeWakePhrase(text);
	return PRETRAINED_WAKE_PHRASES.find((entry) => entry.phrase === wanted);
}
