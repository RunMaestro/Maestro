/**
 * @file VoiceSetupPanel.test.tsx
 *
 * The panel's defining property: **opening it downloads nothing.**
 *
 * Voice setup keeps microphone choices here and sends model file
 * management to the global Models library.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { VoiceSetupPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceSetupPanel';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { mockTheme } from '../../../../helpers/mockTheme';

const voiceModels = () => window.maestro.voice.models;

describe('VoiceSetupPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		useModalStore.getState().closeModal('settings');
	});

	it('issues zero network calls when mounted', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		render(<VoiceSetupPanel theme={mockTheme} enabled />);

		await waitFor(() => {
			expect(screen.getByLabelText('Microphone')).toBeEnabled();
		});

		// The panel reads the catalog and the disk. It does not open a socket, and
		// it does not ask the main process to open one.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(voiceModels().download).not.toHaveBeenCalled();
		expect(voiceModels().resume).not.toHaveBeenCalled();

		vi.unstubAllGlobals();
	});

	it('leaves provider selection to the guided setup', async () => {
		render(<VoiceSetupPanel theme={mockTheme} enabled />);
		await waitFor(() => expect(screen.getByLabelText('Microphone')).toBeEnabled());
		expect(screen.queryByRole('button', { name: 'Local' })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Cloud' })).not.toBeInTheDocument();
		expect(voiceModels().list).not.toHaveBeenCalled();
		expect(voiceModels().readiness).not.toHaveBeenCalled();
	});

	it('opens the global Speech library for model management', async () => {
		render(<VoiceSetupPanel theme={mockTheme} enabled />);
		await waitFor(() => expect(screen.getByLabelText('Microphone')).toBeEnabled());

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
		await waitFor(() => expect(screen.getByLabelText('Microphone')).toBeEnabled());

		expect(
			screen.queryByRole('button', { name: /Re-verify|Re-download|Remove|Reclaim/ })
		).not.toBeInTheDocument();
		expect(voiceModels().verify).not.toHaveBeenCalled();
		expect(voiceModels().removeAll).not.toHaveBeenCalled();
	});
});
