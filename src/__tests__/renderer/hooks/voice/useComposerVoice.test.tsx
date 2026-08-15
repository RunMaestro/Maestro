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
	useVoiceUiStore.setState({ wakePhrases: {}, loaded: true });
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

	it('hard-disables the Web Speech path, so one button cannot open two microphones', () => {
		render(true);
		expect(webSpeechDisabled).toBe(true);
	});

	it('ends the session on a second press rather than starting a second one', async () => {
		const { result, rerender } = render(true);
		act(() => {
			useVoiceSessionStore.setState({
				state: 'listening',
				scope: { kind: 'agent', sessionId: 'agent-1' },
			});
		});
		rerender();

		expect(result.current.isListening).toBe(true);
		await act(async () => {
			result.current.toggle();
		});

		expect(window.maestro.voice.stop).toHaveBeenCalledTimes(1);
		expect(window.maestro.voice.start).not.toHaveBeenCalled();
	});
});
