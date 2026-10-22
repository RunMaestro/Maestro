/**
 * Tests for opening and shutting the voice microphone without ending the session.
 *
 * What has to hold: opening resumes a live session and starts one when there is
 * none, a press and its release reach main in the order they happened even when
 * the press has to start a whole session first, and switching the listen mode
 * makes a live microphone agree without ever starting a session by itself.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
	closeVoiceMic,
	openVoiceMic,
	setVoiceListenMode,
	toggleVoiceListenMode,
} from '../../../renderer/services/voiceListening';
import { useVoiceSessionStore } from '../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../renderer/stores/voiceUiStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

let start: Mock;
let setListening: Mock;
let settingsSet: Mock;
/** Every call that reached main, in the order it arrived. */
let order: string[];

function snapshot(scope: unknown = { kind: 'conductor' }) {
	return {
		snapshot: {
			sessionId: 'voice-1',
			state: 'listening',
			scope,
			seq: 1,
			providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
		},
		substitutions: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	order = [];

	start = vi.fn(async () => {
		order.push('start');
		return snapshot();
	});
	setListening = vi.fn(async (payload: { listening: boolean; hold?: boolean; send?: boolean }) => {
		order.push(
			`${payload.listening ? 'open' : 'shut'}${payload.hold ? ':hold' : ''}${payload.send ? ':send' : ''}`
		);
		return true;
	});
	settingsSet = vi.fn(async () => true);
	(window as unknown as { maestro: unknown }).maestro = {
		voice: { start, setListening },
		settings: { get: vi.fn(async () => ({})), set: settingsSet },
	};

	useVoiceSessionStore.getState().reset();
	useVoiceUiStore.setState({ listenMode: 'hands-free', loaded: true });
});

describe('openVoiceMic', () => {
	it('starts Group Chat gated in push-to-talk mode', async () => {
		useVoiceUiStore.setState({ listenMode: 'push-to-talk' });
		setListening.mockResolvedValue(false);
		const scope = { kind: 'group-chat', groupChatId: 'room' } as const;
		await openVoiceMic({ scope, honorListenMode: true });
		expect(start).toHaveBeenCalledWith(scope, { paused: true });
	});
	it('reveals an existing group session without resuming a manually paused microphone', async () => {
		const scope = { kind: 'group-chat', groupChatId: 'room' } as const;
		useVoiceSessionStore.setState({ state: 'listening', scope, listenPaused: true });
		await openVoiceMic({ scope, honorListenMode: true });
		expect(setListening).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});
	it('resumes a live session without starting another', async () => {
		await openVoiceMic();

		expect(setListening).toHaveBeenCalledWith({ listening: true, hold: false });
		expect(start).not.toHaveBeenCalled();
	});

	it('starts a session when there is none left to resume', async () => {
		setListening.mockResolvedValueOnce(false);

		await openVoiceMic();

		expect(start).toHaveBeenCalledTimes(1);
		// A fresh session opens its own microphone: no second gate call is needed.
		expect(setListening).toHaveBeenCalledTimes(1);
	});

	it('restarts in the mode the last session ended in', async () => {
		// A session that timed out while the HUD stayed up must not quietly drop a
		// user who had switched to Tab mode back to the Conductor.
		const scope = { kind: 'agent', sessionId: 'agent-1', tabId: 'tab-1' };
		useVoiceSessionStore.setState({ scope } as never);
		setListening.mockResolvedValueOnce(false);

		await openVoiceMic();

		expect(start).toHaveBeenCalledWith(scope);
	});

	it('opens hot from the talk button even in push-to-talk', async () => {
		// Every other trigger starts gated in this mode. This one IS the press.
		useVoiceUiStore.setState({ listenMode: 'push-to-talk' });
		setListening.mockImplementationOnce(async () => false);

		await openVoiceMic({ hold: true });

		expect(start).toHaveBeenCalledWith(undefined);
		// The new session has to be told a button is holding it, or its first
		// pause would send half the sentence.
		expect(setListening).toHaveBeenLastCalledWith({ listening: true, hold: true });
	});

	it('says why a session could not start instead of doing nothing', async () => {
		setListening.mockResolvedValueOnce(false);
		start.mockRejectedValueOnce(new Error('Speech model is not installed.'));

		await openVoiceMic();

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Voice session could not start',
				message: 'Speech model is not installed.',
			})
		);
	});
});

