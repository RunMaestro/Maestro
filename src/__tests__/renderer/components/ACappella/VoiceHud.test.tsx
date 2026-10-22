/**
 * VoiceHud - the A Cappella overlay.
 *
 * What matters here: it is invisible and inert while the Encore Feature is off,
 * it renders what the event stream says (not what the caller hoped), listening
 * and speaking are distinguishable, and closing it ENDS the session rather than
 * leaving an open floor behind an invisible surface. Closing is also the ONLY
 * thing that takes it away: the talk button shuts the microphone and keeps the
 * session, and a session that ends on its own leaves the widget where it was.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import {
	DEV_HARNESS_STORAGE_KEY,
	VoiceHud,
	VoiceStatusIndicator,
} from '../../../../renderer/components/ACappella';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { LayerStackProvider, useLayerStack } from '../../../../renderer/contexts/LayerStackContext';
import type { LayerStackAPI } from '../../../../renderer/hooks';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import type { VoiceEvent } from '../../../../shared/acappella/protocol';
import { mockTheme } from '../../../helpers/mockTheme';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import { VoiceWidget } from '../../../../renderer/floatingWidget/VoiceWidget';
import type { VoiceWidgetState } from '../../../../shared/floatingWidgets';
import { PARAKEET_TDT_V2_ID, getLocalModel } from '../../../../shared/local-models/model-catalog';

const SESSION = 'voice-1';
const originalFloatingWidgets = window.maestro.floatingWidgets;

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
		children?: React.ReactNode;
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
			{props.children}
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

/** Put one agent with one tab on screen, so Tab and Agent mode have a target. */
function seedAgentForTab(): void {
	act(() => {
		useSessionStore.setState({
			activeSessionId: 'agent-1',
			sessions: [
				createMockSession({
					id: 'agent-1',
					aiTabs: [createMockAITab({ id: 'tab-1' })],
					activeTabId: 'tab-1',
				}),
			],
		});
	});
}

/** Two agents with two tabs each, agent-1 / tab-1 on screen. */
function seedTwoAgents(): void {
	act(() => {
		useSessionStore.setState({
			activeSessionId: 'agent-1',
			sessions: [
				createMockSession({
					id: 'agent-1',
					aiTabs: [createMockAITab({ id: 'tab-1' }), createMockAITab({ id: 'tab-2' })],
					activeTabId: 'tab-1',
				}),
				createMockSession({
					id: 'agent-2',
					aiTabs: [createMockAITab({ id: 'tab-9' })],
					activeTabId: 'tab-9',
				}),
			],
		});
	});
}

/** Click another agent in the Left Bar. */
function switchToAgent(agentId: string): void {
	act(() => {
		useSessionStore.setState({ activeSessionId: agentId });
	});
}

/** Click another tab of one agent. */
function switchToTab(agentId: string, tabId: string): void {
	act(() => {
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((session) =>
				session.id === agentId ? { ...session, activeTabId: tabId } : session
			),
		}));
	});
}

beforeEach(() => {
	seq = 0;
	useSettingsStore.setState({ forcedParallelExecution: false });
	vi.clearAllMocks();
	vi.mocked(window.maestro.voice.onEvent).mockReturnValue(() => {});
	vi.mocked(window.maestro.voice.getState).mockResolvedValue(null);
	useVoiceSessionStore.getState().reset();
	// The HUD follows the agent on screen, so one test's agents must not be the
	// next test's starting focus.
	useSessionStore.setState({ activeSessionId: '', sessions: [] });
	useVoiceUiStore.setState({
		transcriptVisible: false,
		hudPosition: null,
		minimizeBehavior: 'manual',
		minimized: false,
		muted: false,
		loaded: true,
		listenMode: 'hands-free',
		holdWhileBusy: true,
		sendWait: null,
		tabCyclesMode: false,
	});
});

