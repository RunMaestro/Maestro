/**
 * @file voiceSettings.test.ts
 *
 * The one renderer writer for the `acappella` settings blob. Both of its rules
 * guard a setting that is lost WITHOUT an error: writing more than the patch
 * freezes a default into the user's settings, and two interleaved
 * read-modify-writes drop whichever landed first.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
	ACAPPELLA_SETTINGS_KEY,
	patchVoiceSettingsSection,
	readVoiceSettingsBlob,
} from '../../../renderer/services/voiceSettings';

/**
 * A settings bridge backed by one in-memory blob, like the real store.
 *
 * `readDelayMs` holds each read open, which is what lets two unqueued
 * read-modify-writes see the same blob and overwrite each other.
 */
function fakeStore(initial?: Record<string, unknown>, readDelayMs = 0) {
	let blob: Record<string, unknown> | undefined = initial;
	vi.mocked(window.maestro.settings.get).mockImplementation(async () => {
		const seen = blob;
		if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
		return seen;
	});
	vi.mocked(window.maestro.settings.set).mockImplementation(async (_key, value) => {
		blob = value as Record<string, unknown>;
		return undefined as never;
	});
	return { read: () => blob };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('readVoiceSettingsBlob', () => {
	it('reads an empty blob before anything was saved', async () => {
		fakeStore(undefined);

		expect(await readVoiceSettingsBlob()).toEqual({});
		expect(window.maestro.settings.get).toHaveBeenCalledWith(ACAPPELLA_SETTINGS_KEY);
	});
});

describe('patchVoiceSettingsSection', () => {
	it('saves a VoiceStudio source while preserving the selected voice and provider', async () => {
		const store = fakeStore({
			providers: { tts: 'voicestudio-tts' },
			voice: { voiceId: 'Pedram VoxCPM2' },
		});
		await patchVoiceSettingsSection('voiceStudio', { engine: 'voxcpm2', seed: 11 });
		expect(store.read()).toEqual({
			providers: { tts: 'voicestudio-tts' },
			voice: { voiceId: 'Pedram VoxCPM2' },
			voiceStudio: { engine: 'voxcpm2', seed: 11 },
		});
	});
	it('writes only the patched field and keeps the rest of the blob', async () => {
		const store = fakeStore({
			providers: { stt: 'parakeet-local' },
			ui: { transcriptVisible: true },
			controls: { wakePhrase: 'okay computer' },
		});

		await patchVoiceSettingsSection('controls', { sendPhrases: 'go maestro' });

		expect(store.read()).toEqual({
			providers: { stt: 'parakeet-local' },
			ui: { transcriptVisible: true },
			controls: { wakePhrase: 'okay computer', sendPhrases: 'go maestro' },
		});
	});

	it('creates the section when it was never stored', async () => {
		const store = fakeStore(undefined);

		await patchVoiceSettingsSection('ui', { listenMode: 'push-to-talk' });

		expect(store.read()).toEqual({ ui: { listenMode: 'push-to-talk' } });
	});

	it('leaves a field nobody named unstored, so its default can still change', async () => {
		const store = fakeStore({ controls: {} });

		await patchVoiceSettingsSection('controls', { holdUntilSend: true });

		// The failure this replaced: a writer that saved the whole form put every
		// default it was showing on disk the first time one toggle moved.
		expect(store.read()?.controls).toEqual({ holdUntilSend: true });
	});

	it('runs overlapping writes one at a time, so neither drops the other', async () => {
		// Without the queue all three would read the same empty blob during the
		// slow read, and the last write would erase the other two.
		const store = fakeStore({}, 5);

		await Promise.all([
			patchVoiceSettingsSection('ui', { transcriptVisible: true }),
			patchVoiceSettingsSection('controls', { sendPhrases: 'go maestro' }),
			patchVoiceSettingsSection('ui', { listenMode: 'push-to-talk' }),
		]);

		expect(store.read()).toEqual({
			ui: { transcriptVisible: true, listenMode: 'push-to-talk' },
			controls: { sendPhrases: 'go maestro' },
		});
	});

	it('keeps writing after a write failed', async () => {
		const store = fakeStore({});
		vi.mocked(window.maestro.settings.set).mockRejectedValueOnce(new Error('disk full'));

		await expect(patchVoiceSettingsSection('ui', { muted: true })).rejects.toThrow('disk full');
		// A rejected write must not wedge the queue behind it.
		await patchVoiceSettingsSection('ui', { transcriptVisible: true });

		expect(store.read()).toEqual({ ui: { transcriptVisible: true } });
	});
});
