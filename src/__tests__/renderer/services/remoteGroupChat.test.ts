/**
 * Tests for the renderer service that answers group chat requests from the
 * WebSocket bridge (maestro-cli `group-chat`, web/mobile).
 *
 * Pinned behaviors:
 *  - a remotely started chat joins the Left Bar list but is never opened
 *    (the user's view must not move for background work);
 *  - participants join by @mention, and an ambiguous name is refused before
 *    anything is created;
 *  - a busy chat refuses a remote send instead of racing the moderator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../renderer/utils/groupChatAutoRunRegistry', () => ({
	getAutoRunSessionsForGroupChat: vi.fn(() => ['agent-with-batch']),
}));

import {
	getRemoteGroupChatState,
	listRemoteGroupChats,
	sendRemoteGroupChatMessage,
	startRemoteGroupChat,
	stopGroupChatWork,
} from '../../../renderer/services/remoteGroupChat';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../renderer/stores/batchStore';
import { createMockSession } from '../../helpers/mockSession';

const createdChat = {
	id: 'gc-new',
	name: 'Maestro Release',
	createdAt: 0,
	moderatorAgentId: 'claude-code',
	moderatorSessionId: 'group-chat-gc-new-moderator',
	participants: [],
	logPath: '/tmp/log',
	imagesDir: '/tmp/img',
};

const mockGroupChat = {
	create: vi.fn(),
	list: vi.fn(),
	load: vi.fn(),
	getMessages: vi.fn(),
	sendToModerator: vi.fn(),
	stopAll: vi.fn(),
};

function seedAgents(names: Array<[id: string, name: string, toolType?: string]>) {
	useSessionStore.setState({
		sessions: names.map(([id, name, toolType = 'claude-code']) =>
			createMockSession({ id, name, toolType } as never)
		),
		activeSessionId: 'someone-else',
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGroupChat.create.mockResolvedValue(createdChat);
	mockGroupChat.list.mockResolvedValue([createdChat]);
	mockGroupChat.load.mockResolvedValue(createdChat);
	mockGroupChat.getMessages.mockResolvedValue([]);
	mockGroupChat.sendToModerator.mockResolvedValue(undefined);
	mockGroupChat.stopAll.mockResolvedValue(undefined);
	(window.maestro as any).groupChat = { ...(window.maestro as any).groupChat, ...mockGroupChat };

	useGroupChatStore.setState({
		groupChats: [],
		activeGroupChatId: null,
		groupChatState: 'idle',
		groupChatStates: new Map(),
	} as never);
	seedAgents([
		['id-maestro', 'Maestro'],
		['id-rc', 'rc'],
		['id-web', 'RunMaestro.ai', 'codex'],
	]);
});

describe('startRemoteGroupChat', () => {
	it('creates the chat, lists it without opening it, and mentions every participant', async () => {
		const result = await startRemoteGroupChat('Maestro Release', ['id-rc', 'id-web'], {
			message: 'Cut the RC.',
		});

		expect(result).toEqual({ chatId: 'gc-new' });
		// Moderator defaults to the first participant's agent type.
		expect(mockGroupChat.create).toHaveBeenCalledWith('Maestro Release', 'claude-code');
		expect(mockGroupChat.sendToModerator).toHaveBeenCalledWith(
			'gc-new',
			'@rc @RunMaestro.ai\n\nCut the RC.'
		);
		const store = useGroupChatStore.getState();
		expect(store.groupChats.map((c) => c.id)).toEqual(['gc-new']);
		expect(store.activeGroupChatId).toBeNull();
		expect(store.groupChatStates.get('gc-new')).toBe('moderator-thinking');
		expect(useSessionStore.getState().activeSessionId).toBe('someone-else');
	});

	it('honors an explicit moderator and falls back to the topic as the opening message', async () => {
		await startRemoteGroupChat('Ship it', ['id-web'], { moderatorAgentId: 'claude-code' });

		expect(mockGroupChat.create).toHaveBeenCalledWith('Ship it', 'claude-code');
		expect(mockGroupChat.sendToModerator).toHaveBeenCalledWith(
			'gc-new',
			'@RunMaestro.ai\n\nShip it'
		);
	});

	it('refuses an unknown agent before creating anything', async () => {
		expect(await startRemoteGroupChat('X', ['nope'])).toEqual({ error: 'Unknown agent: nope' });
		expect(mockGroupChat.create).not.toHaveBeenCalled();
	});

	it('refuses a name two agents share, since the mention would pick the first', async () => {
		seedAgents([
			['id-a', 'rc'],
			['id-b', 'RC'],
		]);
		const result = await startRemoteGroupChat('X', ['id-a']);

		expect(result.error).toMatch(/2 agents answer to @rc/);
		expect(mockGroupChat.create).not.toHaveBeenCalled();
	});

	it('refuses a terminal agent', async () => {
		seedAgents([['id-t', 'shell', 'terminal']]);
		expect((await startRemoteGroupChat('X', ['id-t'])).error).toMatch(/terminal agent/);
	});

	it('strips the IPC prefix from a create failure', async () => {
		mockGroupChat.create.mockRejectedValue(
			new Error("Error invoking remote method 'groupChat:create': Invalid moderator agent ID")
		);
		expect(await startRemoteGroupChat('X', ['id-rc'])).toEqual({
			error: 'Invalid moderator agent ID',
		});
	});

	it('returns the chat id with the error when the opening message fails, and resets to idle', async () => {
		mockGroupChat.sendToModerator.mockRejectedValue(new Error('moderator down'));
		const result = await startRemoteGroupChat('X', ['id-rc']);

		expect(result).toEqual({
			chatId: 'gc-new',
			error: 'Chat created, but the opening message failed: moderator down',
		});
		expect(useGroupChatStore.getState().groupChatStates.get('gc-new')).toBe('idle');
	});
});

describe('sendRemoteGroupChatMessage', () => {
	it('sends when the chat is idle', async () => {
		expect(await sendRemoteGroupChatMessage('gc-new', 'next')).toBe(true);
		expect(mockGroupChat.sendToModerator).toHaveBeenCalledWith('gc-new', 'next');
	});

	it('refuses while the chat is busy', async () => {
		useGroupChatStore.setState({
			groupChatStates: new Map([['gc-new', 'agent-working']]),
		} as never);
		expect(await sendRemoteGroupChatMessage('gc-new', 'next')).toBe(false);
		expect(mockGroupChat.sendToModerator).not.toHaveBeenCalled();
	});

	it('refuses an unknown chat', async () => {
		mockGroupChat.load.mockResolvedValue(null);
		expect(await sendRemoteGroupChatMessage('gone', 'next')).toBe(false);
	});
});

describe('list and state', () => {
	it('lists chats with their live state', async () => {
		useGroupChatStore.setState({
			groupChatStates: new Map([['gc-new', 'moderator-thinking']]),
		} as never);
		const chats = await listRemoteGroupChats();
		expect(chats).toHaveLength(1);
		expect(chats[0]).toMatchObject({ id: 'gc-new', topic: 'Maestro Release', isActive: true });
	});

	it('includes the transcript in a single chat state, and null for a missing chat', async () => {
		mockGroupChat.getMessages.mockResolvedValue([
			{ timestamp: '2026-09-26T00:00:00Z', from: 'moderator', content: 'hi' },
		]);
		const state = await getRemoteGroupChatState('gc-new');
		expect(state?.messages.map((m) => m.content)).toEqual(['hi']);

		mockGroupChat.load.mockResolvedValue(null);
		expect(await getRemoteGroupChatState('gone')).toBeNull();
	});
});

describe('stopGroupChatWork', () => {
	it('ends Auto Run batches the chat started in participants, then stops its processes', async () => {
		const dispatchBatch = vi.spyOn(useBatchStore.getState(), 'dispatchBatch');
		await stopGroupChatWork('gc-new');

		expect(dispatchBatch).toHaveBeenCalledWith({
			type: 'COMPLETE_BATCH',
			sessionId: 'agent-with-batch',
		});
		expect(mockGroupChat.stopAll).toHaveBeenCalledWith('gc-new');
	});
});
