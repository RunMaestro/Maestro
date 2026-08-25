/**
 * @file VoiceDiagnosticsCard.test.tsx
 *
 * The panel someone opens after voice did nothing. It is only worth having if it
 * distinguishes the failures that look identical from the outside: a microphone
 * producing no signal, a microphone producing signal nobody classifies as
 * speech, and a recogniser that was never going to transcribe anything.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { VoiceDiagnosticsCard } from '../../../../../renderer/components/Settings/ACappella/VoiceDiagnosticsCard';
import { useVoiceDiagnosticsStore } from '../../../../../renderer/stores/voiceDiagnosticsStore';
import { useVoiceSessionStore } from '../../../../../renderer/stores/voiceSessionStore';
import { mockTheme } from '../../../../helpers/mockTheme';

function renderCard() {
	return render(<VoiceDiagnosticsCard theme={mockTheme} />);
}

beforeEach(() => {
	vi.clearAllMocks();
	useVoiceDiagnosticsStore.getState().clear();
	useVoiceSessionStore.getState().reset();
});

afterEach(() => cleanup());

describe('VoiceDiagnosticsCard', () => {
	it('says plainly when no audio has arrived', () => {
		renderCard();

		expect(screen.getByText(/No audio frames yet/)).toBeTruthy();
	});

	it('reports frames, peak and speech count once audio flows', () => {
		useVoiceDiagnosticsStore.setState({
			audioLevelCount: 71,
			audioLevelPeak: 0.42,
			speechFrames: 12,
		});

		renderCard();

		expect(screen.getByText(/71 frames/)).toBeTruthy();
		expect(screen.getByText(/12 classified as speech/)).toBeTruthy();
	});

	it('names a recogniser that does not listen to the microphone', () => {
		// The case that cost six rebuilds: everything else looks healthy.
		useVoiceSessionStore.setState({
			providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
			sttHearsAudio: false,
		});

		renderCard();

		expect(screen.getByText(/does not listen to the microphone/)).toBeTruthy();
	});

	it('renders the recorded event log', () => {
		useVoiceDiagnosticsStore.getState().record({
			type: 'session-error',
			sessionId: 'voice-1',
			seq: 1,
			ts: 1_700_000_000_000,
			code: 'provider-unavailable',
			message: 'whisper.cpp is not part of this build yet.',
			recoverable: false,
		} as never);

		renderCard();

		expect(screen.getByTestId('voice-diagnostics-log').textContent).toContain('whisper.cpp');
	});

	it('offers nothing to copy before anything has been recorded', () => {
		// A copy button that yields an empty report is a support thread with no
		// information in it.
		renderCard();

		expect(screen.getByText('Copy diagnostics')).toHaveProperty('disabled', true);
	});
});
