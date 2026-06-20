import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	loadGroupChat: vi.fn(),
	appendToLog: vi.fn(),
	readLog: vi.fn(),
	getModeratorSessionId: vi.fn(),
	isModeratorActive: vi.fn(),
	emitMessage: vi.fn(),
	emitStateChange: vi.fn(),
	removeBlockReason: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock('../../main/group-chat/group-chat-storage', () => ({
	loadGroupChat: mocks.loadGroupChat,
	updateParticipant: vi.fn(),
	addGroupChatHistoryEntry: vi.fn(),
	extractFirstSentence: vi.fn((text: string) => text.split(/[.!?]/)[0] || text),
	getGroupChatDir: vi.fn(() => '/tmp/group-chat'),
}));

vi.mock('../../main/group-chat/group-chat-log', () => ({
	appendToLog: mocks.appendToLog,
	readLog: mocks.readLog,
}));

vi.mock('../../main/group-chat/group-chat-moderator', () => ({
	getModeratorSessionId: mocks.getModeratorSessionId,
	isModeratorActive: mocks.isModeratorActive,
	getModeratorSystemPrompt: vi.fn(() => 'moderator prompt'),
	getModeratorSynthesisPrompt: vi.fn(() => 'synthesis prompt'),
}));

vi.mock('../../main/group-chat/group-chat-agent', () => ({
	addParticipant: vi.fn(),
	setActiveParticipantSession: vi.fn(),
	clearActiveParticipantSession: vi.fn(),
}));

vi.mock('../../main/power-manager', () => ({
	powerManager: {
		removeBlockReason: mocks.removeBlockReason,
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		error: mocks.loggerError,
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../main/utils/agent-args', () => ({
	buildAgentArgs: vi.fn(() => []),
	applyAgentConfigOverrides: vi.fn((args: string[]) => args),
	getContextWindowValue: vi.fn(() => undefined),
}));

vi.mock('../../prompts', () => ({
	groupChatParticipantRequestPrompt: vi.fn(() => 'participant prompt'),
}));

vi.mock('../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: vi.fn(),
}));

vi.mock('../../main/group-chat/group-chat-config', () => ({
	setGetCustomShellPathCallback: vi.fn(),
	getWindowsSpawnConfig: vi.fn(() => ({})),
}));

vi.mock('../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
	}),
}));

vi.mock('../../main/ipc/handlers/groupChat', () => ({
	groupChatEmitters: {
		emitMessage: mocks.emitMessage,
		emitStateChange: mocks.emitStateChange,
	},
}));

import { routeUserMessage, spawnModeratorSynthesis } from '../../main/group-chat/group-chat-router';

const chat = {
	id: 'chat-1',
	name: 'Chat',
	moderatorAgentId: 'claude-code',
	moderatorConfig: undefined,
	participants: [],
	logPath: '/tmp/group-chat/chat-1.jsonl',
	createdAt: '2026-05-26T00:00:00.000Z',
	updatedAt: '2026-05-26T00:00:00.000Z',
};

describe('group-chat-router defensive moderator session branches', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.loadGroupChat.mockResolvedValue(chat);
		mocks.appendToLog.mockResolvedValue(undefined);
		mocks.readLog.mockResolvedValue([]);
		mocks.isModeratorActive.mockReturnValue(true);
		mocks.getModeratorSessionId.mockReturnValue(undefined);
	});

	it('logs user messages without spawning when the moderator session prefix is missing', async () => {
		const processManager = {
			spawn: vi.fn(),
			write: vi.fn(),
			kill: vi.fn(),
		};
		const agentDetector = {
			getAgent: vi.fn(),
		};

		await routeUserMessage(chat.id, 'hello', processManager, agentDetector as never);

		expect(mocks.appendToLog).toHaveBeenCalledWith(
			chat.logPath,
			'user',
			'hello',
			undefined,
			undefined
		);
		expect(mocks.emitMessage).toHaveBeenCalledWith(
			chat.id,
			expect.objectContaining({
				from: 'user',
				content: 'hello',
			})
		);
		expect(processManager.spawn).not.toHaveBeenCalled();
	});

	it('returns synthesis to idle when the moderator is active but has no session prefix', async () => {
		const processManager = {
			spawn: vi.fn(),
			write: vi.fn(),
			kill: vi.fn(),
		};
		const agentDetector = {
			getAgent: vi.fn(),
		};

		await spawnModeratorSynthesis(chat.id, processManager, agentDetector as never);

		expect(mocks.loggerError).toHaveBeenCalledWith(
			`Cannot spawn synthesis - no moderator session ID for: ${chat.id}`,
			'[GroupChatRouter]'
		);
		expect(mocks.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle');
		expect(mocks.removeBlockReason).toHaveBeenCalledWith(`groupchat:${chat.id}`);
		expect(processManager.spawn).not.toHaveBeenCalled();
	});
});
