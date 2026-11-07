/**
 * @file VoiceControlsPanel.test.tsx
 *
 * The panel's defining property for the hotkey rows: **what they show is what is
 * actually bound.**
 *
 * The failure this suite exists to prevent was real and silent. Main registers a
 * voice hotkey from `defaultGlobalHotkeyKeys(id)` whenever the stored shortcuts
 * map has no entry, which is the ordinary state of any profile that existed
 * before these hotkeys did. The panel read only that map, so it told those users
 * "Click to set" and "Registered as (none)" about a combo that was live, working,
 * and holding a system-wide accelerator. A settings row that disagrees with the
 * registry is worse than no row: it invites the user to bind a second combo for a
 * hotkey they already have.
 *
 * The other half of the same rule is that an explicitly CLEARED binding still
 * reads as cleared, which is why the fallback is nullish rather than truthy: an
 * entry with an empty key array is a decision, not an absence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { VoiceControlsPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceControlsPanel';
import type { Shortcut } from '../../../../../renderer/types';
import { mockTheme } from '../../../../helpers/mockTheme';
import type { VoiceSettingsBlob } from '../../../../../renderer/services/voiceSettings';

const voice = () => window.maestro.voice;

/** The stored `shortcuts` map, swapped per test before render. */
let mockShortcuts: Record<string, Shortcut> = {};
const mockSetShortcuts = vi.fn();

vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		shortcuts: mockShortcuts,
		setShortcuts: mockSetShortcuts,
		tabShortcuts: {},
		setTabShortcuts: vi.fn(),
	}),
}));

/** What main reports for a hotkey it has actually bound. */
function registered(id: string, keys: string[], accelerator: string) {
	return { id, keys, accelerator, registered: true };
}

describe('VoiceControlsPanel hotkey rows', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockShortcuts = {};
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		vi.mocked(voice().getRoster).mockResolvedValue([]);
		vi.mocked(voice().hotkeyStatus).mockResolvedValue({
			statuses: [
				registered('voiceConductor', ['Meta', 'Alt', 'v'], 'Command+Alt+V'),
				registered('voiceCurrentAgent', ['Meta', 'Alt', 'a'], 'Command+Alt+A'),
			],
			note: 'Tap to toggle the microphone.',
		});
	});

	it('shows the combo main actually registered when the stored map has no entry', async () => {
		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		// Two rows, both bound, and neither of them inviting the user to set a
		// hotkey that is already holding a system-wide accelerator.
		await waitFor(() => {
			expect(screen.queryAllByText('(none)')).toHaveLength(0);
		});
		expect(screen.queryAllByText('Click to set')).toHaveLength(0);
	});

	it('still reads as unset when the user has explicitly cleared the binding', async () => {
		mockShortcuts = {
			voiceConductor: { id: 'voiceConductor', label: 'Talk to Maestro', keys: [] },
		};
		vi.mocked(voice().hotkeyStatus).mockResolvedValue({
			statuses: [
				{
					id: 'voiceConductor',
					keys: [],
					accelerator: null,
					registered: false,
					reason: 'invalid-accelerator' as const,
					message: 'No key is bound.',
				},
				registered('voiceCurrentAgent', ['Meta', 'Alt', 'a'], 'Command+Alt+A'),
			],
			note: 'Tap to toggle the microphone.',
		});

		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		// Exactly one row is empty: the cleared one. An empty array is a decision,
		// so it must not fall through to the shipped default.
		await waitFor(() => {
			expect(screen.getAllByText('Click to set')).toHaveLength(1);
		});
	});

	it('prefers a user rebinding over both the registry and the default', async () => {
		mockShortcuts = {
			voiceConductor: {
				id: 'voiceConductor',
				label: 'Talk to Maestro',
				keys: ['Meta', 'Alt', 'j'],
			},
		};

		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		await waitFor(() => {
			expect(screen.getAllByText(/J$/).length).toBeGreaterThan(0);
		});
	});
});

