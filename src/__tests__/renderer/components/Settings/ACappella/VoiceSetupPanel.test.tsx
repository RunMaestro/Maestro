/**
 * @file VoiceSetupPanel.test.tsx
 *
 * The panel's defining property: **opening it downloads nothing.**
 *
 * Voice setup keeps microphone and provider choices here and sends model file
 * management to the global Models library.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import { VoiceSetupPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceSetupPanel';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import {
	KOKORO_82M_ID,
	PARAKEET_TDT_V2_ID,
	QWEN3_1_7B_ID,
	LOCAL_MODEL_CATALOG,
	WHISPER_BASE_EN_ID,
	getLocalModel,
} from '../../../../../shared/local-models/model-catalog';
import { mockTheme } from '../../../../helpers/mockTheme';

/** Every catalog model, reported as not installed. */
function notInstalledListings() {
	return LOCAL_MODEL_CATALOG.map((entry) => ({
		entry,
		status: {
			id: entry.id,
			status: 'not-installed' as const,
			manifest: null,
			detail: 'Not installed',
			bytesOnDisk: 0,
		},
		installPaths: entry.files.map((file) => `/tmp/models/${entry.id}/${file.path}`),
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
					providerId: 'parakeet-local',
					satisfied: false,
					reason: 'model-not-installed',
					detail: 'Speech-to-Text: Parakeet TDT 0.6B (English) is not installed.',
					suggestedAction: 'Download it in Settings.',
				},
			],
		});
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		useSettingsStore.setState({ localModelAssignments: {}, localModelEndpoints: [] });
		useModalStore.getState().closeModal('settings');
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

	it('names the selected models without embedding model download panels', async () => {
		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		const parakeet = getLocalModel(PARAKEET_TDT_V2_ID)!;
		await screen.findByText(parakeet.displayName);

		expect(
			screen.queryByText(`/tmp/models/${parakeet.id}/${parakeet.files[0].path}`)
		).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /^Download/ })).not.toBeInTheDocument();
		// Whisper is selectable, but not the default, so it is not offered here.
		expect(
			screen.queryByText(getLocalModel(WHISPER_BASE_EN_ID)!.displayName)
		).not.toBeInTheDocument();
		// The voice and the router download nothing, so their slots say so instead
		// of showing a model row - and the two models nothing can read are not
		// offered here at all.
		expect(screen.getByText(/voice built into this computer/)).toBeInTheDocument();
		expect(screen.getByText(/reads replies back as written/)).toBeInTheDocument();
		expect(screen.queryByText(getLocalModel(KOKORO_82M_ID)!.displayName)).not.toBeInTheDocument();
		expect(screen.queryByText(getLocalModel(QWEN3_1_7B_ID)!.displayName)).not.toBeInTheDocument();
	});

	it('states why voice mode is not ready', async () => {
		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		await screen.findByText(/Parakeet TDT 0\.6B \(English\) is not installed/);
	});

	it('shows the model the SELECTED recogniser needs, not the default one', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			providers: { stt: 'whisper-local' },
		});

		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		await screen.findByText(getLocalModel(WHISPER_BASE_EN_ID)!.displayName);
	});

	it('says which assigned model routes, and lists no endpoint to do it', async () => {
		useSettingsStore.setState({
			localModelEndpoints: [
				{
					id: 'ep-1',
					name: 'Ollama',
					kind: 'ollama',
					baseUrl: 'http://127.0.0.1:11434',
					enabled: true,
				},
			],
			localModelAssignments: {
				'voice-routing': { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.3' },
			},
		});

		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		expect(await screen.findByText(/Routes with llama3\.3 on Ollama/)).toBeInTheDocument();
		// The built-in router's note would be a lie while a model routes.
		expect(screen.queryByText(/reads replies back as written/)).not.toBeInTheDocument();
		// This panel still opens no connection: the endpoint is named, not called.
		expect(window.maestro.localModels.endpoints.listModels).not.toHaveBeenCalled();
	});

	it('names a local model assigned to voice routing', async () => {
		useSettingsStore.setState({
			localModelAssignments: { 'voice-routing': { type: 'local', modelId: QWEN3_1_7B_ID } },
		});

		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		await screen.findByText(/Routes with Qwen3/);
	});

	it('keeps an assigned Brain when the pill that is already lit is clicked', async () => {
		useSettingsStore.setState({
			localModelAssignments: { 'voice-routing': { type: 'local', modelId: QWEN3_1_7B_ID } },
		});
		const { container } = render(<VoiceSetupPanel theme={mockTheme} enabled />);
		await screen.findByText(/Routes with Qwen3/);

		const brain = container.querySelector('[data-setting-id="encore-a-cappella-brain"]')!;
		fireEvent.click(within(brain as HTMLElement).getByText('Local'));

		// A click on "Local" must not be read as "reset to the built-in router".
		await Promise.resolve();
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		expect(useSettingsStore.getState().localModelAssignments).toEqual({
			'voice-routing': { type: 'local', modelId: QWEN3_1_7B_ID },
		});
	});

	it('moves an assigned Brain to the hosted one, and switches the assignment off', async () => {
		useSettingsStore.setState({
			localModelAssignments: { 'voice-routing': { type: 'local', modelId: QWEN3_1_7B_ID } },
		});
		const { container } = render(<VoiceSetupPanel theme={mockTheme} enabled />);
		await screen.findByText(/Routes with Qwen3/);

		const brain = container.querySelector('[data-setting-id="encore-a-cappella-brain"]')!;
		fireEvent.click(within(brain as HTMLElement).getByText('Cloud'));

		await waitFor(() => {
			expect(window.maestro.settings.set).toHaveBeenCalledWith('localModelAssignments', {});
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'acappella',
				expect.objectContaining({ providers: expect.objectContaining({ brain: 'openai-brain' }) })
			);
		});
	});

	it('opens the global Speech library for model management', async () => {
		render(<VoiceSetupPanel theme={mockTheme} enabled />);
		await screen.findByText(getLocalModel(PARAKEET_TDT_V2_ID)!.displayName);

		fireEvent.click(screen.getByRole('button', { name: 'Manage voice models' }));

		expect(useModalStore.getState().getData('settings')).toEqual({
			tab: 'models',
			settingId: undefined,
			subTab: 'library/speech',
		});
		expect(voiceModels().download).not.toHaveBeenCalled();
	});

	it('keeps model verification and removal in the global library', async () => {
		render(<VoiceSetupPanel theme={mockTheme} enabled />);
		await screen.findByText(getLocalModel(PARAKEET_TDT_V2_ID)!.displayName);

		expect(
			screen.queryByRole('button', { name: /Re-verify|Re-download|Remove|Reclaim/ })
		).not.toBeInTheDocument();
		expect(voiceModels().verify).not.toHaveBeenCalled();
		expect(voiceModels().removeAll).not.toHaveBeenCalled();
	});
});