describe('openVoiceMic for a surface bound to one thing (the Quick Chat window)', () => {
	const QUICK_CHAT = { kind: 'quick-chat' } as const;

	function startsOn(scope: unknown): void {
		start.mockImplementationOnce(async () => {
			order.push('start');
			return snapshot(scope);
		});
	}

	it('resumes a live session that is already on its scope', async () => {
		useVoiceSessionStore.setState({ state: 'listening', scope: QUICK_CHAT } as never);

		await openVoiceMic({ scope: QUICK_CHAT });

		expect(setListening).toHaveBeenCalledWith({ listening: true, hold: false });
		expect(start).not.toHaveBeenCalled();
	});

	it('replaces a live session bound somewhere else instead of resuming it', async () => {
		// Every window mirrors the one session. Resuming this one would send the
		// next sentence to the agent the main window's composer opened it on.
		useVoiceSessionStore.setState({
			state: 'listening',
			scope: { kind: 'agent', sessionId: 'agent-1' },
		} as never);
		startsOn(QUICK_CHAT);

		await openVoiceMic({ scope: QUICK_CHAT });

		expect(start).toHaveBeenCalledWith(QUICK_CHAT);
		expect(setListening).not.toHaveBeenCalled();
	});

	it('starts on its own scope, not on whatever the last session was about', async () => {
		useVoiceSessionStore.setState({
			state: 'idle',
			scope: { kind: 'agent', sessionId: 'agent-1', tabId: 'tab-1' },
		} as never);
		startsOn(QUICK_CHAT);

		await openVoiceMic({ scope: QUICK_CHAT });

		expect(start).toHaveBeenCalledWith(QUICK_CHAT);
	});

	it('does not resume its own scope once that session has ended', async () => {
		// The scope outlives the session in the store; the state is what says it
		// is live.
		useVoiceSessionStore.setState({ state: 'idle', scope: QUICK_CHAT } as never);
		startsOn(QUICK_CHAT);

		await openVoiceMic({ scope: QUICK_CHAT });

		expect(order).toEqual(['start']);
	});

	it('tells a session it had to start that a button is holding it', async () => {
		startsOn(QUICK_CHAT);

		await openVoiceMic({ hold: true, scope: QUICK_CHAT });

		expect(order).toEqual(['start', 'open:hold']);
	});

	it('sees the session its own press opened when the next press is queued behind it', async () => {
		startsOn(QUICK_CHAT);

		// A tap that starts the session, and a hold landing before it has answered.
		const tap = openVoiceMic({ scope: QUICK_CHAT });
		const hold = openVoiceMic({ hold: true, scope: QUICK_CHAT });
		await Promise.all([tap, hold]);

		// One session, then the hold resumes it. Not a second start.
		expect(order).toEqual(['start', 'open:hold']);
	});

	it('hands a refused start to a caller that has no toast surface', async () => {
		const refusal = new Error('Quick Chat is turned off.');
		start.mockRejectedValueOnce(refusal);
		const onError = vi.fn();

		await openVoiceMic({ scope: QUICK_CHAT, onError });

		expect(onError).toHaveBeenCalledWith(refusal);
		expect(notifyToast).not.toHaveBeenCalled();
	});
});

describe('closeVoiceMic', () => {
	it('shuts the microphone, dropping a half-said thought by default', async () => {
		await closeVoiceMic();
		expect(setListening).toHaveBeenCalledWith({ listening: false, send: false });
	});

	it('sends on a push-to-talk release', async () => {
		await closeVoiceMic({ send: true });
		expect(setListening).toHaveBeenCalledWith({ listening: false, send: true });
	});

	it('is harmless with no session', async () => {
		setListening.mockRejectedValueOnce(new Error('ACappellaDisabled'));
		await expect(closeVoiceMic()).resolves.toBeUndefined();
	});
});

describe('a press and its release', () => {
	it('reach main in order even when the press has to start a session first', async () => {
		// The failure this prevents: a quick tap's release reaches main before the
		// session its press is still starting, finds nothing to shut, and the
		// microphone the press then opens stays open with no button holding it.
		let releaseStart!: () => void;
		setListening.mockImplementationOnce(async () => {
			order.push('open:hold');
			return false;
		});
		start.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseStart = () => {
						order.push('start');
						resolve(snapshot());
					};
				})
		);

		const press = openVoiceMic({ hold: true });
		const release = closeVoiceMic({ send: true });
		// Let the press reach its pending start before the session "finishes".
		await vi.waitFor(() => expect(start).toHaveBeenCalled());
		releaseStart();
		await Promise.all([press, release]);

		expect(order).toEqual(['open:hold', 'start', 'open:hold', 'shut:send']);
	});
});

describe('setVoiceListenMode', () => {
	it('remembers the mode', async () => {
		await setVoiceListenMode('push-to-talk');

		expect(useVoiceUiStore.getState().listenMode).toBe('push-to-talk');
		expect(settingsSet).toHaveBeenCalledWith(
			'acappella',
			expect.objectContaining({ ui: expect.objectContaining({ listenMode: 'push-to-talk' }) })
		);
	});

	it('does not start a session: picking a mode is not asking to talk', async () => {
		await setVoiceListenMode('push-to-talk');

		expect(start).not.toHaveBeenCalled();
		expect(setListening).not.toHaveBeenCalled();
	});

	it('shuts a live microphone on the way into push-to-talk', async () => {
		useVoiceSessionStore.setState({ state: 'listening' });

		await setVoiceListenMode('push-to-talk');

		expect(setListening).toHaveBeenCalledWith({ listening: false });
	});

	it('opens a live session again on the way back to hands-free', async () => {
		useVoiceSessionStore.setState({ state: 'listening' });
		useVoiceUiStore.setState({ listenMode: 'push-to-talk' });

		await setVoiceListenMode('hands-free');

		expect(setListening).toHaveBeenCalledWith({ listening: true });
	});

	it('toggles to the other mode', async () => {
		await toggleVoiceListenMode();
		expect(useVoiceUiStore.getState().listenMode).toBe('push-to-talk');

		await toggleVoiceListenMode();
		expect(useVoiceUiStore.getState().listenMode).toBe('hands-free');
	});
});
