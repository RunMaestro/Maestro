/**
 * @file engines.test.ts
 *
 * The table that binds a catalog speech-to-text model to its engine. Worth
 * pinning because it fails late otherwise: a model added to the catalog with
 * no engine downloads cleanly, shows as installed, and then cannot transcribe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({ installed: true }));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/maestro-test' } }));
vi.mock('../../../../main/local-models/model-store', () => ({
	isInstalled: vi.fn(async () => store.installed),
	modelFilePath: (id: string, relative: string) => `/models/${id}/${relative}`,
}));

import {
	hasSpeechToTextEngine,
	resolveInstalledSpeechToTextModel,
} from '../../../../main/local-models/stt/engines';
import { PARAKEET_MAX_SAMPLES } from '../../../../main/local-models/stt/parakeet/engine';
import { WHISPER_MAX_SAMPLES } from '../../../../main/local-models/stt/whisper/engine';
import {
	LOCAL_MODEL_CATALOG,
	PARAKEET_TDT_V2_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
} from '../../../../shared/local-models/model-catalog';

describe('speech-to-text engine bindings', () => {
	beforeEach(() => {
		store.installed = true;
	});

	it('has an engine for every speech-to-text model in the catalog', () => {
		const stt = LOCAL_MODEL_CATALOG.filter((entry) => entry.kind === 'stt');
		expect(stt.length).toBeGreaterThan(0);
		for (const entry of stt) expect(hasSpeechToTextEngine(entry.id)).toBe(true);
	});

	it('binds each model to its own pass limit', async () => {
		const parakeet = await resolveInstalledSpeechToTextModel(PARAKEET_TDT_V2_ID, 'test');
		const whisper = await resolveInstalledSpeechToTextModel(WHISPER_BASE_EN_ID, 'test');
		expect(parakeet.maxSamples).toBe(PARAKEET_MAX_SAMPLES);
		expect(whisper.maxSamples).toBe(WHISPER_MAX_SAMPLES);
		expect(parakeet.entry.id).toBe(PARAKEET_TDT_V2_ID);
	});

	it('refuses a model that is not a speech-to-text model, by name', async () => {
		await expect(resolveInstalledSpeechToTextModel(QWEN3_1_7B_ID, 'test')).rejects.toMatchObject({
			name: 'LocalModelError',
			code: 'model-unsupported',
			consumerId: 'test',
		});
		await expect(resolveInstalledSpeechToTextModel('no-such-model', 'test')).rejects.toMatchObject({
			code: 'model-unsupported',
		});
		expect(hasSpeechToTextEngine('toString')).toBe(false);
	});

	it('refuses a model that is not downloaded, naming it', async () => {
		store.installed = false;
		await expect(
			resolveInstalledSpeechToTextModel(PARAKEET_TDT_V2_ID, 'test')
		).rejects.toMatchObject({
			code: 'model-not-installed',
			message: expect.stringContaining('Parakeet'),
			recovery: expect.stringContaining('Download it in'),
		});
	});
});
