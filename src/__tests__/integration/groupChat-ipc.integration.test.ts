import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, type BrowserWindow } from 'electron';
import * as fs from 'fs/promises';

import {
	groupChatEmitters,
	registerGroupChatHandlers,
	type GroupChatHandlerDependencies,
} from '../../main/ipc/handlers/groupChat';
import {
	addGroupChatHistoryEntry,
	clearGroupChatHistory,
	createGroupChat,
	deleteGroupChat,
	deleteGroupChatHistoryEntry,
	getGroupChatDir,
	getGroupChatHistory,
	getGroupChatHistoryFilePath,
	loadGroupChat,
	listGroupChats,
	updateGroupChat,
	updateParticipant,
} from '../../main/group-chat/group-chat-storage';
import { appendToLog, readLog, saveImage } from '../../main/group-chat/group-chat-log';
import {
	getModeratorSessionId,
	isModeratorActive,
	killModerator,
	spawnModerator,
} from '../../main/group-chat/group-chat-moderator';
import {
	addParticipant,
	clearAllParticipantSessions,
	removeParticipant,
	sendToParticipant,
} from '../../main/group-chat/group-chat-agent';
import {
	clearPendingParticipants,
	markParticipantResponded,
	routeAgentResponse,
	routeUserMessage,
	spawnModeratorSynthesis,
} from '../../main/group-chat/group-chat-router';
import { groomContext } from '../../main/utils/context-groomer';
import { logger } from '../../main/utils/logger';

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	BrowserWindow: vi.fn(),
}));

vi.mock('fs/promises', () => ({
	readdir: vi.fn(),
	readFile: vi.fn(),
}));

