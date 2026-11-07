/**
 * The Quick Chat window's microphone.
 *
 * What has to hold: the session it opens is bound to Quick Chat and to nothing
 * else, a session some other window opened is not mistaken for its own, a tap
 * ends the session it started (there is no other off switch here), and a
 * refused start is said in the window, which has no toast surface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { useQuickChatVoice } from '../../../../renderer/hooks/voice/useQuickChatVoice';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useVoiceSessionStore } from '../../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../../renderer/stores/voiceUiStore';

const QUICK_CHAT = { kind: 'quick-chat' };

function render(enabled = true) {
	useSettingsStore.setState({ encoreFeatures: { aCappella: enabled } } as never);
	return renderHook(() => useQuickChatVoice());
}

/** What `voice.start` answers for a session on `scope`. */
function started(scope: unknown) {
	return {
		snapshot: {
			sessionId: 'voice-1',
			state: 'listening',
			scope,
			seq: 1,
			startedAt: 0,
			providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
		},
		substitutions: [],
	} as never;
}

function setSession(patch: Record<string, unknown>): void {
	act(() => {
		useVoiceSessionStore.setState(patch as never);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	useVoiceSessionStore.getState().reset();
	useVoiceUiStore.setState({ loaded: true, listenMode: 'hands-free', holdThresholdMs: 250 });
	vi.mocked(window.maestro.voice.start).mockResolvedValue(started(QUICK_CHAT));
});

afterEach(() => {
	cleanup();
});

describe('with A Cappella off', () => {
	it('offers no microphone and opens nothing', async () => {
		const { result } = render(false);
		expect(result.current.enabled).toBe(false);

		await act(async () => {
			result.current.toggle();
			result.current.holdStart();
		});

		expect(window.maestro.voice.start).not.toHaveBeenCalled();
		// Nothing subscribes to the voice stream for a feature that is off.
		expect(window.maestro.voice.onEvent).not.toHaveBeenCalled();
	});
});

describe('with A Cappella on', () => {
	it('subscribes this window to the voice stream: the HUD in the app window does not', () => {
		render();

		expect(window.maestro.voice.onEvent).toHaveBeenCalledTimes(1);
	});

	it('a tap opens a session bound to Quick Chat, with the microphone open', async () => {
		const { result } = render();
		// No live session of its own, so nothing is resumed.
		await act(async () => {
			result.current.toggle();
		});

		await waitFor(() => expect(window.maestro.voice.start).toHaveBeenCalledWith(QUICK_CHAT));
		// One argument: no `paused`, whatever the listen mode says. The tap IS the
		// user opening the microphone.
		expect(vi.mocked(window.maestro.voice.start).mock.calls[0]).toHaveLength(1);
		await waitFor(() => expect(result.current.active).toBe(true));
	});

	it('opens hot even in push-to-talk mode, which has no button to hold here but this one', async () => {
		useVoiceUiStore.setState({ listenMode: 'push-to-talk' });
		const { result } = render();

		await act(async () => {
			result.current.toggle();
		});

		await waitFor(() => expect(window.maestro.voice.start).toHaveBeenCalledWith(QUICK_CHAT));
		expect(vi.mocked(window.maestro.voice.start).mock.calls[0]).toHaveLength(1);
	});

	it('a tap on a live Quick Chat session ends it', async () => {
		const { result } = render();
		setSession({ state: 'listening', scope: QUICK_CHAT });
		expect(result.current.active).toBe(true);

		await act(async () => {
			result.current.toggle();
		});

		expect(window.maestro.voice.stop).toHaveBeenCalledTimes(1);
		expect(window.maestro.voice.start).not.toHaveBeenCalled();
	});

	it('does not take a session another window opened for its own', async () => {
		// Every window mirrors the one session. This one belongs to the main
		// window's composer.
		const { result } = render();
		setSession({
			state: 'listening',
			scope: { kind: 'agent', sessionId: 'agent-1' },
			partialTranscript: 'refactor the auth',
			error: { code: 'dispatch-failed', message: 'That tab is gone', recoverable: true },
		});

		expect(result.current.active).toBe(false);
		expect(result.current.partialTranscript).toBe('');
		expect(result.current.error).toBeNull();

		// A tap starts Quick Chat's own session; it does not end the other one.
		await act(async () => {
			result.current.toggle();
		});
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
		await waitFor(() => expect(window.maestro.voice.start).toHaveBeenCalledWith(QUICK_CHAT));
		expect(window.maestro.voice.setListening).not.toHaveBeenCalled();
	});

	it('is not live once its session has ended, though the scope is remembered', () => {
		const { result } = render();
		setSession({ state: 'idle', scope: QUICK_CHAT });

		expect(result.current.active).toBe(false);
	});

	it('reports what is being heard and what state the session is in', () => {
		const { result } = render();
		setSession({ state: 'listening', scope: QUICK_CHAT, partialTranscript: 'what day is' });

		expect(result.current.visualState).toBe('listening');
		expect(result.current.partialTranscript).toBe('what day is');

		setSession({ state: 'dispatching' });
		expect(result.current.visualState).toBe('thinking');

		setSession({ state: 'speaking' });
		expect(result.current.visualState).toBe('speaking');

		// Gated shut after a push-to-talk release: open session, shut microphone.
		setSession({ state: 'listening', listenPaused: true });
		expect(result.current.visualState).toBe('paused');
	});

	it('a hold opens the microphone until the release, which sends', async () => {
		const { result } = render();
		setSession({ state: 'listening', scope: QUICK_CHAT, listenPaused: true });

		await act(async () => {
			result.current.holdStart();
		});
		await waitFor(() =>
			expect(window.maestro.voice.setListening).toHaveBeenCalledWith({
				listening: true,
				hold: true,
			})
		);

		await act(async () => {
			result.current.holdEnd();
		});
		await waitFor(() =>
			expect(window.maestro.voice.setListening).toHaveBeenLastCalledWith({
				listening: false,
				send: true,
			})
		);
		// The session stays for the next hold.
		expect(window.maestro.voice.stop).not.toHaveBeenCalled();
	});

	it('a hold with no session starts one on Quick Chat and holds it', async () => {
		const { result } = render();

		await act(async () => {
			result.current.holdStart();
		});

		await waitFor(() => expect(window.maestro.voice.start).toHaveBeenCalledWith(QUICK_CHAT));
		await waitFor(() =>
			expect(window.maestro.voice.setListening).toHaveBeenLastCalledWith({
				listening: true,
				hold: true,
			})
		);
	});

	it('says in the window why a start was refused, without the IPC wrapper', async () => {
		vi.mocked(window.maestro.voice.start).mockRejectedValueOnce(
			new Error(
				"Error invoking remote method 'acappella:start-session': Error: Speech model is not installed."
			)
		);
		const { result } = render();

		await act(async () => {
			result.current.toggle();
		});

		await waitFor(() => expect(result.current.error).toBe('Speech model is not installed.'));
		expect(result.current.active).toBe(false);
	});

	it('shows a failure of its own session, and drops a start error once one is live', async () => {
		vi.mocked(window.maestro.voice.start).mockRejectedValueOnce(new Error('Microphone denied'));
		const { result } = render();
		await act(async () => {
			result.current.toggle();
		});
		await waitFor(() => expect(result.current.error).toBe('Microphone denied'));

		setSession({ state: 'listening', scope: QUICK_CHAT });
		await waitFor(() => expect(result.current.error).toBeNull());

		setSession({
			state: 'error',
			error: { code: 'dispatch-failed', message: 'Wait for the reply', recoverable: true },
		});
		expect(result.current.error).toBe('Wait for the reply');
	});

	it('classifies a press off the same threshold the HUD and the voice hotkey use', () => {
		const { result } = render();

		expect(result.current.holdThresholdMs).toBe(250);
	});
});
