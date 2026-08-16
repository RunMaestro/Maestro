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
import { VoiceHud, VoiceStatusIndicator } from '../../../../renderer/components/ACappella';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
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

/**
 * Let the mocked ResizeObserver deliver its measurement.
 *
 * jsdom has no layout engine, so the transcript's virtualizer sees a zero
 * viewport and renders no rows until `setup.ts`'s observer fires - and it fires
 * on a `setTimeout(0)`. A test that reads the scrollback without this asserts
 * against an empty list and passes for the wrong reason.
 */
async function flushLayout(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function renderHud(
	props: {
		enabled?: boolean;
		showDevHarness?: boolean;
		transcript?: boolean;
		/**
		 * Also mount the Left Bar indicator, which is where a minimized HUD lives.
		 * Off by default so the HUD's own tests render only the HUD.
		 */
		withStatusIndicator?: boolean;
	} = {}
) {
	// The transcript is off by default and lives behind the toggle, so a test
	// that wants to read the scrollback has to open it - exactly as a user does.
	useVoiceUiStore.setState({ transcriptVisible: props.transcript === true, loaded: true });
	// The HUD takes the Encore flag as a prop; the Left Bar indicator reads it
	// from the store, the way every other Left Bar surface does.
	if (props.withStatusIndicator) {
		useSettingsStore.setState((state) => ({
			encoreFeatures: { ...state.encoreFeatures, aCappella: props.enabled ?? true },
		}));
	}
	return render(
		<LayerStackProvider>
			<VoiceHud
				theme={mockTheme}
				enabled={props.enabled ?? true}
				showDevHarness={props.showDevHarness ?? false}
			/>
			{props.withStatusIndicator && <VoiceStatusIndicator theme={mockTheme} />}
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
	useVoiceUiStore.setState({
		transcriptVisible: false,
		hudPosition: null,
		minimizeBehavior: 'manual',
		minimized: false,
		muted: false,
		loaded: true,
	});
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
		expect(screen.getByTestId('voice-hud-scope').textContent).toBe('Conductor');
	});

	it('shows the live hypothesis on the collapsed HUD without opening the transcript', () => {
		renderHud();
		startSession();

		emit(event('partial-transcript', { text: 'start a new', stability: 0.4 }));
		expect(screen.getByTestId('voice-hud-latest').textContent).toBe('start a new');

		// The settled utterance belongs to the scrollback, which is closed. The
		// one-line readout is for what is happening NOW, not a running history.
		emit(event('final-transcript', { text: 'start a new tab', confidence: 1 }));
		expect(screen.queryByTestId('voice-hud-latest')).toBeNull();
	});

	it('streams the partial transcript and settles it into the transcript', async () => {
		renderHud({ transcript: true });
		startSession();

		emit(event('partial-transcript', { text: 'start a new', stability: 0.4 }));
		expect(screen.getByTestId('voice-transcript-partial').textContent).toBe('start a new');

		emit(event('final-transcript', { text: 'start a new tab', confidence: 1 }));
		await flushLayout();
		expect(screen.queryByTestId('voice-transcript-partial')).toBeNull();
		expect(screen.getByText('start a new tab')).toBeTruthy();
	});

	it('names the agent and tab a dispatch landed on', async () => {
		renderHud({ transcript: true });
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
		await flushLayout();
		expect(screen.getByText('Opened a new tab named Auth Refactor on Backend')).toBeTruthy();
		// The bound scope is the prominent line, and a dispatch names the tab on it.
		expect(screen.getByTestId('voice-hud-scope').textContent).toContain('Auth Refactor');
	});

	it('switches the indicator and counts sentences while speaking', () => {
		renderHud({ transcript: true });
		startSession();
		emit(
			event('speak-start', { utteranceId: 'u1', sentenceCount: 2, ttsProviderId: 'mock-tts' }),
			event('speak-sentence', { utteranceId: 'u1', index: 0, text: 'The tests pass.' })
		);

		expect(screen.getByTestId('voice-indicator-speaking')).toBeTruthy();
		expect(screen.queryByTestId('voice-indicator-listening')).toBeNull();
		expect(screen.getByTestId('voice-hud-speech-progress').textContent).toBe('1 of 2');
		expect(screen.getByTestId('voice-transcript-spoken').textContent).toContain('The tests pass.');
	});

	it('marks the total provisional while the reply is still being written', () => {
		// A streamed reply starts speaking before the sentence count is known, so
		// the count at `speak-start` is a lower bound the delivered index runs past.
		// The live app printed "1 of 0" here.
		renderHud({ transcript: true });
		startSession();
		emit(
			event('speak-start', {
				utteranceId: 'u1',
				sentenceCount: 0,
				ttsProviderId: 'mock-tts',
				streaming: true,
			}),
			event('speak-sentence', { utteranceId: 'u1', index: 0, text: 'On it.' })
		);

		expect(screen.getByTestId('voice-hud-speech-progress').textContent).toBe('1 of 1+');
	});

	it('marks a barge-in as a cut and hands the floor back', () => {
		renderHud({ transcript: true });
		startSession();
		emit(
			event('speak-start', { utteranceId: 'u1', sentenceCount: 3, ttsProviderId: 'mock-tts' }),
			event('speak-sentence', { utteranceId: 'u1', index: 0, text: 'The tests pass.' }),
			event('barge-in', { source: 'client-button', cancelledUtteranceId: 'u1' }),
			event('speak-end', { utteranceId: 'u1', reason: 'cancelled' }),
			event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' })
		);

		expect(screen.getByTestId('voice-transcript-spoken').textContent).toContain('(cut off)');
		// Barge-in keeps the floor: the session is listening, not gone.
		expect(screen.getByTestId('voice-indicator-listening')).toBeTruthy();
	});

	it('shows a thinking state for the whole route-and-dispatch stretch', () => {
		renderHud();
		startSession();
		emit(event('final-transcript', { text: 'refactor auth', confidence: 1 }));
		expect(screen.getByTestId('voice-indicator-thinking')).toBeTruthy();
		expect(screen.getByText('Thinking')).toBeTruthy();
	});

	it('shows an error state rather than pretending the session is idle', () => {
		renderHud();
		startSession();
		emit(
			event('session-error', {
				code: 'provider-unavailable',
				message: 'The speech engine is not installed',
				recoverable: false,
			})
		);
		expect(screen.getByTestId('voice-indicator-error')).toBeTruthy();
		expect(screen.getByTestId('voice-hud-error')).toBeTruthy();
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

describe('VoiceHud audio', () => {
	function micEvent(
		overrides: Partial<Omit<Extract<VoiceEvent, { type: 'mic-state' }>, 'type'>> = {}
	): VoiceEvent {
		return event('mic-state', {
			permission: 'granted',
			capturing: true,
			deviceId: 'default',
			deviceLabel: 'MacBook Pro Microphone',
			issue: null,
			deviceChanged: false,
			...overrides,
		} as never);
	}

	function level(): HTMLElement {
		return screen.getByTestId('voice-indicator-listening');
	}

	it('drives the listening indicator from real level values', () => {
		renderHud();
		startSession();
		const quiet = level().getAttribute('data-level');

		emit(event('audio-level', { level: 0.25, speech: true }));
		const loud = level().getAttribute('data-level');

		expect(Number(quiet)).toBe(0);
		expect(Number(loud)).toBe(1);
		expect(screen.getByTestId('voice-hud-level')).toBeTruthy();
	});

	it('falls back to rest when the floor closes rather than freezing the last level', () => {
		renderHud();
		startSession();
		emit(event('audio-level', { level: 0.25, speech: true }));
		expect(Number(level().getAttribute('data-level'))).toBe(1);

		emit(
			event('listen-stop', { reason: 'endpoint' }),
			event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' })
		);
		expect(Number(level().getAttribute('data-level'))).toBe(0);
	});

	it('names the microphone in use on the indicator', () => {
		renderHud();
		startSession();
		emit(micEvent());
		// The device sits alongside the state sentence rather than replacing it:
		// the tooltip has to answer "is it listening" as well as "through what".
		expect(level().getAttribute('title')).toContain('MacBook Pro Microphone');
		expect(level().getAttribute('title')).toContain('microphone is open');
	});

	it('explains a denied microphone and offers the system settings', async () => {
		renderHud();
		startSession();
		emit(micEvent({ permission: 'denied', capturing: false, issue: 'permission-denied' }));

		expect(screen.getByTestId('voice-hud-mic').textContent).toContain(
			'does not have microphone access'
		);

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-mic-settings'));
		});
		expect(window.maestro.voice.openMicSettings).toHaveBeenCalledTimes(1);
	});

	it('offers no settings button for a problem the settings cannot fix', () => {
		renderHud();
		startSession();
		emit(micEvent({ capturing: false, issue: 'no-device' }));

		expect(screen.getByTestId('voice-hud-mic').textContent).toContain('No microphone was found');
		expect(screen.queryByTestId('voice-hud-mic-settings')).toBeNull();
	});

	it('says it once: the calm mic notice replaces the red capture error', () => {
		renderHud();
		startSession();
		emit(
			event('session-error', {
				code: 'audio-capture-failed',
				message: 'Microphone permission was denied',
				recoverable: true,
			}),
			micEvent({ permission: 'denied', capturing: false, issue: 'permission-denied' })
		);

		expect(screen.getByTestId('voice-hud-mic')).toBeTruthy();
		expect(screen.queryByTestId('voice-hud-error')).toBeNull();
	});

	it('still shows unrelated errors next to a mic problem', () => {
		renderHud();
		startSession();
		emit(
			micEvent({ capturing: false, issue: 'device-lost' }),
			event('session-error', {
				code: 'no-agent-matched',
				message: "No agent with id 'agent-9' is running",
				recoverable: true,
			})
		);

		expect(screen.getByTestId('voice-hud-mic')).toBeTruthy();
		expect(screen.getByTestId('voice-hud-error')).toBeTruthy();
	});

	it('stays on screen for a denied microphone after the session parks', () => {
		renderHud();
		startSession();
		emit(
			micEvent({ permission: 'denied', capturing: false, issue: 'permission-denied' }),
			event('listen-stop', { reason: 'stopped' })
		);

		// The session is over, but the reason it produced nothing is still worth
		// reading: a HUD that vanishes here leaves the user with silence and no
		// explanation.
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
		expect(screen.getByTestId('voice-hud-mic')).toBeTruthy();
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

describe('VoiceHud minimize versus close', () => {
	it('minimize leaves the session running behind a restore affordance', async () => {
		renderHud({ withStatusIndicator: true });
		startSession();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-minimize'));
		});

		// The widget is gone from the workspace and nothing touched the floor. The
		// restore affordance is the Left Bar indicator, not a floating pill parked
		// over the work the user just asked to see.
		expect(screen.queryByTestId('voice-hud')).toBeNull();
		expect(screen.getByTestId('voice-status-indicator')).toBeTruthy();
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		expect(useVoiceSessionStore.getState().state).toBe('listening');
	});

	it('restores from the Left Bar indicator', async () => {
		renderHud({ withStatusIndicator: true });
		startSession();
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-minimize'));
		});
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-status-indicator'));
		});
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
	});

	it('leaves no indicator anywhere once the session is closed', async () => {
		// The pair that matters: minimize must leave something visible, and close
		// must not. An indicator that outlived the session would claim an open
		// microphone that is not there.
		renderHud({ withStatusIndicator: true });
		startSession();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-close'));
		});

		expect(screen.queryByTestId('voice-hud')).toBeNull();
		expect(screen.queryByTestId('voice-status-indicator')).toBeNull();
	});

	it('close ends the session, unlike minimize', async () => {
		renderHud();
		startSession();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-close'));
		});

		expect(window.maestro.voice.stop).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('voice-hud')).toBeNull();
		expect(screen.queryByTestId('voice-hud-minimized')).toBeNull();
	});

	it('Escape and the ESC pill do exactly the same thing', async () => {
		const first = renderHud();
		startSession();
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-close'));
		});
		const viaPill = {
			stopCalls: vi.mocked(window.maestro.voice.stop).mock.calls.length,
			dismissed: useVoiceSessionStore.getState().dismissed,
			rendered: screen.queryByTestId('voice-hud') !== null,
		};
		first.unmount();

		vi.clearAllMocks();
		vi.mocked(window.maestro.voice.onEvent).mockReturnValue(() => {});
		useVoiceSessionStore.getState().reset();
		seq = 0;

		renderHud();
		startSession();
		await act(async () => {
			fireEvent.keyDown(document, { key: 'Escape' });
		});
		const viaEscape = {
			stopCalls: vi.mocked(window.maestro.voice.stop).mock.calls.length,
			dismissed: useVoiceSessionStore.getState().dismissed,
			rendered: screen.queryByTestId('voice-hud') !== null,
		};

		expect(viaEscape).toEqual(viaPill);
		expect(viaEscape.stopCalls).toBe(1);
	});
});