vi.mock('uuid', () => ({
	v4: vi.fn(() => 'uuid-new-session'),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('../../main/group-chat/group-chat-storage', () => ({
	addGroupChatHistoryEntry: vi.fn(),
	clearGroupChatHistory: vi.fn(),
	createGroupChat: vi.fn(),
	deleteGroupChat: vi.fn(),
	deleteGroupChatHistoryEntry: vi.fn(),
	getGroupChatDir: vi.fn(),
	getGroupChatHistory: vi.fn(),
	getGroupChatHistoryFilePath: vi.fn(),
	loadGroupChat: vi.fn(),
	listGroupChats: vi.fn(),
	updateGroupChat: vi.fn(),
	updateParticipant: vi.fn(),
}));

vi.mock('../../main/group-chat/group-chat-log', () => ({
	appendToLog: vi.fn(),
	readLog: vi.fn(),
	saveImage: vi.fn(),
}));

vi.mock('../../main/group-chat/group-chat-moderator', () => ({
	getModeratorSessionId: vi.fn(),
	isModeratorActive: vi.fn(),
	killModerator: vi.fn(),
	sendToModerator: vi.fn(),
	spawnModerator: vi.fn(),
}));

vi.mock('../../main/group-chat/group-chat-agent', () => ({
	addParticipant: vi.fn(),
	clearAllParticipantSessions: vi.fn(),
	removeParticipant: vi.fn(),
	sendToParticipant: vi.fn(),
}));

vi.mock('../../main/group-chat/group-chat-router', () => ({
	clearPendingParticipants: vi.fn(),
	markParticipantResponded: vi.fn(),
	routeAgentResponse: vi.fn(),
	routeUserMessage: vi.fn(),
	spawnModeratorSynthesis: vi.fn(),
}));

vi.mock('../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
}));

type Handler = (event?: unknown, ...args: any[]) => Promise<any>;

const handlers = new Map<string, Handler>();

const processManager = {
	kill: vi.fn(),
	off: vi.fn(),
	on: vi.fn(),
	spawn: vi.fn(),
	write: vi.fn(),
};
const agentDetector = { detectAgents: vi.fn() };
const mainWindow = {
	isDestroyed: vi.fn(),
	webContents: {
		isDestroyed: vi.fn(),
		send: vi.fn(),
	},
};

function createChat(overrides: Record<string, unknown> = {}) {
	return {
		id: 'chat-1',
		name: 'Launch Room',
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'moderator-session',
		logPath: '/tmp/chat.log',
		imagesDir: '/tmp/chat-images',
		participants: [
			{
				name: 'Ada',
				agentId: 'codex',
				agentSessionId: 'participant-session',
				contextUsage: 61,
			},
		],
		archived: false,
		...overrides,
	} as any;
}

function invoke<T = unknown>(channel: string, ...args: any[]): Promise<T> {
	const handler = handlers.get(channel);
	expect(handler, `Expected ${channel} to be registered`).toBeDefined();
	return handler!({}, ...args) as Promise<T>;
}

function register(overrides: Partial<GroupChatHandlerDependencies> = {}) {
	handlers.clear();
	const deps: GroupChatHandlerDependencies = {
		getAgentConfig: vi.fn(() => ({ customArgs: '--fast' })),
		getAgentDetector: () => agentDetector as never,
		getCustomEnvVars: vi.fn(() => ({ API_MODE: 'test' })),
		getMainWindow: () => mainWindow as unknown as BrowserWindow,
		getProcessManager: () => processManager,
		...overrides,
	};
	registerGroupChatHandlers(deps);
	return deps;
}

describe('groupChat IPC integration', () => {
	let consoleLog: ReturnType<typeof vi.spyOn>;
	let consoleWarn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();
		consoleLog = vi.spyOn(globalThis.console, 'log').mockImplementation(() => {});
		consoleWarn = vi.spyOn(globalThis.console, 'warn').mockImplementation(() => {});

		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as Handler);
		});
		mainWindow.isDestroyed.mockReturnValue(false);
		mainWindow.webContents.isDestroyed.mockReturnValue(false);
		processManager.spawn.mockReturnValue({ pid: 123, success: true });
		processManager.write.mockReturnValue(true);
		processManager.kill.mockReturnValue(true);

		vi.mocked(createGroupChat).mockResolvedValue(createChat());
		vi.mocked(loadGroupChat).mockResolvedValue(createChat());
		vi.mocked(listGroupChats).mockResolvedValue([createChat()]);
		vi.mocked(updateGroupChat).mockResolvedValue(createChat({ name: 'Updated' }));
		vi.mocked(addGroupChatHistoryEntry).mockResolvedValue({
			id: 'history-1',
			type: 'message',
			timestamp: 1700000000000,
			content: 'Done',
		} as any);
		vi.mocked(deleteGroupChatHistoryEntry).mockResolvedValue(true);
		vi.mocked(getGroupChatHistory).mockResolvedValue([{ id: 'history-1' }] as any);
		vi.mocked(getGroupChatHistoryFilePath).mockReturnValue('/tmp/history.jsonl');
		vi.mocked(getGroupChatDir).mockReturnValue('/tmp/group-chat/chat-1');
		vi.mocked(readLog).mockResolvedValue([{ from: 'Ada', content: 'hello' }] as any);
		vi.mocked(saveImage).mockResolvedValue('saved.png');
		vi.mocked(spawnModerator).mockResolvedValue('moderator-session');
		vi.mocked(getModeratorSessionId).mockReturnValue('moderator-session');
		vi.mocked(isModeratorActive).mockReturnValue(true);
		vi.mocked(addParticipant).mockResolvedValue({
			name: 'Grace',
			agentId: 'codex',
			sessionId: 'participant-session',
		} as any);
		vi.mocked(markParticipantResponded).mockReturnValue(true);
		vi.mocked(groomContext).mockResolvedValue({ response: 'Condensed context', durationMs: 42 });
		vi.mocked(fs.readdir).mockResolvedValue(['one.png', 'two.webp', 'notes.txt'] as any);
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('image-bytes'));

		register();
	});

	afterEach(() => {
		consoleLog.mockRestore();
		consoleWarn.mockRestore();
	});

	it('registers handler channels and routes storage CRUD operations through process cleanup', async () => {
		expect(handlers.size).toBe(26);
		expect([...handlers.keys()]).toEqual(
			expect.arrayContaining([
				'groupChat:create',
				'groupChat:update',
				'groupChat:stopAll',
				'groupChat:getImages',
			])
		);

		await expect(
			invoke('groupChat:create', 'Launch Room', 'claude-code', { customPath: '/bin/claude' })
		).resolves.toMatchObject({ id: 'chat-1' });
		expect(createGroupChat).toHaveBeenCalledWith('Launch Room', 'claude-code', {
			customPath: '/bin/claude',
		});
		expect(spawnModerator).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'chat-1' }),
			processManager
		);

		await expect(invoke('groupChat:list')).resolves.toHaveLength(1);
		await expect(invoke('groupChat:load', 'chat-1')).resolves.toMatchObject({ id: 'chat-1' });
		await expect(invoke('groupChat:rename', 'chat-1', 'New Name')).resolves.toMatchObject({
			name: 'Updated',
		});

		await invoke('groupChat:archive', 'chat-1', true);
		expect(killModerator).toHaveBeenCalledWith('chat-1', processManager);
		expect(clearAllParticipantSessions).toHaveBeenCalledWith('chat-1', processManager);
		expect(updateGroupChat).toHaveBeenCalledWith('chat-1', { archived: true });

		vi.mocked(killModerator).mockClear();
		await invoke('groupChat:archive', 'chat-1', false);
		expect(killModerator).not.toHaveBeenCalled();
		expect(updateGroupChat).toHaveBeenCalledWith('chat-1', { archived: false });

		await invoke('groupChat:delete', 'chat-1');
		expect(deleteGroupChat).toHaveBeenCalledWith('chat-1');
	});

	it('updates moderator settings, handles chat logs, and routes moderator commands', async () => {
		vi.mocked(loadGroupChat)
			.mockResolvedValueOnce(createChat({ moderatorAgentId: 'claude-code' }))
			.mockResolvedValueOnce(createChat({ moderatorAgentId: 'codex' }));

		await expect(
			invoke('groupChat:update', 'chat-1', {
				name: 'Updated',
				moderatorAgentId: 'codex',
				moderatorConfig: { customArgs: '--model o3' },
			})
		).resolves.toMatchObject({ moderatorAgentId: 'codex' });
		expect(killModerator).toHaveBeenCalledWith('chat-1', processManager);
		expect(updateGroupChat).toHaveBeenCalledWith('chat-1', {
			name: 'Updated',
			moderatorAgentId: 'codex',
			moderatorConfig: { customArgs: '--model o3' },
		});
		expect(spawnModerator).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'Updated' }),
			processManager
		);

		vi.mocked(loadGroupChat).mockResolvedValue(createChat());
		await invoke('groupChat:appendMessage', 'chat-1', 'user', 'hello');
		expect(appendToLog).toHaveBeenCalledWith('/tmp/chat.log', 'user', 'hello');
		await expect(invoke('groupChat:getMessages', 'chat-1')).resolves.toEqual([
			{ from: 'Ada', content: 'hello' },
		]);
		await expect(
			invoke('groupChat:saveImage', 'chat-1', Buffer.from('x').toString('base64'), 'x.png')
		).resolves.toBe('saved.png');
		expect(saveImage).toHaveBeenCalledWith('/tmp/chat-images', Buffer.from('x'), 'x.png');

		await expect(invoke('groupChat:startModerator', 'chat-1')).resolves.toBe('moderator-session');
		await invoke('groupChat:sendToModerator', 'chat-1', 'please coordinate', ['one.png'], true);
		expect(routeUserMessage).toHaveBeenCalledWith(
			'chat-1',
			'please coordinate',
			processManager,
			agentDetector,
			true,
			['one.png']
		);
		expect(logger.info).toHaveBeenCalledWith('[GroupChat:Debug] User message routed to moderator');

		await invoke('groupChat:stopModerator', 'chat-1');
		expect(killModerator).toHaveBeenCalledWith('chat-1', processManager);
		await expect(invoke('groupChat:getModeratorSessionId', 'chat-1')).resolves.toBe(
			'moderator-session'
		);
	});

	it('rejects missing chats and missing runtime dependencies with specific errors', async () => {
		register({ getProcessManager: () => undefined as never });
		await expect(invoke('groupChat:create', 'Cold Room', 'codex')).resolves.toMatchObject({
			id: 'chat-1',
		});
		expect(spawnModerator).not.toHaveBeenCalled();

		register();
		vi.mocked(loadGroupChat).mockResolvedValueOnce(null);
		await expect(invoke('groupChat:update', 'missing-chat', { name: 'Nope' })).rejects.toThrow(
			'Group chat not found: missing-chat'
		);

		vi.mocked(loadGroupChat).mockResolvedValueOnce(createChat());
		await expect(
			invoke('groupChat:update', 'chat-1', { name: 'Only Name' })
		).resolves.toMatchObject({
			name: 'Updated',
		});

		for (const channel of [
			'groupChat:appendMessage',
			'groupChat:getMessages',
			'groupChat:saveImage',
		]) {
			vi.mocked(loadGroupChat).mockResolvedValueOnce(null);
			await expect(invoke(channel, 'missing-chat', 'Ada', 'payload')).rejects.toThrow(
				'Group chat not found: missing-chat'
			);
		}

		vi.mocked(loadGroupChat).mockResolvedValueOnce(null);
		await expect(invoke('groupChat:startModerator', 'missing-chat')).rejects.toThrow(
			'Group chat not found: missing-chat'
		);

		register({ getProcessManager: () => undefined as never });
		vi.mocked(loadGroupChat).mockResolvedValue(createChat());
		await expect(invoke('groupChat:startModerator', 'chat-1')).rejects.toThrow(
			'Process manager not initialized'
		);
		await expect(invoke('groupChat:addParticipant', 'chat-1', 'Grace', 'codex')).rejects.toThrow(
			'Process manager not initialized'
		);

		register();
		vi.mocked(loadGroupChat).mockResolvedValueOnce(null);
		await expect(
			invoke('groupChat:resetParticipantContext', 'missing-chat', 'Ada')
		).rejects.toThrow('Group chat not found: missing-chat');

		vi.mocked(loadGroupChat).mockResolvedValueOnce(createChat({ participants: [] }));
		await expect(invoke('groupChat:resetParticipantContext', 'chat-1', 'Ada')).rejects.toThrow(
			'Participant not found: Ada'
		);

		register({ getProcessManager: () => undefined as never });
		vi.mocked(loadGroupChat).mockResolvedValue(createChat());
		await expect(invoke('groupChat:resetParticipantContext', 'chat-1', 'Ada')).rejects.toThrow(
			'Process manager not initialized'
		);

		register({ getAgentDetector: () => undefined as never });
		vi.mocked(loadGroupChat).mockResolvedValue(createChat());
		await expect(invoke('groupChat:resetParticipantContext', 'chat-1', 'Ada')).rejects.toThrow(
			'Agent detector not initialized'
		);

		register();
		vi.mocked(loadGroupChat).mockResolvedValueOnce(null);
		await expect(invoke('groupChat:getImages', 'missing-chat')).rejects.toThrow(
			'Group chat not found: missing-chat'
		);
	});

	it('routes stop-all, Auto Run completion, participant lifecycle, and context reset flows', async () => {
		await invoke('groupChat:stopAll', 'chat-1');
		expect(clearPendingParticipants).toHaveBeenCalledWith('chat-1');
		expect(mainWindow.webContents.send).toHaveBeenCalledWith(
			'groupChat:participantState',
			'chat-1',
			'Ada',
			'idle'
		);
		expect(mainWindow.webContents.send).toHaveBeenCalledWith(
			'groupChat:stateChange',
			'chat-1',
			'idle'
		);

		await invoke('groupChat:reportAutoRunComplete', 'chat-1', 'Ada', 'Finished selected docs');
		expect(routeAgentResponse).toHaveBeenCalledWith(
			'chat-1',
			'Ada',
			'Finished selected docs',
			processManager
		);
		expect(mainWindow.webContents.send).toHaveBeenCalledWith(
			'groupChat:autoRunBatchComplete',
			'chat-1',
			'Ada'
		);
		expect(spawnModeratorSynthesis).toHaveBeenCalledWith('chat-1', processManager, agentDetector);

		await expect(
			invoke('groupChat:addParticipant', 'chat-1', 'Grace', 'codex', '/repo')
		).resolves.toMatchObject({ name: 'Grace' });
		expect(addParticipant).toHaveBeenCalledWith(
			'chat-1',
			'Grace',
			'codex',
			processManager,
			'/repo',
			agentDetector,
			{ customArgs: '--fast' },
			{ API_MODE: 'test' }
		);

		await invoke('groupChat:sendToParticipant', 'chat-1', 'Grace', 'status?', ['img.png']);
		expect(sendToParticipant).toHaveBeenCalledWith('chat-1', 'Grace', 'status?', processManager);
		await invoke('groupChat:removeParticipant', 'chat-1', 'Grace');
		expect(removeParticipant).toHaveBeenCalledWith('chat-1', 'Grace', processManager);

		await expect(
			invoke('groupChat:resetParticipantContext', 'chat-1', 'Ada', '/repo')
		).resolves.toEqual({ newAgentSessionId: 'uuid-new-session' });
		expect(groomContext).toHaveBeenCalledWith(
			expect.objectContaining({
				agentSessionId: 'participant-session',
				agentType: 'codex',
				projectRoot: '/repo',
				readOnlyMode: true,
			}),
			processManager,
			agentDetector
		);
		expect(updateParticipant).toHaveBeenCalledWith('chat-1', 'Ada', {
			agentSessionId: undefined,
			contextUsage: 0,
		});

		vi.mocked(groomContext).mockRejectedValueOnce(new Error('timeout'));
		await expect(invoke('groupChat:resetParticipantContext', 'chat-1', 'Ada')).resolves.toEqual({
			newAgentSessionId: 'uuid-new-session',
		});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Summary generation failed for Ada'),
			'[GroupChat]'
		);
	});

	it('handles history, image reads, and renderer emitter availability branches', async () => {
		await expect(invoke('groupChat:getHistory', 'chat-1')).resolves.toEqual([{ id: 'history-1' }]);
		await expect(
			invoke('groupChat:addHistoryEntry', 'chat-1', {
				type: 'message',
				timestamp: 1700000000000,
				content: 'Done',
			})
		).resolves.toMatchObject({ id: 'history-1' });
		expect(mainWindow.webContents.send).toHaveBeenCalledWith(
			'groupChat:historyEntry',
			'chat-1',
			expect.objectContaining({ id: 'history-1' })
		);
		await expect(invoke('groupChat:deleteHistoryEntry', 'chat-1', 'history-1')).resolves.toBe(true);
		await invoke('groupChat:clearHistory', 'chat-1');
		expect(clearGroupChatHistory).toHaveBeenCalledWith('chat-1');
		await expect(invoke('groupChat:getHistoryFilePath', 'chat-1')).resolves.toBe(
			'/tmp/history.jsonl'
		);

		await expect(invoke('groupChat:getImages', 'chat-1')).resolves.toEqual({
			'one.png': `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
			'two.webp': `data:image/webp;base64,${Buffer.from('image-bytes').toString('base64')}`,
		});
		expect(fs.readFile).toHaveBeenCalledTimes(2);

		vi.mocked(fs.readdir).mockRejectedValueOnce(
			Object.assign(new Error('missing'), { code: 'ENOENT' })
		);
		await expect(invoke('groupChat:getImages', 'chat-1')).resolves.toEqual({});
		vi.mocked(fs.readdir).mockRejectedValueOnce(
			Object.assign(new Error('permission'), { code: 'EACCES' })
		);
		await expect(invoke('groupChat:getImages', 'chat-1')).resolves.toEqual({});
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('Error reading images directory'),
			'[GroupChat]'
		);
		vi.mocked(logger.warn).mockClear();

		groupChatEmitters.emitMessage?.('chat-1', { from: 'Ada', content: 'hello' } as any);
		groupChatEmitters.emitModeratorUsage?.('chat-1', {
			contextUsage: 20,
			tokenCount: 400,
			totalCost: 1.25,
		});
		groupChatEmitters.emitModeratorSessionIdChanged?.('chat-1', 'new-session');
		groupChatEmitters.emitAutoRunTriggered?.('chat-1', 'Ada', 'plan');
		groupChatEmitters.emitParticipantLiveOutput?.('chat-1', 'Ada', 'chunk');

		expect(mainWindow.webContents.send).toHaveBeenCalledWith(
			'groupChat:participantLiveOutput',
			'chat-1',
			'Ada',
			'chunk'
		);

		mainWindow.webContents.send.mockClear();
		mainWindow.isDestroyed.mockReturnValue(true);
		groupChatEmitters.emitMessage?.('chat-1', { from: 'Ada', content: 'hidden' } as any);
		groupChatEmitters.emitStateChange?.('chat-1', 'idle');
		groupChatEmitters.emitParticipantsChanged?.('chat-1', []);
		groupChatEmitters.emitModeratorUsage?.('chat-1', {
			contextUsage: 20,
			tokenCount: 400,
			totalCost: 1.25,
		});
		groupChatEmitters.emitHistoryEntry?.('chat-1', {
			id: 'history-hidden',
			type: 'message',
			timestamp: 1700000000001,
			content: 'hidden',
		} as any);
		groupChatEmitters.emitParticipantState?.('chat-1', 'Ada', 'idle');
		groupChatEmitters.emitModeratorSessionIdChanged?.('chat-1', 'hidden-session');
		groupChatEmitters.emitAutoRunTriggered?.('chat-1', 'Ada', 'hidden-plan');
		groupChatEmitters.emitAutoRunBatchComplete?.('chat-1', 'Ada');
		groupChatEmitters.emitParticipantLiveOutput?.('chat-1', 'Ada', 'hidden chunk');
		expect(mainWindow.webContents.send).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			'[GroupChat:IPC] WARNING: mainWindow not available, cannot send participant state'
		);
	});
});