afterEach(() => {
	cleanup();
	window.maestro.floatingWidgets = originalFloatingWidgets;
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

	/**
	 * The harness is a reason the widget renders, so its DEFAULT decides whether
	 * A Cappella opens itself. It used to default to the development build, which
	 * put a type-an-utterance box over every dev workspace at startup with no
	 * session, no microphone, and nobody having asked for one.
	 */
	describe('the dev harness does not opt itself in', () => {
		// This jsdom has no localStorage at all, which is itself the first case:
		// `devHarnessOptedIn()` has to read "not opted in" from a window with no
		// storage rather than throw on the way to rendering the app.
		const store = new Map<string, string>();
		let original: Storage | undefined;

		beforeEach(() => {
			store.clear();
			original = (window as { localStorage?: Storage }).localStorage;
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				value: {
					getItem: (key: string) => store.get(key) ?? null,
					setItem: (key: string, value: string) => void store.set(key, value),
					removeItem: (key: string) => void store.delete(key),
				},
			});
		});

		afterEach(() => {
			Object.defineProperty(window, 'localStorage', {
				configurable: true,
				value: original,
			});
		});

		/** No `showDevHarness` prop at all, which is how AppShell mounts it. */
		function renderWithDefaults() {
			return render(
				<LayerStackProvider>
					<VoiceHud theme={mockTheme} enabled />
				</LayerStackProvider>
			);
		}

		it('renders nothing while idle when the prop is left to its default', () => {
			renderWithDefaults();

			expect(screen.queryByTestId('voice-hud')).toBeNull();
			expect(screen.queryByTestId('voice-dev-harness')).toBeNull();
		});

		it('opens for someone who explicitly opted in', () => {
			// An opt-in IS a trigger: whoever set the key wants the box to type into.
			window.localStorage.setItem(DEV_HARNESS_STORAGE_KEY, 'true');

			renderWithDefaults();

			expect(screen.getByTestId('voice-dev-harness')).toBeTruthy();
		});

		it('ignores a key set to anything other than true', () => {
			window.localStorage.setItem(DEV_HARNESS_STORAGE_KEY, 'false');

			renderWithDefaults();

			expect(screen.queryByTestId('voice-hud')).toBeNull();
		});
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

	it('says a finished sentence is waiting for a send phrase, and sends it on request', () => {
		// Hold-until-send keeps a request for up to thirty seconds. Without this
		// line the HUD showed the sentence and then nothing happened, which read as
		// a session that heard you and ignored you.
		renderHud();
		startSession();
		const held = event('partial-transcript', {
			text: 'what color is snow',
			stability: 0.95,
			held: { settlesInMs: 30_000, sendPhrases: ['go maestro', 'send it'] },
		});
		emit({ ...held, ts: Date.now() } as VoiceEvent);

		const notice = screen.getByTestId('voice-hud-held');
		expect(notice.textContent).toContain('go maestro');
		expect(notice.textContent).toMatch(/sends in \d+s/);

		fireEvent.click(screen.getByTestId('voice-hud-send-now'));
		expect(window.maestro.voice.endUtterance).toHaveBeenCalledTimes(1);

		// Dispatched: the notice is gone with the hold.
		emit(event('final-transcript', { text: 'what color is snow', confidence: 1 }));
		expect(screen.queryByTestId('voice-hud-held')).toBeNull();
	});

	it('shows no hold notice for a live hypothesis', () => {
		renderHud();
		startSession();

		emit(event('partial-transcript', { text: 'what color', stability: 0.4 }));

		expect(screen.queryByTestId('voice-hud-held')).toBeNull();
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

	it('offers the three modes while a session is live, with the Conductor selected', () => {
		renderHud();
		startSession();

		expect(screen.getByTestId('voice-hud-mode')).toBeTruthy();
		expect(screen.getByTestId('voice-hud-mode-conductor').getAttribute('aria-checked')).toBe(
			'true'
		);
	});

	it('binds Tab mode to the tab on screen, not the tab the last request landed in', () => {
		seedTwoAgents();
		renderHud();
		startSession();
		// An earlier Conductor request went to another agent's tab entirely.
		emit(
			event('dispatch', {
				agentSessionId: 'agent-2',
				agentName: 'Backend',
				tabId: 'tab-9',
				tabName: 'Auth Refactor',
				action: 'focused',
				promptSent: true,
			})
		);

		fireEvent.click(screen.getByTestId('voice-hud-mode-tab'));

		expect(window.maestro.voice.setScope).toHaveBeenCalledWith({
			kind: 'agent',
			sessionId: 'agent-1',
			tabId: 'tab-1',
		});
	});

	it('binds Agent mode to the agent on screen', () => {
		seedTwoAgents();
		renderHud();
		startSession();
		emit(
			event('dispatch', {
				agentSessionId: 'agent-2',
				agentName: 'Backend',
				tabId: 'tab-9',
				tabName: 'Auth Refactor',
				action: 'focused',
				promptSent: true,
			})
		);

		fireEvent.click(screen.getByTestId('voice-hud-mode-agent'));

		expect(window.maestro.voice.setScope).toHaveBeenCalledWith({
			kind: 'agent',
			sessionId: 'agent-1',
		});
	});

	it('re-picking the mode that is on points it at what is on screen', () => {
		// An agent's own wake phrase binds to that agent whatever is in front, and
		// nothing moves it until the user does. Clicking the lit pill is the user
		// saying "this one".
		seedTwoAgents();
		renderHud();
		startSession();
		emit(event('scope-change', { scope: { kind: 'agent', sessionId: 'agent-2' } }));
		vi.mocked(window.maestro.voice.setScope).mockClear();

		fireEvent.click(screen.getByTestId('voice-hud-mode-agent'));

		expect(window.maestro.voice.setScope).toHaveBeenCalledWith({
			kind: 'agent',
			sessionId: 'agent-1',
		});
	});

	it('re-picking the mode that is on sends nothing when the binding already matches', () => {
		seedTwoAgents();
		renderHud();
		startSession();
		emit(event('scope-change', { scope: { kind: 'agent', sessionId: 'agent-1', tabId: 'tab-1' } }));
		vi.mocked(window.maestro.voice.setScope).mockClear();

		fireEvent.click(screen.getByTestId('voice-hud-mode-tab'));

		// Re-binding clears the Conductor's pending question, so it is not free.
		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
	});

	it('follows a mode switch from the service, naming the pinned tab', () => {
		renderHud();
		startSession();
		emit(
			event('agent-roster', {
				agents: [
					{
						sessionId: 'agent-1',
						name: 'Backend',
						agentType: 'claude-code',
						cwd: '/repo',
						tabs: [{ id: 'tab-7', name: 'Auth Refactor', lastActiveAt: 1 }],
					},
				],
			}),
			event('scope-change', { scope: { kind: 'agent', sessionId: 'agent-1', tabId: 'tab-7' } })
		);

		expect(screen.getByTestId('voice-hud-mode-tab').getAttribute('aria-checked')).toBe('true');
		expect(screen.getByTestId('voice-hud-scope').textContent).toBe('Backend / Auth Refactor');
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

	it('offers setup in the HUD when a missing speech engine blocks a start', async () => {
		const entry = getLocalModel(PARAKEET_TDT_V2_ID)!;
		vi.mocked(window.maestro.localModels.list).mockResolvedValueOnce([
			{
				entry,
				installPaths: [],
				status: {
					id: entry.id,
					status: 'installed',
					bytesOnDisk: entry.bytes,
					manifest: null,
					detail: '',
				},
			},
		]);
		vi.mocked(window.maestro.localModels.runtimes.list).mockResolvedValueOnce([
			{
				id: 'onnx',
				label: 'ONNX Runtime',
				installed: false,
				stale: false,
				downloadable: true,
				bytes: 1_000,
				models: [entry.id],
			},
		]);
		vi.mocked(window.maestro.voice.models.readiness).mockResolvedValueOnce({
			canStartSession: false,
			canRunHandsFree: false,
			slots: [],
			blocking: [
				{
					slot: 'stt',
					providerId: 'parakeet-local',
					satisfied: false,
					reason: 'runtime-unavailable',
					requiredModelId: entry.id,
				},
			],
		});
		renderHud();
		startSession();
		emit(
			event('session-error', {
				code: 'provider-unavailable',
				message: 'Speech engine is missing.',
				recoverable: false,
			})
		);

		expect(await screen.findByRole('button', { name: /Set up voice/ })).toBeEnabled();
		expect(screen.getByTestId('voice-hud-error')).toHaveTextContent('Voice setup needed');
		expect(window.maestro.localModels.runtimes.install).not.toHaveBeenCalled();
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

	describe('a recogniser that cannot hear', () => {
		/** Report the live providers, the way `provider-state` does mid-session. */
		function reportStt(hearsAudio: boolean) {
			emit(
				event('provider-state', {
					pipeline: 'cascade',
					slots: [
						{
							role: 'stt',
							providerId: hearsAudio ? 'echo-stt' : 'mock-stt',
							label: 'Test STT',
							tier: 'mock',
							hearsAudio,
						},
					],
					egressStatement: 'Nothing leaves this machine.',
					audioLeavesMachine: false,
				} as never)
			);
		}

		it('says so, because "Listening" cannot', () => {
			// The whole point: the floor IS open and the state machine is telling the
			// truth, but a text-in recogniser opens no capture device, so speaking can
			// never produce a transcript. Six rebuilds were spent on that gap.
			renderHud();
			startSession();
			reportStt(false);

			expect(screen.getByTestId('voice-hud-deaf').textContent).toContain(
				'does not listen to the microphone'
			);
		});

		it('stays quiet for a recogniser that does hear', () => {
			renderHud();
			startSession();
			reportStt(true);

			expect(screen.queryByTestId('voice-hud-deaf')).toBeNull();
		});

		it('stays quiet before the providers are known', () => {
			// Absent is not the same as false. Warning on "not yet reported" would
			// put the notice on screen at the start of every healthy session.
			renderHud();
			startSession();

			expect(screen.queryByTestId('voice-hud-deaf')).toBeNull();
		});
	});

	it('lets Escape close a HUD that is only showing a refusal', async () => {
		// The Escape layer was registered for an active session and the dev harness
		// only, while the widget also renders for an error - so the HUD explaining
		// why voice would not start drew an ESC pill that Escape never reached.
		renderHud();
		emit(event('wake', { source: 'client-button', scope: { kind: 'conductor' } }));
		emit(
			event('session-error', {
				code: 'provider-unavailable',
				message: 'whisper.cpp is not part of this build yet.',
				recoverable: false,
			})
		);
		expect(screen.getByTestId('voice-hud-error')).toBeTruthy();

		await act(async () => {
			fireEvent.keyDown(document, { key: 'Escape' });
		});

		expect(screen.queryByTestId('voice-hud')).toBeNull();
	});
});

describe('VoiceHud controls', () => {
	it('persists the visible busy hold toggle', async () => {
		renderHud();
		startSession();
		const toggle = screen.getByRole('switch', { name: 'Hold while busy' });
		expect(toggle).toHaveAttribute('aria-checked', 'true');
		await act(async () => fireEvent.click(toggle));
		expect(useVoiceUiStore.getState().holdWhileBusy).toBe(false);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ ui: expect.objectContaining({ holdWhileBusy: false }) })
		);
	});
	it('names the room instead of showing agent routing controls for Group Chat', () => {
		renderHud();
		const scope = { kind: 'group-chat', groupChatId: 'room', name: 'Review' } as const;
		emit(
			event('wake', { source: 'client-button', scope }),
			event('listen-start', { scope, sttProviderId: 'mock-stt' })
		);
		expect(screen.getByTestId('voice-hud-scope')).toHaveTextContent('Review');
		expect(screen.getByText('Group Chat · Talking to the moderator')).toBeInTheDocument();
		expect(screen.queryByTestId('voice-hud-mode')).not.toBeInTheDocument();
	});

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
		// The write goes through the shared settings queue, a few ticks behind the click.
		await flushLayout();
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

	it('hands-free: a click shuts the microphone and keeps the session and the HUD', async () => {
		renderHud();
		startSession();
		const talk = screen.getByTestId('voice-hud-talk');
		expect(talk.textContent).toContain('Listening');

		await act(async () => {
			fireEvent.click(talk);
		});

		expect(window.maestro.voice.setListening).toHaveBeenCalledWith({
			listening: false,
			send: false,
		});
		// The whole point: the button is not a hang-up.
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
	});

	it('hands-free: follows the gate, and a second click opens the microphone again', async () => {
		renderHud();
		startSession();
		emit(event('listen-gate', { paused: true }));

		const talk = screen.getByTestId('voice-hud-talk');
		expect(talk.textContent).toContain('Not listening');
		expect(talk.getAttribute('aria-pressed')).toBe('false');
		// A paused session must not draw the live meter of an open microphone.
		expect(screen.getByTestId('voice-indicator-paused')).toBeTruthy();
		expect(screen.queryByTestId('voice-indicator-listening')).toBeNull();

		await act(async () => {
			fireEvent.click(talk);
		});
		expect(window.maestro.voice.setListening).toHaveBeenCalledWith({
			listening: true,
			hold: false,
		});

		emit(event('listen-gate', { paused: false }));
		expect(talk.textContent).toContain('Listening');
		expect(screen.getByTestId('voice-indicator-listening')).toBeTruthy();
	});

	it('starts a session when there is none left to resume', async () => {
		renderHud({ showDevHarness: true });
		vi.mocked(window.maestro.voice.setListening).mockResolvedValueOnce(false);

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-talk'));
		});
		// The gate answers first, then the start: two awaited hops behind the click.
		await flushLayout();

		expect(window.maestro.voice.start).toHaveBeenCalledTimes(1);
	});

	it('the hand button switches to push-to-talk, remembers it, and shuts a live microphone', async () => {
		renderHud();
		startSession();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-listen-mode'));
		});
		// The preference is written before the live microphone is told.
		await flushLayout();

		expect(useVoiceUiStore.getState().listenMode).toBe('push-to-talk');
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ ui: expect.objectContaining({ listenMode: 'push-to-talk' }) })
		);
		// Push-to-talk with the button up is a closed microphone, starting now.
		expect(window.maestro.voice.setListening).toHaveBeenCalledWith({ listening: false });
		// The label follows main's answer, never the request: the gate is announced.
		emit(event('listen-gate', { paused: true }));
		expect(screen.getByTestId('voice-hud-talk').textContent).toContain('Hold to talk');
	});

	it('push-to-talk: the press opens the microphone and the release sends', async () => {
		vi.useFakeTimers();
		try {
			useVoiceUiStore.setState({ listenMode: 'push-to-talk' });
			renderHud();
			startSession();
			emit(event('listen-gate', { paused: true }));
			const talk = screen.getByTestId('voice-hud-talk');

			await act(async () => {
				fireEvent.pointerDown(talk, { button: 0 });
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(window.maestro.voice.setListening).toHaveBeenLastCalledWith({
				listening: true,
				hold: true,
			});
			expect(talk.textContent).toContain('Talking');

			await act(async () => {
				fireEvent.pointerUp(talk);
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(window.maestro.voice.setListening).toHaveBeenLastCalledWith({
				listening: false,
				send: true,
			});
			// Releasing sends; it does not hang up.
			expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it('push-to-talk: a click alone never toggles the microphone', async () => {
		useVoiceUiStore.setState({ listenMode: 'push-to-talk' });
		renderHud();
		startSession();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-talk'));
		});

		expect(window.maestro.voice.setListening).not.toHaveBeenCalled();
	});

	/** Open the send panel from its chip and hand back the wait slider. */
	async function openSendPanel(): Promise<HTMLInputElement> {
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-wait-chip'));
		});
		return within(screen.getByTestId('voice-hud-wait')).getByRole('slider') as HTMLInputElement;
	}

	async function slideTo(slider: HTMLInputElement, stopIndex: number): Promise<void> {
		await act(async () => {
			fireEvent.change(slider, { target: { value: String(stopIndex) } });
		});
	}

	it('shows the send wait and lets it be changed for this conversation', async () => {
		renderHud();
		startSession();
		await flushLayout();

		const chip = screen.getByTestId('voice-hud-wait-chip');
		expect(chip.textContent).toContain('900ms');
		expect(screen.queryByTestId('voice-hud-wait')).toBeNull();

		const slider = await openSendPanel();
		// The stored default (900 ms) is no shipped stop, so it is a stop of its
		// own: the thumb sits exactly on the wait in force and reads it out.
		expect(slider.value).toBe('0');
		expect(slider.getAttribute('aria-valuetext')).toBe('900ms');
		expect(screen.getByTestId('voice-hud-wait-default')).toBeTruthy();

		// The ladder is 900ms, 1s, 2s, 3s, 5s, ...
		await slideTo(slider, 4);
		expect(window.maestro.voice.setSendWait).toHaveBeenCalledWith(5000);
		expect(screen.getByTestId('voice-hud-wait-chip').textContent).toContain('5s');
		expect(slider.getAttribute('aria-valuetext')).toBe('5s');

		// The way back clears the override rather than storing the default's number.
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-wait-reset'));
		});
		expect(window.maestro.voice.setSendWait).toHaveBeenLastCalledWith(null);
		expect(screen.queryByTestId('voice-hud-wait-reset')).toBeNull();
	});

	it('reads the default stop as "no override" when the slider is dragged back onto it', async () => {
		renderHud();
		startSession();
		await flushLayout();

		const slider = await openSendPanel();
		await slideTo(slider, 4);
		await slideTo(slider, 0);

		// 900 would pin today's default; null keeps following the setting.
		expect(window.maestro.voice.setSendWait).toHaveBeenLastCalledWith(null);
	});

	it('edits the send phrase in the HUD and stores it as the setting', async () => {
		renderHud();
		startSession();
		await flushLayout();
		await openSendPanel();

		const input = screen.getByTestId('voice-hud-send-phrases') as HTMLInputElement;
		expect(input.value).toBe('go maestro');

		const wroteControls = expect.objectContaining({ controls: expect.anything() });
		const readsBefore = vi.mocked(window.maestro.voice.getSendWait).mock.calls.length;

		fireEvent.change(input, { target: { value: 'ship it,  roll out ,' } });
		// Not per keystroke: half a phrase is not a phrase anyone means.
		expect(window.maestro.settings.set).not.toHaveBeenCalledWith('acappella', wroteControls);

		await act(async () => {
			fireEvent.blur(input);
		});
		await flushLayout();

		// Stored the way main parses it, and only this one field of `controls`.
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ controls: { sendPhrases: 'ship it, roll out' } })
		);
		expect(input.value).toBe('ship it, roll out');
		// The HUD re-reads what main made of it instead of re-deriving the list.
		expect(vi.mocked(window.maestro.voice.getSendWait).mock.calls.length).toBeGreaterThan(
			readsBefore
		);
	});

	it('writes nothing when the send phrase field is left as it was', async () => {
		renderHud();
		startSession();
		await flushLayout();
		await openSendPanel();

		const input = screen.getByTestId('voice-hud-send-phrases');
		await act(async () => {
			fireEvent.blur(input);
		});
		await flushLayout();

		expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ controls: expect.anything() })
		);
	});

	it('disables the send wait in push-to-talk, where the release is the send', async () => {
		useVoiceUiStore.setState({ listenMode: 'push-to-talk' });
		renderHud();
		startSession();
		await flushLayout();

		expect(screen.getByTestId('voice-hud-wait-chip')).toHaveProperty('disabled', true);
	});
});