describe('VoiceHud controls', () => {
	it('toggles the transcript and remembers the answer', async () => {
		renderHud();
		startSession();
		expect(screen.queryByTestId('voice-transcript')).toBeNull();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-transcript-toggle'));
		});

		expect(useVoiceUiStore.getState().transcriptVisible).toBe(true);
		expect(screen.getByTestId('voice-transcript')).toBeTruthy();
		expect(useVoiceUiStore.getState().transcriptVisible).toBe(true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ ui: expect.objectContaining({ transcriptVisible: true }) })
		);
	});

	it('mutes the live output without persisting the mute', async () => {
		renderHud();
		startSession();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-mute'));
		});

		expect(window.maestro.voice.setVolume).toHaveBeenCalledWith(0);
		expect(useVoiceUiStore.getState().muted).toBe(true);
		// A mute that survived a restart is a voice assistant that has silently
		// stopped talking to you.
		expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ ui: expect.objectContaining({ muted: true }) })
		);

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-mute'));
		});
		expect(window.maestro.voice.setVolume).toHaveBeenLastCalledWith(1);
	});

	it('offers Interrupt only while something is being said', async () => {
		renderHud();
		startSession();
		expect(screen.getByTestId('voice-hud-interrupt')).toHaveProperty('disabled', true);

		emit(event('speak-start', { utteranceId: 'u1', sentenceCount: 1, ttsProviderId: 'mock-tts' }));
		expect(screen.getByTestId('voice-hud-interrupt')).toHaveProperty('disabled', false);

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-interrupt'));
		});
		expect(window.maestro.voice.interrupt).toHaveBeenCalledWith('client-button');
		// Interrupting keeps the floor. It is not a stop.
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
	});

	it('the talk button toggles on a tap', async () => {
		renderHud({ showDevHarness: true });
		const talk = screen.getByTestId('voice-hud-talk');

		await act(async () => {
			fireEvent.pointerDown(talk, { button: 0 });
			fireEvent.pointerUp(talk);
		});
		expect(window.maestro.voice.start).toHaveBeenCalledTimes(1);

		startSession();
		await act(async () => {
			fireEvent.pointerDown(talk, { button: 0 });
			fireEvent.pointerUp(talk);
		});
		expect(window.maestro.voice.stop).toHaveBeenCalledTimes(1);
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
