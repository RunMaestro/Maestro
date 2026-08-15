/**
 * @file VoiceSetupPanel.test.tsx
 *
 * The panel's defining property: **opening it downloads nothing.**
 *
 * A Cappella asks the user for up to 1.4 GB of disk and bandwidth, and the whole
 * consent story rests on the bill of materials being visible BEFORE anything is
 * fetched. So this suite asserts that mounting the panel issues zero network
 * calls (no `fetch`, no download channel), that it still renders the full
 * catalog detail, and that the Download button is the only thing that starts a
 * transfer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { VoiceSetupPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceSetupPanel';
import {
	KOKORO_82M_ID,
	OPENWAKEWORD_BASE_ID,
	QWEN3_1_7B_ID,
	VOICE_MODEL_CATALOG,
	WHISPER_BASE_EN_ID,
	getVoiceModel,
} from '../../../../../shared/acappella/model-catalog';
import { mockTheme } from '../../../../helpers/mockTheme';

/** Every catalog model, reported as not installed. */
function notInstalledListings() {
	return VOICE_MODEL_CATALOG.map((entry) => ({
		entry,
		status: {
			id: entry.id,
			status: 'not-installed' as const,
			manifest: null,
			detail: 'Not installed',
			bytesOnDisk: 0,
		},
		installPaths: entry.files.map((file) => `/tmp/models/acappella/${entry.id}/${file.path}`),
	}));
}

const voiceModels = () => window.maestro.voice.models;

describe('VoiceSetupPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(voiceModels().list).mockResolvedValue(notInstalledListings());
		vi.mocked(voiceModels().footprint).mockResolvedValue({ bytes: 0, models: [] });
		vi.mocked(voiceModels().readiness).mockResolvedValue({
			canStartSession: false,
			canRunHandsFree: false,
			slots: [],
			blocking: [
				{
					slot: 'stt',
					providerId: 'whisper-local',
					satisfied: false,
					reason: 'model-not-installed',
					detail: 'Speech-to-Text: Whisper Base (English) is not installed.',
					suggestedAction: 'Download it in Settings.',
				},
			],
		});
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
	});

	it('issues zero network calls when mounted', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		await waitFor(() => {
			expect(voiceModels().list).toHaveBeenCalled();
		});

		// The panel reads the catalog and the disk. It does not open a socket, and
		// it does not ask the main process to open one.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(voiceModels().download).not.toHaveBeenCalled();
		expect(voiceModels().resume).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
	});

	it('renders the bill of materials from the frozen catalog', async () => {
		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		const whisper = getVoiceModel(WHISPER_BASE_EN_ID)!;
		await screen.findByText(whisper.displayName);

		// Name, license, and install path are all on screen before anything is
		// downloaded. That is the consent surface.
		expect(screen.getAllByText(whisper.license).length).toBeGreaterThan(0);
		expect(
			screen.getByText(`/tmp/models/acappella/${whisper.id}/${whisper.files[0].path}`)
		).toBeInTheDocument();
		expect(screen.getByText(getVoiceModel(KOKORO_82M_ID)!.displayName)).toBeInTheDocument();
		expect(screen.getByText(getVoiceModel(QWEN3_1_7B_ID)!.displayName)).toBeInTheDocument();
		expect(screen.getByText(getVoiceModel(OPENWAKEWORD_BASE_ID)!.displayName)).toBeInTheDocument();
	});

	it('states why voice mode is not ready', async () => {
		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		await screen.findByText(/Whisper Base \(English\) is not installed/);
	});

	it('starts a download only when the Download button is pressed', async () => {
		const { container } = render(<VoiceSetupPanel theme={mockTheme} enabled />);

		// The set button, not one of the per-model rows: this is the primary
		// "Download (~N MB)" affordance for the whole selection.
		const button = await waitFor(() => {
			const found = container.querySelector<HTMLButtonElement>(
				'[data-setting-id="encore-a-cappella-download-set"]'
			);
			if (!found || found.disabled) throw new Error('download button not ready');
			return found;
		});
		expect(voiceModels().download).not.toHaveBeenCalled();

		fireEvent.click(button);

		await waitFor(() => {
			expect(voiceModels().download).toHaveBeenCalled();
		});
		// The fully-local set: everything is missing, so everything is requested.
		const requested = vi
			.mocked(voiceModels().download)
			.mock.calls.map((call: unknown[]) => call[0]);
		expect(requested).toEqual(
			expect.arrayContaining([WHISPER_BASE_EN_ID, OPENWAKEWORD_BASE_ID, KOKORO_82M_ID])
		);
	});

	it('offers Re-verify and Re-download for a corrupt model', async () => {
		const listings = notInstalledListings().map((listing) =>
			listing.entry.id === WHISPER_BASE_EN_ID
				? {
						...listing,
						status: {
							...listing.status,
							status: 'corrupt' as const,
							detail: 'ggml-base.en.bin is 10 bytes, expected 147964211',
							manifest: {
								id: WHISPER_BASE_EN_ID,
								revision: 'abc',
								sha256: 'abc',
								bytes: 1,
								sourceUrl: '',
								license: 'MIT',
								files: [],
								installedAt: 1,
								verifiedAt: 1,
							},
							bytesOnDisk: 10,
						},
					}
				: listing
		);
		vi.mocked(voiceModels().list).mockResolvedValue(listings);

		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		await screen.findByText(/Re-verify to confirm/);
		expect(screen.getByRole('button', { name: /Re-verify/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /^Re-download/ })).toBeInTheDocument();
	});
});