describe('VoiceHud stays until Escape', () => {
	it('stays on screen after its session ends on its own', () => {
		renderHud();
		startSession();
		emit(event('listen-stop', { reason: 'stopped' }));

		// A timeout or a stop word ended the session. The widget stays, showing a
		// closed microphone, rather than vanishing from under whoever was reading it.
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
		expect(screen.getByTestId('voice-hud-talk').textContent).toContain('Not listening');
		expect(screen.queryByTestId('voice-indicator-listening')).toBeNull();
	});

	it('is taken away by the ESC pill, and does not come back for the ended session', async () => {
		renderHud();
		startSession();
		emit(event('listen-stop', { reason: 'stopped' }));

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-close'));
		});

		expect(screen.queryByTestId('voice-hud')).toBeNull();
		// The "just for now" wait goes with it.
		expect(window.maestro.voice.setSendWait).toHaveBeenCalledWith(null);
	});
});

describe('VoiceHud follows the agent and tab on screen', () => {
	/** Bind the live session, as a mode switch or a wake phrase would. */
	function bind(scope: Extract<VoiceEvent, { type: 'scope-change' }>['scope']): void {
		emit(event('scope-change', { scope }));
		vi.mocked(window.maestro.voice.setScope).mockClear();
	}

	it('Agent mode: switching agents re-binds to the new agent', () => {
		seedTwoAgents();
		renderHud();
		startSession();
		bind({ kind: 'agent', sessionId: 'agent-1' });

		switchToAgent('agent-2');

		expect(window.maestro.voice.setScope).toHaveBeenCalledTimes(1);
		expect(window.maestro.voice.setScope).toHaveBeenCalledWith({
			kind: 'agent',
			sessionId: 'agent-2',
		});
	});

	it('Agent mode: switching tabs inside the agent changes nothing', () => {
		seedTwoAgents();
		renderHud();
		startSession();
		bind({ kind: 'agent', sessionId: 'agent-1' });

		switchToTab('agent-1', 'tab-2');

		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
	});

	it('Tab mode: switching tabs, and then agents, re-binds to the tab in front', () => {
		seedTwoAgents();
		renderHud();
		startSession();
		bind({ kind: 'agent', sessionId: 'agent-1', tabId: 'tab-1' });

		switchToTab('agent-1', 'tab-2');
		expect(window.maestro.voice.setScope).toHaveBeenLastCalledWith({
			kind: 'agent',
			sessionId: 'agent-1',
			tabId: 'tab-2',
		});

		bind({ kind: 'agent', sessionId: 'agent-1', tabId: 'tab-2' });
		switchToAgent('agent-2');
		expect(window.maestro.voice.setScope).toHaveBeenLastCalledWith({
			kind: 'agent',
			sessionId: 'agent-2',
			tabId: 'tab-9',
		});
	});

	it('Conductor mode: moving around re-binds nothing', () => {
		seedTwoAgents();
		renderHud();
		startSession();
		vi.mocked(window.maestro.voice.setScope).mockClear();

		switchToAgent('agent-2');
		switchToTab('agent-2', 'tab-9');

		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
	});

	it('does not "correct" a session bound to an agent that is not on screen', () => {
		// An agent's own wake phrase binds to that agent whatever is in front. It
		// stays bound until the user actually goes somewhere.
		seedTwoAgents();
		renderHud();
		startSession();
		bind({ kind: 'agent', sessionId: 'agent-2' });

		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();

		// The move is what re-binds, and it lands on where they went.
		switchToAgent('agent-2');
		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
		switchToAgent('agent-1');
		expect(window.maestro.voice.setScope).toHaveBeenCalledWith({
			kind: 'agent',
			sessionId: 'agent-1',
		});
	});

	it('ignores a tab the session itself brought to the front', () => {
		// Tab mode recalls its pinned tab on dispatch, which focuses it. That is a
		// change of focus onto the tab already bound, so nothing is sent.
		seedTwoAgents();
		renderHud();
		startSession();
		bind({ kind: 'agent', sessionId: 'agent-1', tabId: 'tab-2' });

		switchToTab('agent-1', 'tab-2');

		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
	});

	it('after the session ended: remembers the new target for the talk button', () => {
		seedTwoAgents();
		renderHud();
		startSession();
		bind({ kind: 'agent', sessionId: 'agent-1' });
		emit(event('listen-stop', { reason: 'stopped' }));

		switchToAgent('agent-2');

		// No live session to re-bind, so main is not asked...
		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
		// ...and the scope the next session restarts on has moved with the user.
		expect(useVoiceSessionStore.getState().scope).toEqual({
			kind: 'agent',
			sessionId: 'agent-2',
		});
	});

	it('does nothing once the HUD has been closed', async () => {
		seedTwoAgents();
		renderHud();
		startSession();
		bind({ kind: 'agent', sessionId: 'agent-1' });
		emit(event('listen-stop', { reason: 'stopped' }));
		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-close'));
		});

		switchToAgent('agent-2');

		// A finished session's scope is a leftover; the next trigger brings its own.
		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
		expect(useVoiceSessionStore.getState().scope).toEqual({
			kind: 'agent',
			sessionId: 'agent-1',
		});
	});
});

