import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
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

vi.mock('../../../main/group-chat/group-chat-storage', () => ({
	loadGroupChat: routerMocks.loadGroupChat,
	updateParticipant: vi.fn(),
	addGroupChatHistoryEntry: vi.fn(),
	extractFirstSentence: (text: string) => text.split(/[.!?]/)[0] || text,
	getGroupChatDir: vi.fn(),
}));

vi.mock('../../../main/group-chat/group-chat-log', () => ({
	appendToLog: routerMocks.appendToLog,
	readLog: routerMocks.readLog,
}));

vi.mock('../../../main/group-chat/group-chat-moderator', () => ({
	getModeratorSessionId: routerMocks.getModeratorSessionId,
	isModeratorActive: routerMocks.isModeratorActive,
	getModeratorSystemPrompt: () => '{{CONDUCTOR_PROFILE}}',
	getModeratorSynthesisPrompt: () => 'Synthesize the participant responses.',
}));

vi.mock('../../../main/group-chat/group-chat-agent', () => ({
	addParticipant: vi.fn(),
	setActiveParticipantSession: vi.fn(),
	clearActiveParticipantSession: vi.fn(),
}));

vi.mock('../../../main/ipc/handlers/groupChat', () => ({
	groupChatEmitters: {
		emitMessage: routerMocks.emitMessage,
		emitStateChange: routerMocks.emitStateChange,
	},
}));

vi.mock('../../../main/power-manager', () => ({
	powerManager: {
		addBlockReason: vi.fn(),
		removeBlockReason: routerMocks.removeBlockReason,
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		error: routerMocks.loggerError,
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../main/agents', () => ({
	AgentDetector: class MockAgentDetector {},
}));

vi.mock('../../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: vi.fn(),
}));

import {
	routeUserMessage,
	spawnModeratorSynthesis,
} from '../../../main/group-chat/group-chat-router';
import type { IProcessManager } from '../../../main/group-chat/group-chat-moderator';

const chat = {
	id: 'chat-1',
	name: 'Inconsistent Moderator Chat',
	createdAt: 1,
	updatedAt: 1,
	moderatorAgentId: 'claude-code',
	moderatorSessionId: '',
	participants: [],
	logPath: '/tmp/group-chat.log',
	imagesDir: '/tmp/group-chat-images',
};

const createProcessManager = (): IProcessManager => ({
	spawn: vi.fn().mockReturnValue({ pid: 123, success: true }),
	write: vi.fn().mockReturnValue(true),
	kill: vi.fn().mockReturnValue(true),
});

describe('group-chat-router inconsistent moderator state', () => {
	let consoleLog: ReturnType<typeof vi.spyOn>;
	let consoleWarn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		routerMocks.loadGroupChat.mockResolvedValue(chat);
		routerMocks.appendToLog.mockResolvedValue(undefined);
		routerMocks.readLog.mockResolvedValue([]);
		routerMocks.getModeratorSessionId.mockReturnValue(undefined);
		routerMocks.isModeratorActive.mockReturnValue(true);
	});

	afterEach(() => {
		consoleLog.mockRestore();
		consoleWarn.mockRestore();
	});

	it('logs the user message but does not spawn when the moderator session prefix is missing', async () => {
		const processManager = createProcessManager();

		await routeUserMessage('chat-1', 'Please coordinate this.', processManager, {} as never);

		expect(routerMocks.appendToLog).toHaveBeenCalledWith(
			'/tmp/group-chat.log',
			'user',
			'Please coordinate this.',
			undefined
		);
		expect(routerMocks.emitMessage).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({
				from: 'user',
				content: 'Please coordinate this.',
			})
		);
		expect(processManager.spawn).not.toHaveBeenCalled();
		expect(consoleLog).toHaveBeenCalledWith(
			'[GroupChat:Debug] WARNING: No session ID prefix found for moderator'
		);
	});

	it('resets state when synthesis sees an active moderator without a session prefix', async () => {
		const processManager = createProcessManager();

		await spawnModeratorSynthesis('chat-1', processManager, {} as never);

		expect(routerMocks.loggerError).toHaveBeenCalledWith(
			'Cannot spawn synthesis - no moderator session ID for: chat-1',
			'[GroupChatRouter]'
		);
		expect(routerMocks.emitStateChange).toHaveBeenCalledWith('chat-1', 'idle');
		expect(routerMocks.removeBlockReason).toHaveBeenCalledWith('groupchat:chat-1');
		expect(processManager.spawn).not.toHaveBeenCalled();
	});
});
