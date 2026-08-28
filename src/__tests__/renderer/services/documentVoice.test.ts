/**
 * Tests for the shared "talk with this document" flow.
 *
 * The point of the service is that the File Preview toolbar's microphone, the
 * Files panel right-click entry, and the command palette cannot drift: all three
 * check the same Encore flag, resolve the same agent, un-hide the HUD, and turn
 * the same refusal into the same toast.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { canTalkWithDocument, talkWithDocument } from '../../../renderer/services/documentVoice';
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

	start = vi.fn(async () => ({
		snapshot: { scope: { kind: 'document', sessionId: SESSION_ID, path: DOC_PATH } },
		substitutions: [],
	}));
	(window as unknown as { maestro: unknown }).maestro = { voice: { start } };

	useSessionStore.setState({
		sessions: [createMockSession({ id: SESSION_ID })],
		activeSessionId: SESSION_ID,
	});
	useVoiceSessionStore.getState().setDismissed(true);
	useVoiceUiStore.getState().setMinimized(true);
	enableVoice(true);
});

describe('canTalkWithDocument', () => {
	it('follows the A Cappella Encore flag', () => {
		expect(canTalkWithDocument()).toBe(true);
		enableVoice(false);
		expect(canTalkWithDocument()).toBe(false);
	});
});

describe('talkWithDocument', () => {
	it('opens a document-scoped session on the active agent', async () => {
		await talkWithDocument({ path: DOC_PATH });

		expect(start).toHaveBeenCalledWith({
			kind: 'document',
			sessionId: SESSION_ID,
			path: DOC_PATH,
		});
	});

	it('honours an explicit agent, since the Files panel can show another one', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: SESSION_ID }), createMockSession({ id: 'agent-2' })],
			activeSessionId: SESSION_ID,
		});

		await talkWithDocument({ path: DOC_PATH, sessionId: 'agent-2' });

		expect(start).toHaveBeenCalledWith({
			kind: 'document',
			sessionId: 'agent-2',
			path: DOC_PATH,
		});
	});

	it('un-hides the HUD, so the microphone it opened has a surface', async () => {
		await talkWithDocument({ path: DOC_PATH });

		expect(useVoiceSessionStore.getState().dismissed).toBe(false);
		expect(useVoiceUiStore.getState().minimized).toBe(false);
	});

	it('does nothing at all when the Encore Feature is off', async () => {
		enableVoice(false);

		await talkWithDocument({ path: DOC_PATH });

		expect(start).not.toHaveBeenCalled();
	});

	it('says so when there is no agent to hold the conversation', async () => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });

		await talkWithDocument({ path: DOC_PATH });

		expect(start).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'No agent to talk to' })
		);
	});

	it('turns a refused start into a toast rather than into silence', async () => {
		// The capability gate refuses BY NAME. A menu entry that appeared to do
		// nothing is the one outcome that teaches people the feature is broken.
		start.mockRejectedValueOnce(new Error('No speech-to-text model is installed'));

		await talkWithDocument({ path: DOC_PATH });

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Voice session could not start',
				message: 'No speech-to-text model is installed',
			})
		);
	});
});