describe('VoiceHud Tab key', () => {
	function pressTab(init: KeyboardEventInit = {}): KeyboardEvent {
		const key = new KeyboardEvent('keydown', {
			key: 'Tab',
			bubbles: true,
			cancelable: true,
			...init,
		});
		act(() => {
			window.dispatchEvent(key);
		});
		return key;
	}

	it('walks Tab / Agent / Conductor in the order the switch draws them', () => {
		renderHud();
		startSession();
		seedAgentForTab();

		// Conductor is selected; forward wraps to Tab.
		const key = pressTab();
		expect(key.defaultPrevented).toBe(true);
		expect(window.maestro.voice.setScope).toHaveBeenLastCalledWith({
			kind: 'agent',
			sessionId: 'agent-1',
			tabId: 'tab-1',
		});

		// Shift+Tab goes the other way: Conductor -> Agent.
		pressTab({ shiftKey: true });
		expect(window.maestro.voice.setScope).toHaveBeenLastCalledWith({
			kind: 'agent',
			sessionId: 'agent-1',
		});
	});

	it('leaves a Tab that something else already claimed', () => {
		renderHud();
		startSession();
		seedAgentForTab();

		const key = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		key.preventDefault();
		act(() => {
			window.dispatchEvent(key);
		});

		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
	});

	it('leaves Tab to a text field inside the HUD, where it moves focus', async () => {
		renderHud();
		startSession();
		seedAgentForTab();
		await flushLayout();

		await act(async () => {
			fireEvent.click(screen.getByTestId('voice-hud-wait-chip'));
		});
		// Typing a send phrase and tabbing out must not re-bind the session.
		fireEvent.keyDown(screen.getByTestId('voice-hud-send-phrases'), { key: 'Tab' });

		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
	});

	it('does nothing while the HUD is minimized or has no live session', () => {
		renderHud();
		startSession();
		seedAgentForTab();

		act(() => useVoiceUiStore.getState().setMinimized(true));
		expect(pressTab().defaultPrevented).toBe(false);

		act(() => useVoiceUiStore.getState().setMinimized(false));
		emit(event('listen-stop', { reason: 'stopped' }));
		expect(pressTab().defaultPrevented).toBe(false);
		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
	});

	it('publishes the claim so a composer that only swallows Tab can yield it', () => {
		renderHud();
		expect(useVoiceUiStore.getState().tabCyclesMode).toBe(false);

		startSession();
		expect(useVoiceUiStore.getState().tabCyclesMode).toBe(true);

		act(() => useVoiceUiStore.getState().setMinimized(true));
		expect(useVoiceUiStore.getState().tabCyclesMode).toBe(false);
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

describe('VoiceHud yields to modals', () => {
	let stack: LayerStackAPI;
	function Probe() {
		stack = useLayerStack();
		return null;
	}

	it('hides for nested blocking dialogs and restores the live session after the last closes', () => {
		renderHud({ children: <Probe /> });
		startSession();
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
		const subscriptionCount = vi.mocked(window.maestro.voice.onEvent).mock.calls.length;
		let settingsId: string;
		let confirmId: string;
		act(() => {
			settingsId = stack.registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.SETTINGS,
				ariaLabel: 'Settings',
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				onEscape: vi.fn(),
			});
			confirmId = stack.registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.CONFIRM,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				onEscape: () => stack.unregisterLayer(confirmId),
			});
		});
		expect(screen.queryByTestId('voice-hud')).toBeNull();
		expect(stack!.getLayers().some((layer) => layer.ariaLabel === 'Voice HUD')).toBe(false);
		expect(useVoiceUiStore.getState().tabCyclesMode).toBe(false);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByTestId('voice-hud')).toBeNull();
		expect(stack!.layerCount).toBe(1);
		act(() => stack.unregisterLayer(settingsId));
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
		expect(screen.getByTestId('voice-indicator-listening')).toBeTruthy();
		expect(useVoiceSessionStore.getState().dismissed).toBe(false);
		expect(useVoiceUiStore.getState().minimized).toBe(false);
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		expect(window.maestro.voice.onEvent).toHaveBeenCalledTimes(subscriptionCount);
	});

	it('keeps the HUD visible alongside passive floating panels', () => {
		renderHud({ children: <Probe /> });
		startSession();
		act(() => {
			stack.registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.THOUGHT_STREAM,
				blocksLowerLayers: false,
				capturesFocus: false,
				blocksAppShortcuts: false,
				focusTrap: 'none',
				onEscape: vi.fn(),
			});
		});
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
	});
});

