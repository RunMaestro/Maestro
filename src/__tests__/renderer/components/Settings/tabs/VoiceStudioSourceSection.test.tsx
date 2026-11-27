import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VoiceStudioSourceSection } from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/VoiceStudioSourceSection';
import { mockTheme } from '../../../../helpers/mockTheme';

describe('VoiceStudio source card', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.settings.get).mockImplementation(async (key) =>
			key === 'acappella'
				? {
						voiceStudio: { baseUrl: 'http://localhost:3900/', engine: 'voxcpm2', seed: 11 },
						voice: { voiceId: 'Pedram VoxCPM2' },
					}
				: { aCappella: false }
		);
	});
	it('loads stored fields without probing or starting the speech service', async () => {
		render(<VoiceStudioSourceSection theme={mockTheme} />);
		await screen.findByDisplayValue('http://localhost:3900/');
		expect(screen.getByDisplayValue('11')).toBeInTheDocument();
		expect(window.maestro.voice.voiceStudioStatus).not.toHaveBeenCalled();
		expect(window.maestro.voice.applyProviders).not.toHaveBeenCalled();
	});
	it('checks an unsaved source without persisting or making sound', async () => {
		vi.mocked(window.maestro.voice.voiceStudioStatus).mockResolvedValueOnce({
			connected: true,
			profiles: [{ id: 'id', name: 'Pedram VoxCPM2' }],
		});
		render(<VoiceStudioSourceSection theme={mockTheme} />);
		await waitFor(() => expect(screen.getByTestId('voice-studio-check')).not.toBeDisabled());
		fireEvent.click(screen.getByTestId('voice-studio-check'));
		await screen.findByText(/Profiles: Pedram VoxCPM2/);
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		expect(window.maestro.voice.previewVoice).not.toHaveBeenCalled();
	});
	it('saves the canonical URL and keeps the selected voice intact', async () => {
		render(<VoiceStudioSourceSection theme={mockTheme} />);
		await waitFor(() => expect(screen.getByTestId('voice-studio-save')).not.toBeDisabled());
		fireEvent.click(screen.getByTestId('voice-studio-save'));
		await screen.findByText(/Saved. Select VoiceStudio/);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({
				voiceStudio: { baseUrl: 'http://localhost:3900', engine: 'voxcpm2', seed: 11 },
				voice: { voiceId: 'Pedram VoxCPM2' },
			})
		);
	});
	it('rejects a remote service before contacting it', async () => {
		render(<VoiceStudioSourceSection theme={mockTheme} />);
		await waitFor(() => expect(screen.getByTestId('voice-studio-check')).not.toBeDisabled());
		fireEvent.change(screen.getByTestId('voice-studio-url').querySelector('input')!, {
			target: { value: 'http://example.com:3900' },
		});
		fireEvent.click(screen.getByTestId('voice-studio-check'));
		expect(screen.getByText(/must run on this computer/)).toBeInTheDocument();
		expect(window.maestro.voice.voiceStudioStatus).not.toHaveBeenCalled();
	});
});
