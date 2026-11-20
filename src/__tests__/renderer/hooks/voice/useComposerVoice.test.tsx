/**
 * The composer microphone button, and which of the two voice stacks it drives.
 *
 * The behaviour that has to survive: turning the A Cappella Encore Feature ON
 * must not open two microphones, and leaving it OFF must not take Web Speech
 * dictation away from the people who have never turned it on - which is
 * everyone, by default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useComposerVoice } from '../../../../renderer/hooks/voice/useComposerVoice';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import type { Session } from '../../../../renderer/types';

const session = { id: 'agent-1', name: 'Backend' } as Session;

const startVoiceInput = vi.fn();
const stopVoiceInput = vi.fn();
const toggleVoiceInput = vi.fn();
let webSpeechDisabled = false;

vi.mock('../../../../renderer/hooks/utils/useVoiceInput', () => ({
	useVoiceInput: (options: { disabled?: boolean }) => {
		webSpeechDisabled = options.disabled === true;
		return {
			isListening: false,
			voiceSupported: true,
			startVoiceInput,
			stopVoiceInput,
			toggleVoiceInput,
		};
	},
}));

function render(enabled: boolean) {
	useSettingsStore.setState({ encoreFeatures: { aCappella: enabled } } as never);
	return renderHook(() =>
		useComposerVoice({
			session,
			currentValue: '',
			onTranscriptionChange: vi.fn(),
		})
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	webSpeechDisabled = false;
	useVoiceSessionStore.getState().reset();
	useVoiceUiStore.setState({
		wakePhrases: {},
		loaded: true,
		minimized: false,
		listenMode: 'hands-free',
		defaultMode: 'agent',
	});
});

afterEach(() => {
	cleanup();
});

describe('with A Cappella off', () => {
	it('keeps the Web Speech dictation exactly as it was', async () => {
		const { result } = render(false);
		expect(result.current.usesACappella).toBe(false);
		expect(webSpeechDisabled).toBe(false);

		await act(async () => {
			result.current.toggle();
		});

		expect(toggleVoiceInput).toHaveBeenCalledTimes(1);
		expect(window.maestro.voice.start).not.toHaveBeenCalled();
	});
});

describe('with A Cappella on', () => {
	it('reveals a live default Conductor session without starting it again', async () => {
		useVoiceUiStore.setState({ defaultMode: 'conductor', minimized: true });
		useVoiceSessionStore.setState({ state: 'listening', scope: { kind: 'conductor' } });
		const { result } = render(true);
		expect(result.current.isListening).toBe(true);
		await act(async () => result.current.toggle());
		expect(useVoiceUiStore.getState().minimized).toBe(false);
		expect(window.maestro.voice.start).not.toHaveBeenCalled();
	});
	it('uses the configured default Conductor mode from the composer', async () => {
		useVoiceUiStore.setState({ defaultMode: 'conductor' });
		const { result } = render(true);
		await act(async () => result.current.toggle());
		expect(window.maestro.voice.start).toHaveBeenCalledWith({ kind: 'conductor' });
	});
	it('opens a voice session bound to this agent instead of dictating', async () => {
		const { result } = render(true);
		expect(result.current.usesACappella).toBe(true);

		await act(async () => {
			result.current.toggle();
		});

		expect(window.maestro.voice.start).toHaveBeenCalledWith({
			kind: 'agent',
			sessionId: 'agent-1',
		});
		expect(toggleVoiceInput).not.toHaveBeenCalled();
	});

	it('surfaces a provider downgrade reported by the start', async () => {
		// The failure this guards: the composer microphone called
		// `window.maestro.voice.start()` for its side effect and threw the result
		// away, so a build whose speech-to-text had fallen back to the mock tier
		// said "Listening" and explained nothing. The registry refuses to
		// substitute silently; dropping the report here undid that at the last hop.
		const substitution = {
			role: 'stt' as const,
			requestedId: 'echo-stt',
			resolvedId: 'mock-stt',
			reason: 'unavailable' as const,
		};
		vi.mocked(window.maestro.voice.start).mockResolvedValueOnce({
			snapshot: {
				sessionId: 'voice-1',
				state: 'listening',
				scope: { kind: 'agent', sessionId: 'agent-1' },
				seq: 1,
				startedAt: 0,
				providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
			},
			substitutions: [substitution],
		} as never);

		const { result } = render(true);
		await act(async () => {
			result.current.toggle();
		});

		expect(useVoiceSessionStore.getState().substitutions).toEqual([substitution]);
	});

	it('hard-disables the Web Speech path, so one button cannot open two microphones', () => {
		render(true);
		expect(webSpeechDisabled).toBe(true);
	});

	it('brings a minimized HUD back on a second press, and keeps the session listening', async () => {
		// The regression: minimizing the HUD and reaching for the microphone again
		// ended the session the user had asked to keep. Only Escape on the HUD
		// closes a voice session; this button opens and restores.
		const { result, rerender } = render(true);
		act(() => {
			useVoiceSessionStore.setState({
				state: 'listening',
				scope: { kind: 'agent', sessionId: 'agent-1' },
			});
			useVoiceUiStore.setState({ minimized: true });
		});
		rerender();

		expect(result.current.isListening).toBe(true);
		await act(async () => {
			result.current.toggle();
		});

		expect(useVoiceUiStore.getState().minimized).toBe(false);
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		expect(window.maestro.voice.start).not.toHaveBeenCalled();
	});

	it('un-dismisses the HUD too, without starting a second session', async () => {
		const { result, rerender } = render(true);
		act(() => {
			useVoiceSessionStore.setState({
				state: 'listening',
				scope: { kind: 'agent', sessionId: 'agent-1' },
				dismissed: true,
			});
		});
		rerender();

		await act(async () => {
			result.current.toggle();
		});

		expect(useVoiceSessionStore.getState().dismissed).toBe(false);
		expect(window.maestro.voice.start).not.toHaveBeenCalled();
	});

	it('starts gated in push-to-talk, so the microphone is not open before the first hold', async () => {
		useVoiceUiStore.setState({ listenMode: 'push-to-talk' });
		const { result } = render(true);

		await act(async () => {
			result.current.toggle();
		});

		expect(window.maestro.voice.start).toHaveBeenCalledWith(
			{ kind: 'agent', sessionId: 'agent-1' },
			{ paused: true }
		);
	});
});