describe('VoiceHud keyboard passivity', () => {
	// The HUD floats over a workspace the user is still driving. Every other
	// passivity flag was already set, but `blocksAppShortcuts` defaults to TRUE,
	// so leaving it out put a shortcut-blocking layer on the stack and killed
	// Cmd+K, agent switching, and the file-tree keys for as long as a voice
	// session was open. Nothing about that is visible on screen, which is why it
	// survived: the HUD looked correct and the rest of the app just stopped
	// answering the keyboard.
	it('does not suppress app shortcuts while a session is on screen', () => {
		let stack: LayerStackAPI | null = null;
		const Probe = () => {
			stack = useLayerStack();
			return null;
		};

		render(
			<LayerStackProvider>
				<Probe />
				<VoiceHud theme={mockTheme} enabled showDevHarness={false} />
			</LayerStackProvider>
		);

		act(() => startSession());

		// The HUD is really registered, so this is passivity rather than absence.
		expect(screen.getByTestId('voice-hud')).toBeTruthy();
		expect(stack!.getLayers().some((l) => l.ariaLabel === 'Voice HUD')).toBe(true);
		expect(stack!.hasOpenLayers()).toBe(false);
		expect(stack!.hasOpenModal()).toBe(false);
	});
});

describe('VoiceHud pending and Force Send', () => {
	it('shows a pending request as collected context while continuing to listen', () => {
		renderHud();
		startSession();
		emit(
			event('send-state', {
				forceSend: false,
				pending: [
					{
						agentSessionId: 'agent-1',
						tabId: 'tab-1',
						text: 'Fix the bug.\n\nKeep the current API.',
					},
				],
			})
		);
		expect(screen.getByTestId('voice-hud-pending-send').textContent).toContain(
			'Session is busy, send is pending.'
		);
		expect(screen.getByTestId('voice-hud-pending-send').textContent).toContain(
			'Keep the current API.'
		);
		expect(screen.getByTestId('voice-hud-talk').textContent).toContain('Listening');
		expect(useVoiceSessionStore.getState().error).toBeNull();
		emit(event('send-state', { forceSend: false, pending: [] }));
		expect(screen.queryByTestId('voice-hud-pending-send')).toBeNull();
	});

	it('disables Force Send until forced parallel execution is enabled in Settings', () => {
		renderHud();
		startSession();
		const toggle = screen.getByRole('switch', { name: 'Force Send voice requests' });
		expect(toggle).toHaveProperty('disabled', true);
		fireEvent.click(toggle);
		expect(window.maestro.voice.setForceSend).not.toHaveBeenCalled();
		expect(screen.getByText('Enable forced parallel execution in Settings.')).toBeTruthy();
	});

	it('changes Force Send through main and reflects the confirmed state', async () => {
		useSettingsStore.setState({ forcedParallelExecution: true });
		renderHud();
		startSession();
		const toggle = screen.getByRole('switch', { name: 'Force Send voice requests' });
		fireEvent.click(toggle);
		expect(window.maestro.voice.setForceSend).toHaveBeenCalledWith(true);
		expect(toggle.getAttribute('aria-checked')).toBe('false');
		emit(event('send-state', { forceSend: true, pending: [] }));
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		act(() => useSettingsStore.setState({ forcedParallelExecution: false }));
		expect(toggle).toHaveProperty('disabled', true);
		expect(toggle.getAttribute('aria-checked')).toBe('false');
	});

	it('restores pending state from a snapshot and clears it on close', async () => {
		vi.mocked(window.maestro.voice.getState).mockResolvedValueOnce({
			sessionId: SESSION,
			state: 'listening',
			scope: { kind: 'conductor' },
			origin: { kind: 'local' },
			windowId: null,
			seq: 1,
			listenPaused: false,
			startedAt: 0,
			providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
			lastDecision: null,
			lastDispatch: null,
			sendState: {
				forceSend: false,
				pending: [{ agentSessionId: 'agent-1', tabId: 'tab-1', text: 'Collected request' }],
			},
		});
		await act(async () => {
			renderHud();
		});
		expect(screen.getByTestId('voice-hud-pending-send').textContent).toContain('Collected request');
		// The snapshot's sequence is the baseline for later events.
		seq = 1;
		emit(event('listen-stop', { reason: 'stopped' }));
		expect(screen.queryByTestId('voice-hud-pending-send')).toBeNull();
	});
});

