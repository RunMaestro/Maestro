/**
 * VoiceHud - the A Cappella overlay.
 *
 * What matters here: it is invisible and inert while the Encore Feature is off,
 * it renders what the event stream says (not what the caller hoped), listening
 * and speaking are distinguishable, and closing it ENDS the session rather than
 * leaving an open floor behind an invisible surface.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { VoiceHud } from '../../../../renderer/components/ACappella';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { VoiceEvent } from '../../../../shared/acappella/protocol';
import { mockTheme } from '../../../helpers/mockTheme';

const SESSION = 'voice-1';

let seq = 0;

function event<T extends VoiceEvent['type']>(
	type: T,
	body: Omit<Extract<VoiceEvent, { type: T }>, 'type' | 'sessionId' | 'seq' | 'ts'>
): VoiceEvent {
	seq += 1;
	return {
		type,
		sessionId: SESSION,
		seq,
		ts: 1_700_000_000_000 + seq,
		...body,
	} as unknown as VoiceEvent;
}

/** The handler the HUD registered with `voice.onEvent`. */
function emitter(): (event: VoiceEvent) => void {
	const calls = vi.mocked(window.maestro.voice.onEvent).mock.calls;
	return calls[calls.length - 1][0];
}

function emit(...events: VoiceEvent[]): void {
	const push = emitter();
	act(() => {
		for (const e of events) push(e);
	});
}

function renderHud(props: { enabled?: boolean; showDevHarness?: boolean } = {}) {
	return render(
		<LayerStackProvider>
			<VoiceHud
				theme={mockTheme}
				enabled={props.enabled ?? true}
				showDevHarness={props.showDevHarness ?? false}
			/>
		</LayerStackProvider>
	);
}

/** Drive the session to `listening`, which is where every turn starts. */
function startSession(): void {
	emit(
		event('wake', { source: 'client-button', scope: { kind: 'conductor' } }),
		event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' })
	);
}

beforeEach(() => {
	seq = 0;
	vi.clearAllMocks();
	vi.mocked(window.maestro.voice.onEvent).mockReturnValue(() => {});
	vi.mocked(window.maestro.voice.getState).mockResolvedValue(null);
	useVoiceSessionStore.getState().reset();
});

afterEach(() => {
	cleanup();
});

describe('VoiceHud gating', () => {
	it('renders nothing and subscribes to nothing when the Encore flag is off', () => {
		renderHud({ enabled: false, showDevHarness: true });
		expect(screen.queryByTestId('voice-hud')).toBeNull();
		expect(window.maestro.voice.onEvent).not.toHaveBeenCalled();
	});

	it('renders nothing while idle in a build without the dev harness', () => {
		renderHud();
		expect(screen.queryByTestId('voice-hud')).toBeNull();
	});

	it('shows the harness controls only in a dev build', () => {
		const { unmount } = renderHud();
		expect(screen.queryByTestId('voice-dev-harness')).toBeNull();
		unmount();

		renderHud({ showDevHarness: true });
		expect(screen.getByTestId('voice-dev-harness')).toBeTruthy();
	});

	it('clears mirrored state when the flag is turned off', () => {
		const { rerender } = renderHud();
		startSession();
		expect(useVoiceSessionStore.getState().state).toBe('listening');

		rerender(
			<LayerStackProvider>
				<VoiceHud theme={mockTheme} enabled={false} showDevHarness={false} />
			</LayerStackProvider>
		);
		expect(useVoiceSessionStore.getState().state).toBe('idle');
		expect(screen.queryByTestId('voice-hud')).toBeNull();
	});
});