describe('VoiceControlsPanel wake word Test', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mockShortcuts = {};
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		vi.mocked(voice().getRoster).mockResolvedValue([]);
		vi.mocked(voice().hotkeyStatus).mockResolvedValue({ statuses: [], note: '' });
	});

	it('shows why the phrase cannot fire instead of listening forever', async () => {
		vi.mocked(voice().wakeTest).mockResolvedValue({
			started: false,
			reason: 'Wake word: no detector has been trained for the wake phrase, so it cannot fire.',
		});
		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		fireEvent.click(screen.getByRole('button', { name: 'Test' }));

		expect(await screen.findByText(/cannot fire/)).toBeTruthy();
		// Refused, so the button never flips to a listening state.
		expect(screen.queryByRole('button', { name: 'Stop test' })).toBeNull();
	});

	it('listens when the main process starts the run', async () => {
		vi.mocked(voice().wakeTest).mockResolvedValue({ started: true });
		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		fireEvent.click(screen.getByRole('button', { name: 'Test' }));

		expect(await screen.findByRole('button', { name: 'Stop test' })).toBeTruthy();
		expect(screen.getByText('Listening. Say the phrase.')).toBeTruthy();
	});

	it('lights up and counts every detection, including identical repeated hits', async () => {
		vi.mocked(voice().wakeTest).mockResolvedValue({ started: true });
		render(<VoiceControlsPanel theme={mockTheme} enabled />);
		fireEvent.click(screen.getByRole('button', { name: 'Test' }));
		await screen.findByRole('button', { name: 'Stop test' });
		vi.useFakeTimers();
		const hit = vi.mocked(voice().onWakeTest).mock.calls.at(-1)![0];
		const detection = { phraseId: 'global', phrase: 'hey jarvis', score: 0.9, at: 1 };

		act(() => hit(detection));
		expect(screen.getByTestId('wake-detection-light')).toHaveAttribute('data-active', 'true');
		expect(screen.getByRole('status')).toHaveTextContent('Heard "hey jarvis" (0.90) · 1 detection');
		act(() => vi.advanceTimersByTime(1_000));
		expect(screen.getByTestId('wake-detection-light')).toHaveAttribute('data-active', 'false');
		act(() => hit(detection));
		expect(screen.getByTestId('wake-detection-light')).toHaveAttribute('data-active', 'true');
		expect(screen.getByRole('status')).toHaveTextContent('2 detections');
	});

	it('also lights up for a hands-free wake without starting a test', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			controls: { wakeWordEnabled: true, wakePhrase: 'hey jarvis' },
		});
		render(<VoiceControlsPanel theme={mockTheme} enabled />);
		await screen.findByText('Say "hey jarvis" and watch for a detection.');
		const event = vi.mocked(voice().onEvent).mock.calls.at(-1)![0];
		const wake = {
			type: 'wake' as const,
			source: 'wake-word' as const,
			sessionId: 'voice-1',
			seq: 1,
			ts: 1,
			scope: { kind: 'conductor' as const },
		};

		act(() => event({ ...wake, source: 'hotkey' }));
		expect(screen.getByTestId('wake-detection-light')).toHaveAttribute('data-active', 'false');
		act(() => event(wake));
		expect(screen.getByTestId('wake-detection-light')).toHaveAttribute('data-active', 'true');
		expect(screen.getByRole('status')).toHaveTextContent('Wake phrase detected · 1 detection');
		expect(voice().wakeTest).not.toHaveBeenCalled();
	});

	it('unsubscribes and stops the test when the panel closes', async () => {
		const cleanupTest = vi.fn();
		const cleanupEvents = vi.fn();
		vi.mocked(voice().onWakeTest).mockReturnValueOnce(cleanupTest);
		vi.mocked(voice().onEvent).mockReturnValueOnce(cleanupEvents);
		const { unmount } = render(<VoiceControlsPanel theme={mockTheme} enabled />);
		await screen.findByDisplayValue('Hey Jarvis');

		unmount();

		expect(cleanupTest).toHaveBeenCalled();
		expect(cleanupEvents).toHaveBeenCalled();
		expect(voice().wakeTestStop).toHaveBeenCalled();
	});

	it('does not subscribe to wake events when disabled', () => {
		render(<VoiceControlsPanel theme={mockTheme} enabled={false} />);

		expect(voice().onWakeTest).not.toHaveBeenCalled();
		expect(voice().onEvent).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Reset wake phrase to default' })).toBeDisabled();
	});

	it.each(['okay computer', 'hey jarvis'])(
		'resets "%s" to the capitalized default and preserves other settings',
		async (wakePhrase) => {
			vi.mocked(window.maestro.settings.get).mockResolvedValue({
				providers: { stt: 'parakeet-local' },
				controls: { wakePhrase, wakeSensitivity: 0.7 },
			});
			render(<VoiceControlsPanel theme={mockTheme} enabled />);
			await screen.findByDisplayValue(wakePhrase);

			fireEvent.click(screen.getByRole('button', { name: 'Reset wake phrase to default' }));

			await waitFor(() => {
				expect(window.maestro.settings.set).toHaveBeenCalledWith('acappella', {
					providers: { stt: 'parakeet-local' },
					controls: { wakePhrase: 'Hey Jarvis', wakeSensitivity: 0.7 },
				});
			});
			expect(screen.getByLabelText('Phrase')).toHaveValue('Hey Jarvis');
			expect(screen.getByRole('button', { name: 'Reset wake phrase to default' })).toBeDisabled();
		}
	);

	it('displays the capitalized default without an unnecessary reset', async () => {
		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		await screen.findByDisplayValue('Hey Jarvis');
		expect(screen.getByRole('button', { name: 'Reset wake phrase to default' })).toBeDisabled();
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});
});