describe('VoiceHud desktop window', () => {
	let commandHandler: ((command: unknown) => void) | undefined;
	let stateHandler: ((state: VoiceWidgetState) => void) | undefined;
	let api: typeof window.maestro.floatingWidgets;
	beforeEach(() => {
		commandHandler = undefined;
		stateHandler = undefined;
		api = {
			show: vi.fn().mockResolvedValue(true),
			hide: vi.fn().mockResolvedValue(false),
			toggle: vi.fn().mockResolvedValue(true),
			isVisible: vi.fn().mockResolvedValue(false),
			getBounds: vi.fn().mockResolvedValue(null),
			setBounds: vi.fn().mockResolvedValue(null),
			publishState: vi.fn(),
			getState: vi.fn().mockResolvedValue(null),
			ready: vi.fn(),
			sendCommand: vi.fn(),
			onCommand: vi.fn((_id, handler) => {
				commandHandler = handler;
				return vi.fn();
			}),
			onState: vi.fn((_id, handler) => {
				stateHandler = handler;
				return vi.fn();
			}),
		} as typeof api;
		window.maestro.floatingWidgets = api;
	});

	it('publishes plain state and shows the desktop window without drawing an app card', async () => {
		renderHud();
		startSession();
		await vi.waitFor(() => {
			const last = vi.mocked(api.publishState).mock.calls.at(-1);
			expect(last?.[0]).toBe('acappella-voice');
			expect((last?.[1] as VoiceWidgetState).session.state).toBe('listening');
		});
		expect(screen.queryByTestId('voice-hud')).toBeNull();
		expect(api.show).toHaveBeenCalledWith('acappella-voice');
		const snapshot = vi.mocked(api.publishState).mock.calls.at(-1)?.[1] as VoiceWidgetState;
		expect(snapshot.session).not.toHaveProperty('applyEvent');
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		expect(useVoiceUiStore.getState().tabCyclesMode).toBe(false);
	});

	it('keeps feature-off free of widget publishers, commands and windows', () => {
		renderHud({ enabled: false });
		expect(api.publishState).not.toHaveBeenCalled();
		expect(api.onCommand).not.toHaveBeenCalled();
		expect(api.show).not.toHaveBeenCalled();
		expect(api.hide).not.toHaveBeenCalled();
	});

	it('handles minimize through the owning store and close through the voice service', async () => {
		renderHud();
		startSession();
		act(() => commandHandler?.({ type: 'minimize' }));
		expect(useVoiceUiStore.getState().minimized).toBe(true);
		expect(api.hide).toHaveBeenCalledWith('acappella-voice');
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		await act(async () => commandHandler?.({ type: 'close' }));
		expect(window.maestro.voice.stop).toHaveBeenCalledOnce();
		expect(useVoiceSessionStore.getState().dismissed).toBe(true);
	});

	it('renders the same controls from a seed and routes commands without a second voice subscription', async () => {
		useVoiceSessionStore
			.getState()
			.applyEvent(event('wake', { source: 'client-button', scope: { kind: 'conductor' } }));
		useVoiceSessionStore
			.getState()
			.applyEvent(
				event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' })
			);
		const session = Object.fromEntries(
			Object.entries(useVoiceSessionStore.getState()).filter(
				([, value]) => typeof value !== 'function'
			)
		) as unknown as VoiceWidgetState['session'];
		const u = useVoiceUiStore.getState();
		const snapshot: VoiceWidgetState = {
			session,
			ui: {
				transcriptVisible: false,
				hudPosition: null,
				minimizeBehavior: 'manual',
				listenMode: 'hands-free',
				holdWhileBusy: true,
				defaultMode: u.defaultMode,
				loaded: true,
				minimized: false,
				muted: false,
				holdThresholdMs: u.holdThresholdMs,
				sendWait: null,
			},
			inputDevices: {
				devices: [{ deviceId: 'headset', label: 'Headset' }],
				selectedId: 'headset',
				loading: false,
			},
			forceSendAllowed: true,
		};
		vi.mocked(api.getState).mockResolvedValue(snapshot);
		render(<VoiceWidget theme={mockTheme} />);
		await act(async () => {});
		expect(screen.getByTestId('floating-widget-frame')).toBeInTheDocument();
		expect(screen.getByTestId('floating-widget-title-strip')).toHaveTextContent('Listening');
		expect(window.maestro.voice.onEvent).not.toHaveBeenCalled();
		expect(window.maestro.voice.getState).not.toHaveBeenCalled();
		expect(window.maestro.voice.inputDevices).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId('voice-hud-mode-agent'));
		expect(api.sendCommand).toHaveBeenCalledWith('acappella-voice', {
			type: 'set-mode',
			mode: 'agent',
		});
		expect(window.maestro.voice.setScope).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole('button', { name: 'Minimize the voice HUD (the session keeps running)' })
		);
		expect(api.sendCommand).toHaveBeenCalledWith('acappella-voice', { type: 'minimize' });
		expect(useVoiceUiStore.getState().minimized).toBe(false);
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(api.sendCommand).toHaveBeenCalledWith('acappella-voice', { type: 'close' });
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		act(() =>
			stateHandler?.({ ...snapshot, session: { ...session, partialTranscript: 'Mirrored speech' } })
		);
		expect(screen.getByTestId('voice-hud-latest')).toHaveTextContent('Mirrored speech');
		expect(api.publishState).not.toHaveBeenCalled();
	});
});
