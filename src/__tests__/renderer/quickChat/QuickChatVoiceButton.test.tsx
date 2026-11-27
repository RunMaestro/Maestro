/**
 * QuickChatVoiceButton - one button that is a tap and a walkie-talkie key.
 *
 * Idle it is a microphone icon; live it is the HUD's own indicator, so the
 * states look here the way they do everywhere else.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuickChatVoiceButton } from '../../../renderer/quickChat/QuickChatVoiceButton';
import type { QuickChatVoice } from '../../../renderer/hooks/voice/useQuickChatVoice';
import { useVoiceSessionStore } from '../../../renderer/stores/voiceSessionStore';
import { mockTheme } from '../../helpers/mockTheme';

const HOLD_MS = 250;

function makeVoice(overrides: Partial<QuickChatVoice> = {}): QuickChatVoice {
	return {
		enabled: true,
		active: false,
		visualState: 'idle-armed',
		partialTranscript: '',
		error: null,
		holdThresholdMs: HOLD_MS,
		toggle: vi.fn(),
		holdStart: vi.fn(),
		holdEnd: vi.fn(),
		...overrides,
	};
}

function renderButton(voice: QuickChatVoice) {
	render(<QuickChatVoiceButton theme={mockTheme} voice={voice} agentName="Pedsidian" />);
	return screen.getByTestId('quick-chat-voice-button');
}

beforeEach(() => {
	vi.useFakeTimers();
	useVoiceSessionStore.getState().reset();
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe('idle', () => {
	it('names who it talks to and both gestures', () => {
		const button = renderButton(makeVoice());

		expect(button).toHaveAttribute('aria-pressed', 'false');
		expect(button).toHaveAttribute(
			'aria-label',
			'Talk to Pedsidian. Click to start, or hold to talk.'
		);
		expect(screen.queryByRole('img')).toBeNull();
	});

	it('a quick press is a tap', () => {
		const voice = makeVoice();
		const button = renderButton(voice);

		fireEvent.pointerDown(button, { button: 0 });
		act(() => {
			vi.advanceTimersByTime(HOLD_MS - 50);
		});
		fireEvent.pointerUp(button);

		expect(voice.toggle).toHaveBeenCalledTimes(1);
		expect(voice.holdStart).not.toHaveBeenCalled();
	});

	it('a press past the threshold is push-to-talk, and the release sends', () => {
		const voice = makeVoice();
		const button = renderButton(voice);

		fireEvent.pointerDown(button, { button: 0 });
		act(() => {
			vi.advanceTimersByTime(HOLD_MS);
		});
		expect(voice.holdStart).toHaveBeenCalledTimes(1);
		expect(button).toHaveAttribute('aria-label', 'Release to send');

		fireEvent.pointerUp(button);

		expect(voice.holdEnd).toHaveBeenCalledTimes(1);
		// A hold is not also a tap: the session must survive the release.
		expect(voice.toggle).not.toHaveBeenCalled();
	});

	it('ignores a press that is not the primary button', () => {
		const voice = makeVoice();
		const button = renderButton(voice);

		fireEvent.pointerDown(button, { button: 2 });
		act(() => {
			vi.advanceTimersByTime(HOLD_MS * 2);
		});

		expect(voice.holdStart).not.toHaveBeenCalled();
	});

	it('keeps the caret in the composer: a click must not leave Space aimed at the microphone', () => {
		const button = renderButton(makeVoice());

		// `fireEvent` returns false when the handler prevented the default.
		expect(fireEvent.mouseDown(button)).toBe(false);
	});

	it('toggles from the keyboard, with no hold to get stuck open', () => {
		const voice = makeVoice();
		const button = renderButton(voice);

		fireEvent.keyDown(button, { key: 'Enter' });
		fireEvent.keyDown(button, { key: ' ' });
		fireEvent.keyDown(button, { key: 'a' });

		expect(voice.toggle).toHaveBeenCalledTimes(2);
		expect(voice.holdStart).not.toHaveBeenCalled();
	});
});

describe('with a live session', () => {
	it('draws the HUD indicator for the state, and says what a click does', () => {
		const button = renderButton(makeVoice({ active: true, visualState: 'listening' }));

		expect(button).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByTestId('voice-indicator-listening')).toBeInTheDocument();
		expect(button.getAttribute('aria-label')).toMatch(
			/^Listening\. The microphone is open\. Click to end the voice session/
		);
	});

	it('follows the session through thinking, speaking and a shut microphone', () => {
		const { rerender } = render(
			<QuickChatVoiceButton
				theme={mockTheme}
				voice={makeVoice({ active: true, visualState: 'thinking' })}
				agentName="Pedsidian"
			/>
		);
		expect(screen.getByTestId('voice-indicator-thinking')).toBeInTheDocument();

		rerender(
			<QuickChatVoiceButton
				theme={mockTheme}
				voice={makeVoice({ active: true, visualState: 'speaking' })}
				agentName="Pedsidian"
			/>
		);
		expect(screen.getByTestId('voice-indicator-speaking')).toBeInTheDocument();

		rerender(
			<QuickChatVoiceButton
				theme={mockTheme}
				voice={makeVoice({ active: true, visualState: 'paused' })}
				agentName="Pedsidian"
			/>
		);
		expect(screen.getByTestId('voice-indicator-paused')).toBeInTheDocument();
	});
});
