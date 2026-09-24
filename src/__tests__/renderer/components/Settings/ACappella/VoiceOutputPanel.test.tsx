/**
 * @file VoiceOutputPanel.test.tsx
 *
 * Voice and Speed. The defining property is that everything here applies to the
 * NEXT SPOKEN SENTENCE rather than the next session, so the tests assert on the
 * calls that make that true: the volume is pushed at the live audio host as well
 * as saved, and a Preview can audition a voice that has not been selected.
 *
 * The second property is the audio-destination statement, repeated here from
 * Voice Providers and computed from the live TTS slot rather than written.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { VoiceOutputPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceOutputPanel';
import { useVoiceUiStore } from '../../../../../renderer/stores/voiceUiStore';
import { mockTheme } from '../../../../helpers/mockTheme';

const voice = () => window.maestro.voice;

const PREVIEW_LINE = 'Backend agent finished the migration and all tests pass.';

describe('VoiceOutputPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		vi.mocked(voice().listVoices).mockResolvedValue([
			{ id: 'af_heart', name: 'Heart' },
			{ id: 'am_puck', name: 'Puck' },
		]);
		useVoiceUiStore.setState({
			transcriptVisible: false,
			hudPosition: null,
			minimizeBehavior: 'manual',
			minimized: false,
			muted: false,
			loaded: true,
		});
	});

	it('says where audio goes under the current text-to-speech provider', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			providers: { tts: 'elevenlabs-tts' },
		});

		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		expect(await screen.findByText(/ElevenLabs/)).toBeInTheDocument();
	});

	it('auditions a voice that has not been selected', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		fireEvent.click(await screen.findByTestId('voice-preview-am_puck'));

		// The voice id is passed explicitly. Without it, hearing a voice would mean
		// selecting it first and undoing the ones you did not want.
		await waitFor(() => expect(voice().previewVoice).toHaveBeenCalledWith(PREVIEW_LINE, 'am_puck'));
	});

	it('previews one fixed line so two voices can be compared on the same words', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		fireEvent.click(await screen.findByTestId('voice-preview-current'));

		await waitFor(() => expect(voice().previewVoice).toHaveBeenCalledWith(PREVIEW_LINE, undefined));
	});

	it('applies a volume change to the live output as well as saving it', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		const slider = await screen.findByLabelText('Volume');
		fireEvent.change(slider, { target: { value: '0.5' } });

		await waitFor(() => expect(voice().setVolume).toHaveBeenCalledWith(0.5));
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ voice: expect.objectContaining({ volume: 0.5 }) })
		);
	});

	it('saves the speed without needing a session restart', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		fireEvent.change(await screen.findByLabelText('Speed'), { target: { value: '1.2' } });

		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'acappella',
				expect.objectContaining({ voice: expect.objectContaining({ rate: 1.2 }) })
			)
		);
	});

	it('persists the transcript toggle', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		fireEvent.click(await screen.findByLabelText('Live transcript'));

		await waitFor(() => expect(useVoiceUiStore.getState().transcriptVisible).toBe(true));
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ ui: expect.objectContaining({ transcriptVisible: true }) })
		);
	});

	it('puts the HUD back in its default corner', async () => {
		useVoiceUiStore.setState({ hudPosition: { top: 12, left: 34 }, loaded: true });
		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		expect(await screen.findByText(/Currently at 34, 12/)).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('voice-hud-reset-position'));

		await waitFor(() => expect(useVoiceUiStore.getState().hudPosition).toBeNull());
		expect(screen.getByText(/default, bottom right/)).toBeInTheDocument();
	});

	it('says plainly that minimize and close are different actions', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);
		expect(
			await screen.findByText(/Minimizing collapses the HUD .* Closing it ends the session\./)
		).toBeInTheDocument();
	});

	it('offers nothing to choose between for an engine with one voice', async () => {
		vi.mocked(voice().listVoices).mockResolvedValue([]);
		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		expect(await screen.findByText(/This engine has one voice/)).toBeInTheDocument();
	});
});
