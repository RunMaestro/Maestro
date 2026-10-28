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
 *
 * The third: the Conductor Brain picker shows the Brain in force. A model
 * routes because it is assigned to the Local Models `voice-routing` task, so
 * the picker reads and writes that assignment and never a second copy of it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import { VoiceProvidersPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceProvidersPanel';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import type { LocalModelEndpoint } from '../../../../../shared/local-models/endpoints';
import { mockTheme } from '../../../../helpers/mockTheme';

const voice = () => window.maestro.voice;

const ollama: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};

const BRAIN_PICKER = 'Conductor Brain provider';

function brainOptions(): Array<{ value: string; label: string }> {
	return within(screen.getByLabelText(BRAIN_PICKER))
		.getAllByRole('option')
		.map((option) => ({
			value: (option as HTMLOptionElement).value,
			label: option.textContent ?? '',
		}));
}

/** The stored `acappella` blob, as the settings store would return it. */
function storedBlob(providers: Record<string, string>, extra: Record<string, unknown> = {}) {
	return { providers, setupMode: 'custom', ...extra };
}

describe('VoiceProvidersPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.settings.get).mockResolvedValue({ setupMode: 'custom' });
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
		vi.mocked(window.maestro.localModels.endpoints.listModels).mockResolvedValue({
			ok: true,
			models: [{ id: 'llama3.3' }, { id: 'qwen3:8b' }],
		} as never);
		useSettingsStore.setState({ localModelAssignments: {}, localModelEndpoints: [] });
	});

	it('says audio stays on this machine for a local configuration', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({ stt: 'whisper-local', tts: 'system-tts', brain: 'mock-brain' })
		);

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		expect(await screen.findByText('Audio stays on this machine.')).toBeInTheDocument();
	});

	it('names the service the moment the recogniser is hosted', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({ stt: 'openai-stt', tts: 'system-tts', brain: 'mock-brain' })
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
			storedBlob({ stt: 'whisper-local', tts: 'system-tts', brain: 'mock-brain' })
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

	it('offers the built-in router, the hosted Brains, and nothing else with no endpoint saved', async () => {
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByLabelText(BRAIN_PICKER);

		// No local model row: none is offered as a fresh choice yet.
		expect(brainOptions()).toEqual([
			{ value: 'mock-brain', label: 'Built-in (keyword routing)' },
			{ value: 'openai-brain', label: 'OpenAI (hosted)' },
			{ value: 'anthropic-brain', label: 'Anthropic (hosted)' },
		]);
		expect(window.maestro.localModels.endpoints.listModels).not.toHaveBeenCalled();
	});

	it("offers the models of the user's enabled endpoints", async () => {
		useSettingsStore.setState({ localModelEndpoints: [ollama] });

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		await waitFor(() =>
			expect(brainOptions()).toEqual(
				expect.arrayContaining([
					{ value: 'endpoint:ep-ollama:llama3.3', label: 'llama3.3' },
					{ value: 'endpoint:ep-ollama:qwen3:8b', label: 'qwen3:8b' },
				])
			)
		);
		expect(screen.getByRole('group', { name: 'Ollama' })).toBeInTheDocument();
	});

	it('shows the assigned model as the Brain, over the stored provider, and names the endpoint', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({ stt: 'whisper-local', tts: 'system-tts', brain: 'openai-brain' })
		);
		useSettingsStore.setState({
			localModelEndpoints: [ollama],
			localModelAssignments: {
				'voice-routing': { type: 'endpoint', endpointId: 'ep-ollama', model: 'llama3.3' },
			},
		});

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		// The transcript goes to the endpoint, so the sentence says so, by name.
		expect(
			await screen.findByText('Audio stays on this machine. Text is sent to Ollama.')
		).toBeInTheDocument();
		await waitFor(() =>
			expect((screen.getByLabelText(BRAIN_PICKER) as HTMLSelectElement).value).toBe(
				'endpoint:ep-ollama:llama3.3'
			)
		);
		// No key field: the stored hosted Brain is not the one in force.
		expect(screen.queryByText('OpenAI API key')).not.toBeInTheDocument();
	});

	it('assigns the picked endpoint model to voice-routing, and stores no provider id for it', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(storedBlob({ brain: 'mock-brain' }));
		useSettingsStore.setState({ localModelEndpoints: [ollama] });

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await waitFor(() => expect(brainOptions().length).toBeGreaterThan(3));

		fireEvent.change(screen.getByLabelText(BRAIN_PICKER), {
			target: { value: 'endpoint:ep-ollama:qwen3:8b' },
		});

		await waitFor(() => {
			expect(window.maestro.settings.set).toHaveBeenCalledWith('localModelAssignments', {
				'voice-routing': { type: 'endpoint', endpointId: 'ep-ollama', model: 'qwen3:8b' },
			});
		});
		// One stored value: the assignment. The voice blob is not touched.
		expect(window.maestro.settings.set).not.toHaveBeenCalledWith('acappella', expect.anything());
		await waitFor(() => expect(voice().applyProviders).toHaveBeenCalled());
		expect(
			await screen.findByText('Audio stays on this machine. Text is sent to Ollama.')
		).toBeInTheDocument();
	});

	it('switches the assignment off when a voice-specific Brain is picked', async () => {
		useSettingsStore.setState({
			localModelEndpoints: [ollama],
			localModelAssignments: {
				'tab-naming': { type: 'off' },
				'voice-routing': { type: 'endpoint', endpointId: 'ep-ollama', model: 'llama3.3' },
			},
		});

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByText('Audio stays on this machine. Text is sent to Ollama.');

		fireEvent.change(screen.getByLabelText(BRAIN_PICKER), { target: { value: 'mock-brain' } });

		await waitFor(() => {
			// Only this task's entry goes; an assignment left on would keep deciding
			// the slot, and another task's choice is not this panel's to touch.
			expect(window.maestro.settings.set).toHaveBeenCalledWith('localModelAssignments', {
				'tab-naming': { type: 'off' },
			});
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'acappella',
				expect.objectContaining({ providers: expect.objectContaining({ brain: 'mock-brain' }) })
			);
		});
		expect(await screen.findByText('Audio stays on this machine.')).toBeInTheDocument();
	});

	it('leaves a System One assignment alone when a voice-specific Brain is picked, and says who routes', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(storedBlob({ brain: 'mock-brain' }));
		useSettingsStore.setState({
			localModelAssignments: { 'voice-routing': { type: 'system-one' } },
		});

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		// System One fills no slot, so the picker shows the Brain that speaks, and
		// the row says the routing decision is not that Brain's.
		const note = await screen.findByTestId('voice-routing-system-one-note');
		expect(note).toHaveTextContent(
			'System One decides which agent and tab a request is for (Settings > Models > System One).'
		);
		expect(note).toHaveTextContent('This Brain still writes what is spoken');

		fireEvent.change(screen.getByLabelText(BRAIN_PICKER), { target: { value: 'anthropic-brain' } });

		await waitFor(() => {
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'acappella',
				expect.objectContaining({
					providers: expect.objectContaining({ brain: 'anthropic-brain' }),
				})
			);
		});
		// Picking who speaks must not switch the routing off.
		expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
			'localModelAssignments',
			expect.anything()
		);
		expect(screen.getByTestId('voice-routing-system-one-note')).toBeInTheDocument();
	});

	it('says nothing about System One while it does not route', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(storedBlob({ brain: 'mock-brain' }));

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByLabelText(BRAIN_PICKER);

		expect(screen.queryByTestId('voice-routing-system-one-note')).not.toBeInTheDocument();
	});

	it('shows a local model that is already assigned, without offering one otherwise', async () => {
		useSettingsStore.setState({
			localModelAssignments: {
				'voice-routing': { type: 'local', modelId: 'qwen3-1.7b-instruct-q4km' },
			},
		});

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByLabelText(BRAIN_PICKER);

		// Not installed here, so the row says so; it is still the selected one.
		expect((screen.getByLabelText(BRAIN_PICKER) as HTMLSelectElement).value).toBe(
			'local:qwen3-1.7b-instruct-q4km'
		);
		expect(brainOptions()).toContainEqual({
			value: 'local:qwen3-1.7b-instruct-q4km',
			label: 'Qwen3 1.7B Instruct (Q4_K_M) (not installed)',
		});
		expect(screen.getByText('Audio stays on this machine.')).toBeInTheDocument();
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
			'Stored. Enter replacement key'
		)) as HTMLInputElement;
		expect(input.type).toBe('password');
		// The value is not fetched at all: nothing in the renderer needs it, and a
		// channel that returned one would put it in a heap and in any crash dump.
		expect(input.value).toBe('');
	});

	it('keeps hosted provider key drafts and save actions independent', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({ brain: 'anthropic-brain', tts: 'elevenlabs-tts' })
		);
		vi.mocked(voice().credentials.set).mockResolvedValue({ ok: true });

		const { container } = render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByText('ElevenLabs API key');
		const brainKey = within(
			container.querySelector('[data-setting-id="encore-a-cappella-key-anthropic"]')!
		);
		const voiceKey = within(
			container.querySelector('[data-setting-id="encore-a-cappella-key-elevenlabs"]')!
		);
		fireEvent.change(brainKey.getByPlaceholderText('Paste your key'), {
			target: { value: 'anthropic-draft' },
		});
		fireEvent.change(voiceKey.getByPlaceholderText('Paste your key'), {
			target: { value: 'elevenlabs-draft' },
		});
		fireEvent.click(voiceKey.getByRole('button', { name: 'Save', exact: true }));

		await waitFor(() => {
			expect(voice().credentials.set).toHaveBeenCalledExactlyOnceWith(
				'elevenlabs',
				'elevenlabs-draft'
			);
			expect(voiceKey.getByPlaceholderText('Paste your key')).toHaveValue('');
		});
		expect(brainKey.getByPlaceholderText('Paste your key')).toHaveValue('anthropic-draft');
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

	it('explains the OpenAI voice and audio destination in the Cloud preset', async () => {
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByLabelText(BRAIN_PICKER);
		fireEvent.click(screen.getByRole('button', { name: 'Cloud', exact: true }));
		expect(await screen.findByText('OpenAI Realtime')).toBeInTheDocument();
		expect(screen.getByText(/speaks in an OpenAI voice/)).toHaveTextContent(
			'Choose Custom to use ElevenLabs or a local voice.'
		);
	});

	it('uses the local preset for an existing default configuration without rewriting it', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		expect(await screen.findByText('Everything runs on this Mac')).toBeInTheDocument();
		expect(screen.queryByLabelText(BRAIN_PICKER)).not.toBeInTheDocument();
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});

	it('keeps a legacy mixed configuration editable without rewriting it', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			providers: { stt: 'whisper-local', tts: 'elevenlabs-tts', brain: 'anthropic-brain' },
		});
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		expect(await screen.findByLabelText('Text-to-Speech provider')).toHaveValue('elevenlabs-tts');
		expect(screen.getByLabelText(BRAIN_PICKER)).toHaveValue('anthropic-brain');
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});

	it('applies the local preset in one voice-settings write and clears only voice routing', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			providers: { stt: 'openai-stt', tts: 'elevenlabs-tts', brain: 'anthropic-brain' },
			voice: { rate: 1.2, volume: 0.5 },
		});
		useSettingsStore.setState({
			localModelAssignments: {
				'voice-routing': { type: 'system-one' },
				'tab-naming': { type: 'system-one' },
			},
		});
		const onSelectionChanged = vi.fn();
		render(
			<VoiceProvidersPanel theme={mockTheme} enabled onSelectionChanged={onSelectionChanged} />
		);
		await screen.findByLabelText(BRAIN_PICKER);
		fireEvent.click(screen.getByRole('button', { name: 'On this Mac' }));
		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith('acappella', {
				pipeline: 'cascade',
				setupMode: 'local',
				providers: { stt: 'parakeet-local', tts: 'system-tts', brain: 'mock-brain' },
				voice: { rate: 1.2, volume: 0.5 },
			})
		);
		expect(useSettingsStore.getState().localModelAssignments).toEqual({
			'tab-naming': { type: 'system-one' },
		});
		expect(
			vi.mocked(window.maestro.settings.set).mock.calls.filter(([key]) => key === 'acappella')
		).toHaveLength(1);
		expect(voice().applyProviders).toHaveBeenCalledTimes(1);
		expect(onSelectionChanged).toHaveBeenCalledTimes(1);
	});

	it('keeps the previous setup and routing assignment when saving a preset fails', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			providers: { tts: 'elevenlabs-tts' },
		});
		useSettingsStore.setState({
			localModelAssignments: { 'voice-routing': { type: 'system-one' } },
		});
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByLabelText(BRAIN_PICKER);
		vi.mocked(window.maestro.settings.set).mockRejectedValueOnce(
			new Error('Settings are read-only.')
		);
		fireEvent.click(screen.getByRole('button', { name: 'On this Mac' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Settings are read-only.');
		expect(screen.getByLabelText('Text-to-Speech provider')).toHaveValue('elevenlabs-tts');
		expect(useSettingsStore.getState().localModelAssignments).toEqual({
			'voice-routing': { type: 'system-one' },
		});
		expect(voice().applyProviders).not.toHaveBeenCalled();
	});

	it('uses OpenAI Realtime for Cloud and preserves custom provider selections', async () => {
		const providers = { stt: 'whisper-local', tts: 'elevenlabs-tts', brain: 'anthropic-brain' };
		vi.mocked(window.maestro.settings.get).mockResolvedValue({ providers });
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByLabelText(BRAIN_PICKER);
		fireEvent.click(screen.getByRole('button', { name: 'Cloud', exact: true }));
		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith('acappella', {
				pipeline: 'realtime',
				setupMode: 'cloud',
				providers: { ...providers, realtime: 'openai-realtime' },
			})
		);
		expect(screen.queryByLabelText(BRAIN_PICKER)).not.toBeInTheDocument();
		expect(await screen.findByText('Audio is sent to OpenAI.')).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole('button', { name: 'Custom', exact: true })).toBeEnabled()
		);
		fireEvent.click(screen.getByRole('button', { name: 'Custom', exact: true }));
		expect(await screen.findByLabelText('Text-to-Speech provider')).toHaveValue('elevenlabs-tts');
		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith('acappella', {
				pipeline: 'cascade',
				setupMode: 'custom',
				providers,
			})
		);
	});

	it('keeps Custom open after reloading a saved setup containing the local defaults', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({ setupMode: 'custom' });
		const { unmount } = render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		await screen.findByLabelText(BRAIN_PICKER);
		unmount();
		render(<VoiceProvidersPanel theme={mockTheme} enabled />);
		expect(await screen.findByLabelText(BRAIN_PICKER)).toHaveValue('mock-brain');
	});

	it('replaces the three slots with one provider in realtime mode', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue(
			storedBlob({}, { pipeline: 'realtime' })
		);

		render(<VoiceProvidersPanel theme={mockTheme} enabled />);

		expect(await screen.findByText('Audio is sent to OpenAI.')).toBeInTheDocument();
		expect(screen.queryByLabelText('Speech-to-Text provider')).not.toBeInTheDocument();
	});
});