describe('VoiceControlsPanel per-agent phrases', () => {
	let stored: VoiceSettingsBlob;
	beforeEach(() => {
		vi.clearAllMocks();
		mockShortcuts = {};
		stored = { controls: { agentPhrases: [{ agentSessionId: 'a', phrase: 'hello alpha' }] } };
		vi.mocked(window.maestro.settings.get).mockImplementation(async () => stored);
		vi.mocked(window.maestro.settings.set).mockImplementation(async (_key, value) => {
			stored = value as VoiceSettingsBlob;
		});
		vi.mocked(voice().getRoster).mockResolvedValue([
			{ sessionId: 'a', name: 'Alpha', agentType: 'codex', cwd: '/alpha', tabs: [] },
			{ sessionId: 'b', name: 'Beta', agentType: 'codex', cwd: '/beta', tabs: [] },
			{ sessionId: 'c', name: 'Gamma', agentType: 'codex', cwd: '/gamma', tabs: [] },
		]);
		vi.mocked(voice().hotkeyStatus).mockResolvedValue({ statuses: [], note: '' });
	});

	afterEach(() => {
		vi.mocked(window.maestro.settings.set).mockReset();
		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
	});

	it('shows only configured phrases, then filters and adds an agent without saving a blank entry', async () => {
		render(<VoiceControlsPanel theme={mockTheme} enabled />);
		expect(await screen.findByLabelText('Wake phrase for Alpha')).toHaveValue('hello alpha');
		expect(screen.queryByLabelText('Wake phrase for Beta')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Add agent wake phrase' }));
		expect(screen.queryByRole('option', { name: 'Alpha' })).not.toBeInTheDocument();
		fireEvent.change(screen.getByRole('textbox', { name: 'Filter agents...' }), {
			target: { value: 'BETA' },
		});
		expect(screen.queryByRole('option', { name: 'Gamma' })).not.toBeInTheDocument();
		fireEvent.keyDown(screen.getByRole('textbox', { name: 'Filter agents...' }), { key: 'Enter' });
		expect(screen.getByLabelText('Wake phrase for Beta')).toHaveValue('');
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText('Wake phrase for Beta'), {
			target: { value: 'hello beta' },
		});
		await waitFor(() =>
			expect(stored.controls?.agentPhrases).toEqual([
				{ agentSessionId: 'a', phrase: 'hello alpha' },
				{ agentSessionId: 'b', phrase: 'hello beta' },
			])
		);
		fireEvent.click(screen.getByRole('button', { name: 'Add agent wake phrase' }));
		expect(screen.getAllByRole('option')).toHaveLength(1);
		expect(screen.getByRole('option', { name: 'Gamma' })).toBeInTheDocument();
	});

	it('keeps a cleared field editable until removed, and makes the agent available again', async () => {
		render(<VoiceControlsPanel theme={mockTheme} enabled />);
		const input = await screen.findByLabelText('Wake phrase for Alpha');
		fireEvent.change(input, { target: { value: '' } });
		expect(screen.getByLabelText('Wake phrase for Alpha')).toHaveValue('');
		await waitFor(() => expect(stored.controls?.agentPhrases).toEqual([]));
		fireEvent.click(screen.getByRole('button', { name: 'Remove wake phrase for Alpha' }));
		expect(screen.queryByLabelText('Wake phrase for Alpha')).not.toBeInTheDocument();
		expect(screen.getByText('No per-agent phrases configured.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Add agent wake phrase' }));
		expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
		await waitFor(() => expect(window.maestro.settings.set).toHaveBeenCalledTimes(2));
	});

	it('disables adding when no agents exist or voice controls are disabled', async () => {
		vi.mocked(voice().getRoster).mockResolvedValue([]);
		const { rerender } = render(<VoiceControlsPanel theme={mockTheme} enabled />);
		await waitFor(() => expect(voice().getRoster).toHaveBeenCalled());
		expect(screen.getByRole('button', { name: 'Add agent wake phrase' })).toBeDisabled();
		rerender(<VoiceControlsPanel theme={mockTheme} enabled={false} />);
		expect(screen.getByRole('button', { name: 'Add agent wake phrase' })).toBeDisabled();
	});
});

