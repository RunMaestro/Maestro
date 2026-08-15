/**
 * @file VoiceProvidersPanel.test.tsx
 *
 * The panel's defining property: **the sentence about where audio goes is
 * computed from the current selection and is always visible.**
 *
 * That line is the one fact a person configuring a voice assistant actually
 * needs, and the failure mode this suite exists to prevent is it being written as
 * copy that drifts from the engines that are really running. So the tests change
 * a slot and assert the sentence changes with it.
 *
 * The second property, checked here rather than trusted: a stored API key is
 * never read back into the renderer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { VoiceProvidersPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceProvidersPanel';
import { mockTheme } from '../../../../helpers/mockTheme';

const voice = () => window.maestro.voice;

/** The stored `acappella` blob, as the settings store would return it. */
function storedBlob(providers: Record<string, string>, extra: Record<string, unknown> = {}) {
	return { providers, ...extra };
}

describe('VoiceProvidersPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		vi.mocked(voice().models.list).mockResolvedValue([]);
		vi.mocked(voice().models.footprint).mockResolvedValue({ bytes: 0, models: [] });
		vi.mocked(voice().models.readiness).mockResolvedValue({
			canStartSession: true,
			canRunHandsFree: true,
			slots: [],
			blocking: [],
		});
		vi.mocked(voice().credentials.list).mockResolvedValue([
			{ service: 'openai', label: 'OpenAI', configured: false, keyringAvailable: true },
			{ service: 'elevenlabs', label: 'ElevenLabs', configured: false, keyringAvailable: true },
			{ service: 'anthropic', label: 'Anthropic', configured: false, keyringAvailable: true },
		]);
	});

	it('says audio stays on this machine for a local configuration', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({ stt: 'whisper-local', tts: 'kokoro-local', brain: 'qwen3-local' })
		);

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		expect(await screen.findByText('Audio stays on this machine.')).toBeInTheDocument();
	});

	it('names the service the moment the recogniser is hosted', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({ stt: 'openai-stt', tts: 'kokoro-local', brain: 'qwen3-local' })
		);

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		expect(await screen.findByText('Audio is sent to OpenAI.')).toBeInTheDocument();
	});

	it('distinguishes text leaving from audio leaving', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({ stt: 'whisper-local', tts: 'elevenlabs-tts', brain: 'anthropic-brain' })
		);

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		// The microphone samples never leave, and saying otherwise would be as wrong
		// as hiding that the transcripts do.
		expect(
			await screen.findByText(
				'Audio stays on this machine. Text is sent to ElevenLabs and Anthropic.'
			)
		).toBeInTheDocument();
	});

	it('updates the statement when a slot changes', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({ stt: 'whisper-local', tts: 'kokoro-local', brain: 'qwen3-local' })
		);

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByText('Audio stays on this machine.');

		fireEvent.change(screen.getByLabelText('Speech-to-Text provider'), {
			target: { value: 'openai-stt' },
		});

		expect(await screen.findByText('Audio is sent to OpenAI.')).toBeInTheDocument();
	});

	it('persists a slot change and applies it to the running app', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(storedBlob({}));

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByLabelText('Conductor Brain provider');

		fireEvent.change(screen.getByLabelText('Conductor Brain provider'), {
			target: { value: 'anthropic-brain' },
		});

		await waitFor(() => {
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'acappella',
				expect.objectContaining({
					providers: expect.objectContaining({ brain: 'anthropic-brain' }),
				})
			);
		});
		// Without this the change would not take effect until the next app start.
		await waitFor(() => expect(voice().applyProviders).toHaveBeenCalled());
	});

	it('shows the capability gate verdict for an unsatisfied slot, with its recovery', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(storedBlob({ stt: 'whisper-local' }));
		vi.mocked(voice().models.readiness).mockResolvedValue({
			canStartSession: false,
			canRunHandsFree: false,
			slots: [
				{
					slot: 'stt',
					providerId: 'whisper-local',
					satisfied: false,
					reason: 'model-not-installed',
					requiredModelId: 'whisper-base-en',
					detail: 'Speech-to-Text: Whisper Base (English) is not installed.',
					suggestedAction: 'Download it in Settings.',
				},
			],
			blocking: [],
		});

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		expect(
			await screen.findByText('Speech-to-Text: Whisper Base (English) is not installed.')
		).toBeInTheDocument();
		// A link to the fix, not just a complaint.
		fireEvent.click(screen.getByText('Download the model'));
		expect(voice().models.download).toHaveBeenCalledWith('whisper-base-en');
	});

	it('offers a masked key field that never shows a stored key', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(storedBlob({ stt: 'openai-stt' }));
		vi.mocked(voice().credentials.list).mockResolvedValue([
			{ service: 'openai', label: 'OpenAI', configured: true, keyringAvailable: true },
		]);

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		const input = (await screen.findByPlaceholderText(
			'A key is stored. Type a new one to replace it.'
		)) as HTMLInputElement;
		expect(input.type).toBe('password');
		// The value is not fetched at all: nothing in the renderer needs it, and a
		// channel that returned one would put it in a heap and in any crash dump.
		expect(input.value).toBe('');
	});

	it('tests a typed key without storing it', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(storedBlob({ stt: 'openai-stt' }));
		vi.mocked(voice().credentials.validate).mockResolvedValue({
			service: 'openai',
			status: 'rate-limited',
			message: 'OpenAI is rate limiting this key right now.',
		});

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		fireEvent.change(await screen.findByPlaceholderText('Paste your key'), {
			target: { value: 'sk-typed-but-not-saved' },
		});
		fireEvent.click(screen.getByText('Test'));

		expect(
			await screen.findByText('OpenAI is rate limiting this key right now.')
		).toBeInTheDocument();
		expect(voice().credentials.validate).toHaveBeenCalledWith('openai', 'sk-typed-but-not-saved');
		expect(voice().credentials.set).not.toHaveBeenCalled();
	});

	it('states the realtime tradeoff where the choice is made', async () => {
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		expect(
			await screen.findByText(/Realtime is the lowest latency, but it speaks in that provider/)
		).toBeInTheDocument();
	});

	it('replaces the three slots with one provider in realtime mode', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({}, { pipeline: 'realtime' })
		);

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		expect(await screen.findByText('Audio is sent to OpenAI.')).toBeInTheDocument();
		expect(screen.queryByLabelText('Speech-to-Text provider')).not.toBeInTheDocument();
	});

	it('previews one fixed line so two voices can be compared', async () => {
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		fireEvent.click(await screen.findByText('Preview'));

		await waitFor(() =>
			expect(voice().previewVoice).toHaveBeenCalledWith(
				'Backend agent finished the migration and all tests pass.'
			)
		);
	});
});
