/**
 * Tests for the shared "talk with this document" flow.
 *
 * The point of the service is that the document chat's microphone, the
 * Files panel right-click entry, and the command palette cannot drift: all three
 * check the same Encore flag and resolve the same agent. Navigation waits for
 * the panel, whose microphone uses the shared voice controls without a HUD.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
	canTalkWithDocument,
	startDocumentVoice,
	talkWithDocument,
} from '../../../renderer/services/documentVoice';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useVoiceSessionStore } from '../../../renderer/stores/voiceSessionStore';
import { useVoiceUiStore } from '../../../renderer/stores/voiceUiStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createMockSession } from '../../helpers/mockSession';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

const SESSION_ID = 'agent-1';
const DOC_PATH = '/repo/docs/system-overview.md';

let start: Mock;
let openFile: Mock;

function enableVoice(enabled: boolean): void {
	useSettingsStore.setState({
		encoreFeatures: {
			...useSettingsStore.getState().encoreFeatures,
			aCappella: enabled,
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	openFile = vi.fn();
	window.addEventListener('maestro:openFileTab', openFile);

	start = vi.fn(async (scope) => ({
		snapshot: { sessionId: 'voice-1', state: 'listening', scope, seq: 1, providerIds: {} },
		substitutions: [],
	}));
	(window as unknown as { maestro: unknown }).maestro = {
		voice: { start, setListening: vi.fn().mockResolvedValue(true) },
	};

	useSessionStore.setState({
		sessions: [createMockSession({ id: SESSION_ID })],
		activeSessionId: SESSION_ID,
	});
	useVoiceSessionStore.getState().reset();
	useVoiceSessionStore.getState().setDismissed(true);
	useVoiceUiStore.getState().setMinimized(true);
	enableVoice(true);
});

afterEach(() => {
	window.removeEventListener('maestro:openFileTab', openFile);
});

describe('canTalkWithDocument', () => {
	it('follows the A Cappella Encore flag', () => {
		expect(canTalkWithDocument()).toBe(true);
		enableVoice(false);
		expect(canTalkWithDocument()).toBe(false);
	});
});

describe('talkWithDocument', () => {
	it('asks the preview to open its own voice chat before any microphone starts', async () => {
		await talkWithDocument({ path: DOC_PATH });

		expect(openFile).toHaveBeenCalledWith(
			expect.objectContaining({
				detail: { sessionId: SESSION_ID, filePath: DOC_PATH, documentChat: 'voice' },
			})
		);
		expect(start).not.toHaveBeenCalled();
	});

	it('honours an explicit agent, since the Files panel can show another one', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: SESSION_ID }), createMockSession({ id: 'agent-2' })],
			activeSessionId: SESSION_ID,
		});

		await talkWithDocument({ path: DOC_PATH, sessionId: 'agent-2' });

		expect(openFile).toHaveBeenCalledWith(
			expect.objectContaining({
				detail: { sessionId: 'agent-2', filePath: DOC_PATH, documentChat: 'voice' },
			})
		);
		expect(start).not.toHaveBeenCalled();
	});

	it('leaves the separate HUD alone while opening the document chat', async () => {
		await talkWithDocument({ path: DOC_PATH });

		expect(useVoiceSessionStore.getState().dismissed).toBe(true);
		expect(useVoiceUiStore.getState().minimized).toBe(true);
	});

	it('does nothing at all when the Encore Feature is off', async () => {
		enableVoice(false);

		await talkWithDocument({ path: DOC_PATH });

		expect(start).not.toHaveBeenCalled();
		expect(openFile).not.toHaveBeenCalled();
	});

	it('says so when there is no agent to hold the conversation', async () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });

		await talkWithDocument({ path: DOC_PATH });

		expect(start).not.toHaveBeenCalled();
		expect(openFile).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'No agent to talk to' })
		);
	});

	it('starts the embedded microphone on its document without opening the file again', async () => {
		await startDocumentVoice({ path: DOC_PATH });
		expect(start).toHaveBeenCalledWith({ kind: 'document', sessionId: SESSION_ID, path: DOC_PATH });
		expect(openFile).not.toHaveBeenCalled();
		expect(useVoiceUiStore.getState().minimized).toBe(true);
	});

	it('uses the shared hold gesture when the embedded microphone is held', async () => {
		await startDocumentVoice({ path: DOC_PATH }, true);
		expect(window.maestro.voice.setListening).toHaveBeenCalledWith({ listening: true, hold: true });
	});

	it('turns a refused embedded start into a toast rather than into silence', async () => {
		// The capability gate refuses BY NAME. A menu entry that appeared to do
		// nothing is the one outcome that teaches people the feature is broken.
		start.mockRejectedValueOnce(new Error('No speech-to-text model is installed'));

		await startDocumentVoice({ path: DOC_PATH });

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Voice session could not start',
				message: 'No speech-to-text model is installed',
			})
		);
	});
});
