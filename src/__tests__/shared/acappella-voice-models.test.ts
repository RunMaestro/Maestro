/**
 * @file acappella-voice-models.test.ts
 *
 * Voice's layer over the core Local Models catalog: the capability each model
 * unlocks, the voice slot each runtime serves, the bundle Voice Setup offers,
 * and the wake phrases a pretrained classifier exists for. Everything here is
 * derived from or keyed into the core table, so these tests guard that the two
 * cannot disagree.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
	BGE_SMALL_EN_ID,
	DEBERTA_INJECTION_V2_ID,
	EMBEDDINGGEMMA_300M_ID,
	HEY_JARVIS_WAKE_ID,
	KOKORO_82M_ID,
	LOCAL_MODEL_CATALOG,
	OPENWAKEWORD_BASE_ID,
	PARAKEET_TDT_V2_ID,
	PROMPT_GUARD_2_22M_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
	getLocalModel,
	sumModelBytes,
} from '../../shared/local-models/model-catalog';
import {
	MODEL_SETS,
	VOICE_MODEL_CAPABILITIES,
	findPretrainedWakePhrase,
	formatModelSetSize,
	getModelSetEntries,
	isVoiceReclaimableModelDir,
	modelsAssignedOutsideVoice,
	normalizeWakePhrase,
	runtimesForSlot,
	voiceModelCapability,
	voiceModelUsageLabel,
	voiceSlotForModel,
	voiceSlotsForRuntime,
} from '../../shared/acappella/voice-models';
import { DEFAULT_WAKE_PHRASE } from '../../shared/acappella/voice-controls';
import { formatSize } from '../../shared/formatters';

describe('a model voice shares with another consumer', () => {
	it('spares a voice-capable model a non-voice task is assigned to', () => {
		const assigned = modelsAssignedOutsideVoice({
			dictation: { type: 'local', modelId: PARAKEET_TDT_V2_ID },
			'tab-naming': { type: 'local', modelId: QWEN3_1_7B_ID },
			// Voice routing is voice's own use, so it protects nothing here.
			'voice-routing': { type: 'local', modelId: QWEN3_1_7B_ID },
			'cue-gate': { type: 'endpoint', endpointId: 'e', model: 'qwen3:latest' },
		});
		expect([...assigned].sort()).toEqual([PARAKEET_TDT_V2_ID, QWEN3_1_7B_ID].sort());

		// Switching voice off and reclaiming its disk must not break dictation or
		// tab naming.
		expect(isVoiceReclaimableModelDir(PARAKEET_TDT_V2_ID, assigned)).toBe(false);
		expect(isVoiceReclaimableModelDir(QWEN3_1_7B_ID, assigned)).toBe(false);
		expect(isVoiceReclaimableModelDir(WHISPER_BASE_EN_ID, assigned)).toBe(true);
	});

	it('protects nothing when only voice routing uses the text model', () => {
		const assigned = modelsAssignedOutsideVoice({
			'voice-routing': { type: 'local', modelId: QWEN3_1_7B_ID },
		});
		expect(assigned.size).toBe(0);
		expect(isVoiceReclaimableModelDir(QWEN3_1_7B_ID, assigned)).toBe(true);
		expect(modelsAssignedOutsideVoice(undefined).size).toBe(0);
	});

	it('does not name voice as the user of a text model nothing routes with', () => {
		// Voice reaches a text model only through the voice-routing assignment,
		// which the task list already names beside the model.
		expect(voiceModelUsageLabel(QWEN3_1_7B_ID)).toBeUndefined();
		expect(voiceModelUsageLabel(PARAKEET_TDT_V2_ID)).toBe('Voice (speech-to-text)');
	});
});

describe('voice models', () => {
	it('tags every voice-kind catalog model with the voice capability it unlocks', () => {
		for (const entry of LOCAL_MODEL_CATALOG) {
			// Kinds voice has a slot for are voice models; embeddings and classifiers
			// belong to other consumers and carry no voice capability. A text model
			// fills the brain slot only when voice picked it: the curated agent and
			// coding models are not Conductor brains, and tagging one would let
			// "reclaim voice disk" delete a 60 GB download someone made for an agent.
			if (entry.kind === 'text-gen') continue;
			expect(voiceModelCapability(entry.id) !== undefined).toBe(voiceSlotForModel(entry) !== null);
		}
		for (const entry of LOCAL_MODEL_CATALOG) {
			if (entry.kind === 'text-gen' && entry.id !== QWEN3_1_7B_ID) {
				expect(voiceModelCapability(entry.id)).toBeUndefined();
			}
		}
		expect(voiceModelCapability(QWEN3_1_7B_ID)).toBe('local-conductor-brain');
		expect(voiceModelCapability('nope')).toBeUndefined();
		// No capability may point at a model the core catalog does not have.
		for (const id of Object.keys(VOICE_MODEL_CAPABILITIES)) expect(getLocalModel(id)).toBeDefined();
	});

	it("reclaims voice models and orphaned directories, never another consumer's models", () => {
		for (const id of [
			PARAKEET_TDT_V2_ID,
			WHISPER_BASE_EN_ID,
			OPENWAKEWORD_BASE_ID,
			HEY_JARVIS_WAKE_ID,
		]) {
			expect(isVoiceReclaimableModelDir(id)).toBe(true);
		}
		// A directory no catalog entry claims has no other owner to keep it.
		expect(isVoiceReclaimableModelDir('retired-model')).toBe(true);
		for (const id of [
			BGE_SMALL_EN_ID,
			EMBEDDINGGEMMA_300M_ID,
			PROMPT_GUARD_2_22M_ID,
			DEBERTA_INJECTION_V2_ID,
		]) {
			expect(isVoiceReclaimableModelDir(id)).toBe(false);
		}
	});

	it('maps model kinds onto voice slots', () => {
		expect(voiceSlotForModel({ kind: 'text-gen' })).toBe('brain');
		expect(voiceSlotForModel({ kind: 'stt' })).toBe('stt');
		expect(voiceSlotForModel({ kind: 'wake-word' })).toBe('wake-word');
		expect(voiceSlotForModel({ kind: 'embedding' })).toBeNull();
	});

	it('derives the voice slots each runtime serves from the catalog', () => {
		expect(voiceSlotsForRuntime('llama')).toEqual(['brain']);
		expect(voiceSlotsForRuntime('onnx')).toEqual(['stt', 'tts', 'wake-word']);
	});

	it('maps every voice slot that has a local tier to a runtime', () => {
		expect(runtimesForSlot('brain').map((runtime) => runtime.id)).toEqual(['llama']);
		// One ONNX Runtime serves all three, which is the point of picking it.
		// Speech-to-text moved here from a whisper.cpp binding that compiled from
		// source on every platform and so had nothing to download.
		expect(runtimesForSlot('stt').map((runtime) => runtime.id)).toEqual(['onnx']);
		expect(runtimesForSlot('tts').map((runtime) => runtime.id)).toEqual(['onnx']);
		expect(runtimesForSlot('wake-word').map((runtime) => runtime.id)).toEqual(['onnx']);
		expect(runtimesForSlot('microphone')).toEqual([]);
	});

	it('computes set totals rather than hard-coding them', () => {
		for (const set of Object.values(MODEL_SETS)) {
			expect(set.bytes).toBe(sumModelBytes(set.modelIds));
			expect(set.bytes).toBeGreaterThan(0);
		}
	});

	it('formats set sizes through the shared formatter', () => {
		expect(formatModelSetSize('hands-free-local')).toBe(
			formatSize(MODEL_SETS['hands-free-local'].bytes)
		);
	});

	it('returns set entries in catalog order', () => {
		const ids = getModelSetEntries('hands-free-local').map((entry) => entry.id);
		const catalogOrder = LOCAL_MODEL_CATALOG.map((entry) => entry.id).filter((id) =>
			ids.includes(id)
		);
		expect(ids).toEqual(catalogOrder);
	});

	it('bundles exactly the models the local trio can run', () => {
		// The default recogniser (Parakeet) and the wake word. The voice is the
		// system's own and the router is built in, so neither downloads anything.
		// Whisper is selectable but not bundled: one recogniser is enough.
		expect([...MODEL_SETS['hands-free-local'].modelIds].sort()).toEqual(
			[PARAKEET_TDT_V2_ID, OPENWAKEWORD_BASE_ID, HEY_JARVIS_WAKE_ID].sort()
		);
	});

	it('never bundles a model nothing in this build can read', () => {
		// Kokoro and Qwen3 stay in the catalog so an existing download can be seen
		// and removed, but a bundle that fetched them would fetch weights that no
		// provider can open.
		for (const id of [KOKORO_82M_ID, QWEN3_1_7B_ID]) {
			for (const set of Object.values(MODEL_SETS)) expect(set.modelIds).not.toContain(id);
		}
		for (const set of Object.values(MODEL_SETS)) {
			for (const id of set.modelIds) expect(getLocalModel(id)?.pending).toBeUndefined();
		}
		expect(getLocalModel(WHISPER_BASE_EN_ID)?.pending).toBeUndefined();
	});

	it('has a pretrained classifier for the default wake phrase', () => {
		// The default must be a phrase something can detect. "hey maestro" shipped
		// as the default with no model behind it and could never fire.
		expect(DEFAULT_WAKE_PHRASE).toBe('Hey Jarvis');
		const pretrained = findPretrainedWakePhrase(DEFAULT_WAKE_PHRASE);
		expect(pretrained?.modelId).toBe(HEY_JARVIS_WAKE_ID);
		expect(getLocalModel(pretrained!.modelId)?.files.map((file) => file.path)).toContain(
			pretrained!.file
		);
	});

	it('matches a wake phrase regardless of case and punctuation', () => {
		expect(findPretrainedWakePhrase('Hey, Jarvis!')?.modelId).toBe(HEY_JARVIS_WAKE_ID);
		expect(findPretrainedWakePhrase('hey maestro')).toBeUndefined();
		expect(normalizeWakePhrase('  Hey,   JARVIS. ')).toBe('hey jarvis');
	});
	it('records a microphone usage description that names the feature and the local path', () => {
		// Apple requires the string; a user deciding whether to grant the microphone
		// requires it to say something true. "Maestro would like to access the
		// microphone" answers neither question.
		const description =
			(
				JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
					build?: { mac?: { extendInfo?: Record<string, string> } };
				}
			).build?.mac?.extendInfo?.NSMicrophoneUsageDescription ?? '';
		expect(description).toContain('A Cappella');
		expect(description.toLowerCase()).toContain('local');
	});
});

describe('voiceModelUsageLabel', () => {
	it('names the voice slot a runnable voice model serves', () => {
		expect(voiceModelUsageLabel(PARAKEET_TDT_V2_ID)).toBe('Voice (speech-to-text)');
		expect(voiceModelUsageLabel(HEY_JARVIS_WAKE_ID)).toBe('Voice (wake word)');
	});

	it('names the voice slot of the neural voice, and nothing for a non-voice model', () => {
		// Kokoro speaks since its phoneme front end shipped, so voice is a user.
		expect(voiceModelUsageLabel(KOKORO_82M_ID)).toBe('Voice (text-to-speech)');
		expect(voiceModelUsageLabel(BGE_SMALL_EN_ID)).toBeUndefined();
		expect(voiceModelUsageLabel('not-a-model')).toBeUndefined();
	});
});