describe('VoiceHud rendering', () => {
	it('appears with a listening indicator once a session opens', () => {
		renderHud();
		startSession();

		expect(screen.getByTestId('voice-hud')).toBeTruthy();
		expect(screen.getByTestId('voice-indicator-listening')).toBeTruthy();
		expect(screen.queryByTestId('voice-indicator-speaking')).toBeNull();
		expect(screen.getByText('Listening')).toBeTruthy();
		expect(screen.getByText('Conductor')).toBeTruthy();
	});

	it('streams the partial transcript and replaces it with the settled utterance', () => {
		renderHud();
		startSession();

		emit(event('partial-transcript', { text: 'start a new', stability: 0.4 }));
		expect(screen.getByTestId('voice-hud-partial').textContent).toBe('start a new');

		emit(event('final-transcript', { text: 'start a new tab', confidence: 1 }));
		expect(screen.queryByTestId('voice-hud-partial')).toBeNull();
		expect(screen.getByText('start a new tab')).toBeTruthy();
	});

	it('names the agent and tab a dispatch landed on', () => {
		renderHud();
		startSession();
		emit(
			event('dispatch', {
				agentSessionId: 'agent-1',
				agentName: 'Backend',
				tabId: 'tab-1',
				tabName: 'Auth Refactor',
				action: 'created',
				promptSent: true,
			})
		);
		expect(screen.getByText('Opened a new tab named Auth Refactor on Backend')).toBeTruthy();
	});

	it('switches the indicator and counts sentences while speaking', () => {
		renderHud();
		startSession();
		emit(
			event('speak-start', { utteranceId: 'u1', sentenceCount: 2, ttsProviderId: 'mock-tts' }),
			event('speak-sentence', { utteranceId: 'u1', index: 0, text: 'The tests pass.' })
		);

		expect(screen.getByTestId('voice-indicator-speaking')).toBeTruthy();
		expect(screen.queryByTestId('voice-indicator-listening')).toBeNull();
		expect(screen.getByTestId('voice-hud-speech-progress').textContent).toBe('1 of 2');
		expect(screen.getByTestId('voice-hud-spoken').textContent).toContain('The tests pass.');
	});

	it('marks a barge-in as a cut and hands the floor back', () => {
		renderHud();
		startSession();
		emit(
			event('speak-start', { utteranceId: 'u1', sentenceCount: 3, ttsProviderId: 'mock-tts' }),
			event('speak-sentence', { utteranceId: 'u1', index: 0, text: 'The tests pass.' }),
			event('barge-in', { source: 'client-button', cancelledUtteranceId: 'u1' }),
			event('speak-end', { utteranceId: 'u1', reason: 'cancelled' }),
			event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' })
		);

		expect(screen.getByTestId('voice-hud-spoken').textContent).toContain('(cut off)');
		// Barge-in keeps the floor: the session is listening, not gone.
		expect(screen.getByTestId('voice-indicator-listening')).toBeTruthy();
		expect(screen.getByText('Listening')).toBeTruthy();
	});

	it('surfaces a provider substitution rather than running the mock quietly', async () => {
		vi.mocked(window.maestro.voice.start).mockResolvedValue({
			snapshot: {
				sessionId: SESSION,
				state: 'listening',
				scope: { kind: 'conductor' },
				seq: 2,
				startedAt: 0,
				providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
			},
			substitutions: [
				{
					role: 'stt',
					requestedId: 'whisper-local',
					resolvedId: 'mock-stt',
					reason: 'unavailable',
					message: "Voice provider 'whisper-local' is not available; using 'mock-stt'",
				},
			],
		});

		renderHud({ showDevHarness: true });
		const input = screen.getByTestId('voice-dev-harness-input');
		fireEvent.change(input, { target: { value: 'hello' } });
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-dev-harness-send'));
		});

		expect(screen.getByTestId('voice-hud-substitutions').textContent).toContain('whisper-local');
	});

	it('warns when the event stream skipped a seq', () => {
		renderHud();
		startSession();
		seq = 42;
		emit(event('partial-transcript', { text: 'hello', stability: 0.5 }));
		expect(screen.getByTestId('voice-hud-gap')).toBeTruthy();
	});
});

describe('VoiceHud dismissal', () => {
	it('ends the session and hides when the ESC pill is clicked', async () => {
		renderHud();
		startSession();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-close'));
		});

		expect(window.maestro.voice.stop).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('voice-hud')).toBeNull();
	});

	it('comes back for the next session rather than staying dismissed forever', async () => {
		renderHud();
		startSession();
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-close'));
		});
		expect(screen.queryByTestId('voice-hud')).toBeNull();

		act(() => {
			emitter()({
				type: 'wake',
				sessionId: 'voice-2',
				seq: 1,
				ts: 1_700_000_100_000,
				source: 'client-button',
				scope: { kind: 'conductor' },
			});
		});
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
	});
});

describe('VoiceDevHarness', () => {
	it('starts a session on the first Send, so enabling the feature opens nothing', async () => {
		renderHud({ showDevHarness: true });
		expect(window.maestro.voice.start).not.toHaveBeenCalled();

		fireEvent.change(screen.getByTestId('voice-dev-harness-input'), {
			target: { value: 'open a new tab on backend' },
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-dev-harness-send'));
		});

		expect(window.maestro.voice.start).toHaveBeenCalledTimes(1);
		expect(window.maestro.voice.submitUtterance).toHaveBeenCalledWith('open a new tab on backend');
	});

	it('keeps Interrupt and Stop as different actions', async () => {
		renderHud({ showDevHarness: true });
		startSession();

		// Nothing is speaking yet, so barge-in is not offered.
		expect(screen.getByTestId('voice-dev-harness-interrupt')).toHaveProperty('disabled', true);
		expect(screen.getByTestId('voice-dev-harness-stop')).toHaveProperty('disabled', false);

		emit(event('speak-start', { utteranceId: 'u1', sentenceCount: 1, ttsProviderId: 'mock-tts' }));
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-dev-harness-interrupt'));
		});
		expect(window.maestro.voice.interrupt).toHaveBeenCalledWith('client-button');
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-dev-harness-stop'));
		});
		expect(window.maestro.voice.stop).toHaveBeenCalledTimes(1);
	});

	it('offers Reply only while the session waits on one, and addresses it to the dispatched tab', async () => {
		renderHud({ showDevHarness: true });
		startSession();
		expect(screen.getByTestId('voice-dev-harness-reply')).toHaveProperty('disabled', true);

		emit(
			event('route-decision', {
				decision: {
					target: { sessionId: 'agent-1' },
					tabAction: 'new',
					prompt: 'refactor auth',
					confidence: 0.8,
				},
				brainProviderId: 'mock-brain',
				latencyMs: 2,
			}),
			event('dispatch', {
				agentSessionId: 'agent-1',
				agentName: 'Backend',
				tabId: 'tab-7',
				tabName: 'Auth Refactor',
				action: 'created',
				promptSent: true,
			})
		);

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-dev-harness-reply'));
		});
		expect(window.maestro.voice.submitAgentReply).toHaveBeenCalledWith(
			expect.objectContaining({ agentSessionId: 'agent-1', tabId: 'tab-7' })
		);
	});
});
