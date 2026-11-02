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
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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
			holdWhileBusy: true,
			defaultMode: 'agent',
			listenMode: 'hands-free',
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

	it('refreshes the selected voice provider when the guided setup changes', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			providers: { tts: 'elevenlabs-tts' },
		});
		const { rerender } = render(
			<VoiceOutputPanel theme={mockTheme} enabled selectionVersion={0} />
		);
		await screen.findByText(/Text is sent to ElevenLabs/);
		vi.mocked(voice().listVoices).mockClear();
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			pipeline: 'realtime',
			providers: { tts: 'elevenlabs-tts' },
		});
		rerender(<VoiceOutputPanel theme={mockTheme} enabled selectionVersion={1} />);
		expect(await screen.findByText('Audio is sent to OpenAI.')).toBeInTheDocument();
		await waitFor(() => expect(voice().listVoices).toHaveBeenCalled());
	});

	it('auditions a voice that has not been selected', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);

		fireEvent.click(await screen.findByTestId('voice-preview-am_puck'));

		// The voice id is passed explicitly. Without it, hearing a voice would mean
		// selecting it first and undoing the ones you did not want.
		await waitFor(() => expect(voice().previewVoice).toHaveBeenCalledWith(PREVIEW_LINE, 'am_puck'));
	});

	it('combines gender, language and region filters without changing the selected voice', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({ voice: { voiceId: 'daniel' } });
		vi.mocked(voice().listVoices).mockResolvedValue([
			{ id: 'samantha', name: 'Samantha', language: 'en-US', gender: 'female' },
			{ id: 'karen', name: 'Karen', language: 'en-AU', gender: 'female' },
			{ id: 'monica', name: 'Monica', language: 'es-ES', gender: 'female' },
			{ id: 'daniel', name: 'Daniel', language: 'en-GB', gender: 'male' },
		]);
		render(<VoiceOutputPanel theme={mockTheme} enabled />);
		const voices = await screen.findByRole('radiogroup', { name: 'Voice', exact: true });
		await waitFor(() =>
			expect(within(voices).getByRole('radio', { name: 'Daniel' })).toBeChecked()
		);
		vi.mocked(window.maestro.settings.set).mockClear();
		fireEvent.click(screen.getByRole('button', { name: 'Filter voices by gender' }));
		fireEvent.click(screen.getByRole('option', { name: 'Female' }));
		fireEvent.click(screen.getByRole('button', { name: 'Filter voices by language' }));
		fireEvent.change(screen.getByRole('textbox', { name: 'Search language...' }), {
			target: { value: 'English' },
		});
		fireEvent.click(screen.getByRole('option', { name: 'English' }));
		fireEvent.click(screen.getByRole('button', { name: 'Filter voices by region' }));
		fireEvent.click(screen.getByRole('option', { name: 'United States' }));
		expect(within(voices).getAllByRole('radio')).toHaveLength(1);
		expect(within(voices).getByRole('radio', { name: 'Samantha' })).not.toBeChecked();
		expect(screen.getByText('1 of 4 voices')).toBeInTheDocument();
		expect(screen.getByText('Your current voice is hidden by these filters.')).toBeInTheDocument();
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
		expect(within(voices).getByRole('radio', { name: 'Daniel' })).toBeChecked();
	});

	it('keeps unlabelled voices accessible and lets an empty combination be cleared', async () => {
		vi.mocked(voice().listVoices).mockResolvedValue([
			{ id: 'known', name: 'Known', language: 'en-US', gender: 'male' },
			{ id: 'unknown', name: 'Unknown profile', language: 'not a locale' },
		]);
		render(<VoiceOutputPanel theme={mockTheme} enabled />);
		fireEvent.click(await screen.findByRole('button', { name: 'Filter voices by gender' }));
		fireEvent.click(screen.getByRole('option', { name: 'Unknown' }));
		expect(screen.getByRole('radio', { name: 'Unknown profile' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Filter voices by language' }));
		fireEvent.click(screen.getByRole('option', { name: 'English' }));
		expect(screen.getByText(/No voices match these filters/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
		expect(
			within(screen.getByRole('radiogroup', { name: 'Voice', exact: true })).getAllByRole('radio')
		).toHaveLength(2);
	});

	it('omits filters when a provider has no useful metadata', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);
		await screen.findByTestId('voice-preview-am_puck');
		expect(screen.queryByRole('button', { name: /Filter voices by/ })).not.toBeInTheDocument();
	});

	it('refreshes VoiceStudio profiles after the source becomes available', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			providers: { tts: 'voicestudio-tts' },
		});
		vi.mocked(voice().listVoices).mockRejectedValue(new Error('offline'));
		render(<VoiceOutputPanel theme={mockTheme} enabled />);
		await screen.findByText(/Could not load voices/);
		expect(
			screen.queryByText('This engine has one voice. Nothing to choose between.')
		).not.toBeInTheDocument();
		vi.mocked(voice().listVoices).mockResolvedValue([
			{ id: 'Pedram VoxCPM2', name: 'Pedram VoxCPM2' },
		]);
		fireEvent.click(screen.getByTestId('voice-refresh-voices'));
		const radio = await screen.findByRole('radio', { name: 'Pedram VoxCPM2' });
		expect(radio.id).not.toContain(' ');
		fireEvent.click(screen.getByTestId('voice-preview-Pedram VoxCPM2'));
		await waitFor(() =>
			expect(voice().previewVoice).toHaveBeenCalledWith(PREVIEW_LINE, 'Pedram VoxCPM2')
		);
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

	it('persists only changed busy hold and routing preferences', async () => {
		render(<VoiceOutputPanel theme={mockTheme} enabled />);
		fireEvent.click(await screen.findByRole('switch', { name: 'Hold while busy' }));
		await waitFor(() => expect(useVoiceUiStore.getState().holdWhileBusy).toBe(false));
		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith('acappella', {
				ui: { holdWhileBusy: false },
			})
		);
		fireEvent.click(screen.getByRole('button', { name: 'Conductor', exact: true }));
		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith('acappella', {
				ui: { defaultMode: 'conductor' },
			})
		);
		expect(useVoiceUiStore.getState()).toMatchObject({
			holdWhileBusy: false,
			defaultMode: 'conductor',
		});
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