describe('VoiceControlsPanel send phrases', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockShortcuts = {};
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		vi.mocked(voice().getRoster).mockResolvedValue([]);
		vi.mocked(voice().hotkeyStatus).mockResolvedValue({ statuses: [], note: '' });
	});

	const phrasesInput = () => screen.getByLabelText('Send phrases') as HTMLInputElement;

	it('offers the field without "Wait for me to say send", leading with the new default', async () => {
		// A send phrase ends a request in both modes. Hidden behind the toggle it
		// worked for everyone and could be changed by almost no one.
		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		await waitFor(() => {
			expect(phrasesInput().value).toBe('go maestro');
		});
		expect(screen.queryByLabelText('Send after')).toBeNull();
	});

	it('reads the old shipped list as never chosen, and an edited one as chosen', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			controls: { sendPhrases: "good to go, that's it, send it, go ahead, make it so" },
		});
		const { unmount } = render(<VoiceControlsPanel theme={mockTheme} enabled />);
		await waitFor(() => {
			expect(phrasesInput().value.startsWith('go maestro')).toBe(true);
		});
		unmount();

		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			controls: { sendPhrases: 'good to go' },
		});
		render(<VoiceControlsPanel theme={mockTheme} enabled />);
		await waitFor(() => {
			expect(phrasesInput().value).toBe('good to go');
		});
	});

	it('stores an edit as that one field, not as the whole form', async () => {
		vi.mocked(window.maestro.settings.get).mockResolvedValue({
			providers: { stt: 'parakeet-local' },
			controls: { wakePhrase: 'okay computer' },
		});
		render(<VoiceControlsPanel theme={mockTheme} enabled />);
		await waitFor(() => {
			expect(phrasesInput().value.startsWith('go maestro')).toBe(true);
		});

		fireEvent.change(phrasesInput(), { target: { value: 'ship it' } });

		// Saving every field here is what froze the old default phrases, and the
		// old default wake phrase before them, into settings nobody had chosen.
		await waitFor(() => {
			expect(window.maestro.settings.set).toHaveBeenCalledWith('acappella', {
				providers: { stt: 'parakeet-local' },
				controls: { wakePhrase: 'okay computer', sendPhrases: 'ship it' },
			});
		});
	});
});
