/**
 * QuickChatRoot - where the Quick Chat window draws its voice session.
 *
 * The window's own behavior is in `QuickChatRoot.test.tsx`. This file stands
 * the voice hook in, which that one must not do, so it is its own module.
 *
 * The microphone itself is `QuickChatVoiceButton` and what it does is
 * `useQuickChatVoice`; both have their own tests. This file covers what the
 * window does with them: no microphone with A Cappella off, room for a live
 * session before there is a conversation, what is being heard drawn where the
 * message will land, and a voice failure said inline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { QuickChatVoice } from '../../../renderer/hooks/voice/useQuickChatVoice';
import { EMPTY_QUICK_CHAT_SNAPSHOT, type QuickChatSnapshot } from '../../../shared/quickChat';
import { useVoiceSessionStore } from '../../../renderer/stores/voiceSessionStore';
import { mockTheme } from '../../helpers/mockTheme';

let voice: QuickChatVoice;

vi.mock('../../../renderer/hooks/voice/useQuickChatVoice', () => ({
	useQuickChatVoice: () => voice,
}));
// The window's own boot: settings, theme and markdown are not what is under test.
vi.mock('../../../renderer/hooks/settings/useWindowSettingsSync', () => ({
	useWindowSettingsSync: vi.fn(),
}));
vi.mock('../../../renderer/hooks/ui/useResolvedTheme', () => ({
	useResolvedTheme: () => mockTheme,
}));
vi.mock('../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { QuickChatRoot } from '../../../renderer/quickChat/QuickChatRoot';

function makeVoice(overrides: Partial<QuickChatVoice> = {}): QuickChatVoice {
	return {
		enabled: true,
		active: false,
		visualState: 'idle-armed',
		partialTranscript: '',
		error: null,
		holdThresholdMs: 250,
		toggle: vi.fn(),
		holdStart: vi.fn(),
		holdEnd: vi.fn(),
		...overrides,
	};
}

function snapshot(overrides: Partial<QuickChatSnapshot> = {}): QuickChatSnapshot {
	return { ...EMPTY_QUICK_CHAT_SNAPSHOT, agentId: 'agent-1', agentName: 'Pedsidian', ...overrides };
}

/** Render the window on `chat`, and wait for its first snapshot read to land. */
async function renderRoot(chat: QuickChatSnapshot = snapshot()) {
	vi.mocked(window.maestro.quickChat.getSnapshot).mockResolvedValue(chat as never);
	render(<QuickChatRoot />);
	await waitFor(() =>
		expect(screen.getByTestId('quick-chat-agent-button')).toHaveTextContent('Pedsidian')
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	useVoiceSessionStore.getState().reset();
	voice = makeVoice();
});

afterEach(() => {
	cleanup();
});

describe('the microphone', () => {
	it('is not drawn with A Cappella off', async () => {
		voice = makeVoice({ enabled: false });
		await renderRoot();

		expect(screen.queryByTestId('quick-chat-voice-button')).toBeNull();
	});

	it('sits in the composer with A Cappella on, and talks to the chat agent', async () => {
		await renderRoot();

		expect(screen.getByTestId('quick-chat-voice-button')).toHaveAttribute(
			'aria-label',
			'Talk to Pedsidian. Click to start, or hold to talk.'
		);
	});
});

describe('a live voice session', () => {
	it('stays in the composer-only shape until a session is live', async () => {
		await renderRoot();

		expect(window.maestro.quickChat.setLayout).toHaveBeenLastCalledWith('compact');
	});

	it('grows the window before there is a conversation, and says what it is doing', async () => {
		voice = makeVoice({ active: true, visualState: 'listening' });
		await renderRoot();

		expect(window.maestro.quickChat.setLayout).toHaveBeenLastCalledWith('expanded');
		expect(screen.getByTestId('quick-chat-voice-status')).toHaveTextContent(
			'Listening. The microphone is open.'
		);
	});

	it('draws what is being heard where the sent message will land', async () => {
		voice = makeVoice({
			active: true,
			visualState: 'listening',
			partialTranscript: 'what day is',
		});
		await renderRoot();

		expect(screen.getByTestId('quick-chat-voice-partial')).toHaveTextContent('what day is');
		// The hypothesis replaces the status line; it does not sit beside it.
		expect(screen.queryByTestId('quick-chat-voice-status')).toBeNull();
	});

	it('leaves the status line to the working counter while the agent is answering', async () => {
		voice = makeVoice({ active: true, visualState: 'thinking' });
		const since = Date.now();
		await renderRoot(
			snapshot({
				tabId: 'tab-1',
				busy: true,
				busySince: since,
				messages: [
					{
						id: 'm1',
						role: 'user',
						text: 'what day is it',
						timestamp: since,
						route: {
							status: 'running',
							tabId: 'tab-1',
							tabName: 'Quick Chat',
							origin: 'new',
							tabOpen: true,
							since,
						},
					},
				],
			})
		);

		expect(screen.getByTestId('quick-chat-working')).toHaveTextContent(/Working for/);
		expect(screen.queryByTestId('quick-chat-voice-status')).toBeNull();
	});

	it('shows a held sentence and how to send it, so a hold never reads as a dead session', async () => {
		voice = makeVoice({ active: true, visualState: 'listening' });
		useVoiceSessionStore.setState({
			heldUtterance: { settlesAt: Date.now() + 30_000, sendPhrases: ['send it'] },
		} as never);
		await renderRoot();

		expect(screen.getByTestId('voice-hud-held')).toHaveTextContent('send it');
		expect(screen.getByTestId('voice-hud-send-now')).toBeInTheDocument();
	});

	it('draws no voice lines for a session that is not live', async () => {
		useVoiceSessionStore.setState({
			heldUtterance: { settlesAt: Date.now() + 30_000, sendPhrases: ['send it'] },
		} as never);
		await renderRoot(snapshot({ tabId: 'tab-1', messages: [] }));

		expect(screen.queryByTestId('voice-hud-held')).toBeNull();
		expect(screen.queryByTestId('quick-chat-voice-status')).toBeNull();
	});

	it('says a voice failure inline: this window has no toast surface', async () => {
		voice = makeVoice({ error: 'Speech-to-Text needs a model.' });
		await renderRoot();

		expect(screen.getByText('Speech-to-Text needs a model.')).toBeInTheDocument();
	});
});
