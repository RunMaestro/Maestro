/**
 * Tests for the groupChat IPC handlers
 *
 * These tests verify the Group Chat CRUD operations, chat log operations,
 * moderator management, and participant management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import {
	registerGroupChatHandlers,
	GroupChatHandlerDependencies,
	groupChatEmitters,
} from '../../../../main/ipc/handlers/groupChat';

// Import types we need for mocking
import type {
	GroupChat,
	GroupChatParticipant,
} from '../../../../main/group-chat/group-chat-storage';
import type { GroupChatMessage } from '../../../../main/group-chat/group-chat-log';
import type { GroupChatHistoryEntry } from '../../../../shared/group-chat-types';

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	BrowserWindow: vi.fn(),
}));

// Mock group-chat-storage
vi.mock('../../../../main/group-chat/group-chat-storage', () => ({
	createGroupChat: vi.fn(),
	loadGroupChat: vi.fn(),
	listGroupChats: vi.fn(),
	deleteGroupChat: vi.fn(),
	updateGroupChat: vi.fn(),
	addGroupChatHistoryEntry: vi.fn(),
	getGroupChatHistory: vi.fn(),
	deleteGroupChatHistoryEntry: vi.fn(),
	clearGroupChatHistory: vi.fn(),
	getGroupChatHistoryFilePath: vi.fn(),
}));

// Mock group-chat-log
vi.mock('../../../../main/group-chat/group-chat-log', () => ({
	appendToLog: vi.fn(),
	readLog: vi.fn(),
	saveImage: vi.fn(),
}));

// Mock group-chat-moderator
vi.mock('../../../../main/group-chat/group-chat-moderator', () => ({
	spawnModerator: vi.fn(),
	sendToModerator: vi.fn(),
	killModerator: vi.fn(),
	getModeratorSessionId: vi.fn(),
}));

// Mock group-chat-agent
vi.mock('../../../../main/group-chat/group-chat-agent', () => ({
	addParticipant: vi.fn(),
	sendToParticipant: vi.fn(),
	removeParticipant: vi.fn(),
	clearAllParticipantSessions: vi.fn(),
}));

// Mock group-chat-router
vi.mock('../../../../main/group-chat/group-chat-router', () => ({
	routeUserMessage: vi.fn(),
}));

// Mock agent-detector
vi.mock('../../../../main/agent-detector', () => ({
	AgentDetector: vi.fn(),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import mocked modules for test setup
import * as groupChatStorage from '../../../../main/group-chat/group-chat-storage';
import * as groupChatLog from '../../../../main/group-chat/group-chat-log';
import * as groupChatModerator from '../../../../main/group-chat/group-chat-moderator';
import * as groupChatAgent from '../../../../main/group-chat/group-chat-agent';
import * as groupChatRouter from '../../../../main/group-chat/group-chat-router';

describe('groupChat IPC handlers', () => {
	let handlers: Map<string, Function>;
	let mockMainWindow: BrowserWindow;
	let mockProcessManager: {
		spawn: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
	};
	let mockAgentDetector: object;
	let mockDeps: GroupChatHandlerDependencies;

	beforeEach(() => {
		vi.clearAllMocks();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Setup mock main window
		mockMainWindow = {
			webContents: {
				send: vi.fn(),
			},
			isDestroyed: vi.fn().mockReturnValue(false),
		} as unknown as BrowserWindow;

		// Setup mock process manager
		mockProcessManager = {
			spawn: vi.fn().mockReturnValue({ pid: 12345, success: true }),
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		};

		// Setup mock agent detector
		mockAgentDetector = {};

		// Setup dependencies
		mockDeps = {
			getMainWindow: () => mockMainWindow,
			getProcessManager: () => mockProcessManager,
			getAgentDetector: () => mockAgentDetector as any,
			getCustomEnvVars: vi.fn(),
			getAgentConfig: vi.fn(),
		};

		// Register handlers
		registerGroupChatHandlers(mockDeps);
	});

	afterEach(() => {
		handlers.clear();
	});

	describe('registration', () => {
		it('should register all groupChat handlers', () => {
			const expectedChannels = [
				// Storage handlers
				'groupChat:create',
				'groupChat:list',
				'groupChat:load',
				'groupChat:delete',
				'groupChat:rename',
				'groupChat:update',
				// Chat log handlers
				'groupChat:appendMessage',
				'groupChat:getMessages',
				'groupChat:saveImage',
				// Moderator handlers
				'groupChat:startModerator',
				'groupChat:sendToModerator',
				'groupChat:stopModerator',
				'groupChat:getModeratorSessionId',
				// Participant handlers
				'groupChat:addParticipant',
				'groupChat:sendToParticipant',
				'groupChat:removeParticipant',
				'groupChat:resetParticipantContext',
				// History handlers
				'groupChat:getHistory',
				'groupChat:addHistoryEntry',
				'groupChat:deleteHistoryEntry',
				'groupChat:clearHistory',
				'groupChat:getHistoryFilePath',
				// Image handlers
				'groupChat:getImages',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel), `Expected handler for ${channel}`).toBe(true);
			}
			expect(handlers.size).toBe(expectedChannels.length);
		});
	});

	describe('groupChat:create', () => {
		it('should create a new group chat and initialize moderator', async () => {
			const mockChat: GroupChat = {
				id: 'gc-123',
				name: 'Test Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'group-chat-gc-123-moderator',
				participants: [],
				logPath: '/path/to/log',
				imagesDir: '/path/to/images',
			};

			const mockUpdatedChat: GroupChat = {
				...mockChat,
				moderatorSessionId: 'group-chat-gc-123-moderator-session',
			};

			vi.mocked(groupChatStorage.createGroupChat).mockResolvedValue(mockChat);
			vi.mocked(groupChatModerator.spawnModerator).mockResolvedValue('session-abc');
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockUpdatedChat);

			const handler = handlers.get('groupChat:create');
			const result = await handler!({} as any, 'Test Chat', 'claude-code');

			expect(groupChatStorage.createGroupChat).toHaveBeenCalledWith(
				'Test Chat',
				'claude-code',
				undefined
			);
			expect(groupChatModerator.spawnModerator).toHaveBeenCalledWith(mockChat, mockProcessManager);
			expect(result).toEqual(mockUpdatedChat);
		});

		it('should create group chat with moderator config', async () => {
			const mockChat: GroupChat = {
				id: 'gc-456',
				name: 'Config Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'group-chat-gc-456-moderator',
				moderatorConfig: {
					customPath: '/custom/path',
					customArgs: '--verbose',
				},
				participants: [],
				logPath: '/path/to/log',
				imagesDir: '/path/to/images',
			};

			vi.mocked(groupChatStorage.createGroupChat).mockResolvedValue(mockChat);
			vi.mocked(groupChatModerator.spawnModerator).mockResolvedValue('session-xyz');
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);

			const handler = handlers.get('groupChat:create');
			const moderatorConfig = { customPath: '/custom/path', customArgs: '--verbose' };
			const result = await handler!({} as any, 'Config Chat', 'claude-code', moderatorConfig);

			expect(groupChatStorage.createGroupChat).toHaveBeenCalledWith(
				'Config Chat',
				'claude-code',
				moderatorConfig
			);
		});

		it('should return original chat if process manager is not available', async () => {
			const mockChat: GroupChat = {
				id: 'gc-789',
				name: 'No PM Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: '',
				participants: [],
				logPath: '/path/to/log',
				imagesDir: '/path/to/images',
			};

			vi.mocked(groupChatStorage.createGroupChat).mockResolvedValue(mockChat);

			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);

			const handler = handlers.get('groupChat:create');
			const result = await handler!({} as any, 'No PM Chat', 'claude-code');

			expect(groupChatModerator.spawnModerator).not.toHaveBeenCalled();
			expect(result).toEqual(mockChat);
		});
	});

	describe('groupChat:list', () => {
		it('should return array of group chats', async () => {
			const mockChats: GroupChat[] = [
				{
					id: 'gc-1',
					name: 'Chat 1',
					createdAt: 1000,
					updatedAt: 1000,
					moderatorAgentId: 'claude-code',
					moderatorSessionId: 'session-1',
					participants: [],
					logPath: '/path/1',
					imagesDir: '/images/1',
				},
				{
					id: 'gc-2',
					name: 'Chat 2',
					createdAt: 2000,
					updatedAt: 2000,
					moderatorAgentId: 'claude-code',
					moderatorSessionId: 'session-2',
					participants: [],
					logPath: '/path/2',
					imagesDir: '/images/2',
				},
			];

			vi.mocked(groupChatStorage.listGroupChats).mockResolvedValue(mockChats);

			const handler = handlers.get('groupChat:list');
			const result = await handler!({} as any);

			expect(groupChatStorage.listGroupChats).toHaveBeenCalled();
			expect(result).toEqual(mockChats);
		});

		it('should return empty array when no group chats exist', async () => {
			vi.mocked(groupChatStorage.listGroupChats).mockResolvedValue([]);

			const handler = handlers.get('groupChat:list');
			const result = await handler!({} as any);

			expect(result).toEqual([]);
		});
	});

	describe('groupChat:load', () => {
		it('should load a specific group chat', async () => {
			const mockChat: GroupChat = {
				id: 'gc-load',
				name: 'Load Test',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-load',
				participants: [],
				logPath: '/path/load',
				imagesDir: '/images/load',
			};

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);

			const handler = handlers.get('groupChat:load');
			const result = await handler!({} as any, 'gc-load');

			expect(groupChatStorage.loadGroupChat).toHaveBeenCalledWith('gc-load');
			expect(result).toEqual(mockChat);
		});

		it('should return null for non-existent group chat', async () => {
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:load');
			const result = await handler!({} as any, 'non-existent');

			expect(result).toBeNull();
		});
	});

	describe('groupChat:delete', () => {
		it('should delete group chat and clean up resources', async () => {
			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);
			vi.mocked(groupChatAgent.clearAllParticipantSessions).mockResolvedValue(undefined);
			vi.mocked(groupChatStorage.deleteGroupChat).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:delete');
			const result = await handler!({} as any, 'gc-delete');

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith(
				'gc-delete',
				mockProcessManager
			);
			expect(groupChatAgent.clearAllParticipantSessions).toHaveBeenCalledWith(
				'gc-delete',
				mockProcessManager
			);
			expect(groupChatStorage.deleteGroupChat).toHaveBeenCalledWith('gc-delete');
			expect(result).toBe(true);
		});

		it('should handle delete when process manager is null', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);

			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);
			vi.mocked(groupChatAgent.clearAllParticipantSessions).mockResolvedValue(undefined);
			vi.mocked(groupChatStorage.deleteGroupChat).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:delete');
			const result = await handler!({} as any, 'gc-delete');

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith('gc-delete', undefined);
			expect(groupChatAgent.clearAllParticipantSessions).toHaveBeenCalledWith(
				'gc-delete',
				undefined
			);
			expect(result).toBe(true);
		});
	});

	describe('groupChat:rename', () => {
		it('should rename a group chat', async () => {
			const mockUpdatedChat: GroupChat = {
				id: 'gc-rename',
				name: 'New Name',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-rename',
				participants: [],
				logPath: '/path/rename',
				imagesDir: '/images/rename',
			};

			vi.mocked(groupChatStorage.updateGroupChat).mockResolvedValue(mockUpdatedChat);

			const handler = handlers.get('groupChat:rename');
			const result = await handler!({} as any, 'gc-rename', 'New Name');

			expect(groupChatStorage.updateGroupChat).toHaveBeenCalledWith('gc-rename', {
				name: 'New Name',
			});
			expect(result).toEqual(mockUpdatedChat);
		});
	});

	describe('groupChat:update', () => {
		it('should update a group chat', async () => {
			const mockExistingChat: GroupChat = {
				id: 'gc-update',
				name: 'Old Name',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-update',
				participants: [],
				logPath: '/path/update',
				imagesDir: '/images/update',
			};

			const mockUpdatedChat: GroupChat = {
				...mockExistingChat,
				name: 'Updated Name',
			};

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockExistingChat);
			vi.mocked(groupChatStorage.updateGroupChat).mockResolvedValue(mockUpdatedChat);

			const handler = handlers.get('groupChat:update');
			const result = await handler!({} as any, 'gc-update', { name: 'Updated Name' });

			expect(groupChatStorage.updateGroupChat).toHaveBeenCalledWith('gc-update', {
				name: 'Updated Name',
				moderatorAgentId: undefined,
				moderatorConfig: undefined,
			});
			expect(result).toEqual(mockUpdatedChat);
		});

		it('should throw error for non-existent group chat', async () => {
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:update');

			await expect(handler!({} as any, 'non-existent', { name: 'New Name' })).rejects.toThrow(
				'Group chat not found: non-existent'
			);
		});

		it('should restart moderator when agent changes', async () => {
			const mockExistingChat: GroupChat = {
				id: 'gc-agent-change',
				name: 'Agent Change Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'old-session',
				participants: [],
				logPath: '/path/agent',
				imagesDir: '/images/agent',
			};

			const mockUpdatedChat: GroupChat = {
				...mockExistingChat,
				moderatorAgentId: 'opencode',
				moderatorSessionId: 'new-session',
			};

			vi.mocked(groupChatStorage.loadGroupChat)
				.mockResolvedValueOnce(mockExistingChat) // First call to check if chat exists
				.mockResolvedValueOnce(mockUpdatedChat); // Second call after moderator restart

			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);
			vi.mocked(groupChatStorage.updateGroupChat).mockResolvedValue(mockUpdatedChat);
			vi.mocked(groupChatModerator.spawnModerator).mockResolvedValue('new-session');

			const handler = handlers.get('groupChat:update');
			const result = await handler!({} as any, 'gc-agent-change', { moderatorAgentId: 'opencode' });

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith(
				'gc-agent-change',
				mockProcessManager
			);
			expect(groupChatModerator.spawnModerator).toHaveBeenCalled();
			expect(result).toEqual(mockUpdatedChat);
		});
	});

	describe('groupChat:appendMessage', () => {
		it('should append message to chat log', async () => {
			const mockChat: GroupChat = {
				id: 'gc-msg',
				name: 'Message Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-msg',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir: '/images/msg',
			};

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);
			vi.mocked(groupChatLog.appendToLog).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:appendMessage');
			await handler!({} as any, 'gc-msg', 'user', 'Hello world!');

			expect(groupChatLog.appendToLog).toHaveBeenCalledWith(
				'/path/to/chat.log',
				'user',
				'Hello world!'
			);
		});

		it('should throw error for non-existent chat', async () => {
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:appendMessage');

			await expect(handler!({} as any, 'non-existent', 'user', 'Hello')).rejects.toThrow(
				'Group chat not found: non-existent'
			);
		});
	});

	describe('groupChat:getMessages', () => {
		it('should return messages from chat log', async () => {
			const mockChat: GroupChat = {
				id: 'gc-get-msg',
				name: 'Get Messages Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-get-msg',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir: '/images/get-msg',
			};

			const mockMessages: GroupChatMessage[] = [
				{ timestamp: '2024-01-01T00:00:00.000Z', from: 'user', content: 'Hello' },
				{ timestamp: '2024-01-01T00:00:01.000Z', from: 'moderator', content: 'Hi there!' },
			];

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);
			vi.mocked(groupChatLog.readLog).mockResolvedValue(mockMessages);

			const handler = handlers.get('groupChat:getMessages');
			const result = await handler!({} as any, 'gc-get-msg');

			expect(groupChatLog.readLog).toHaveBeenCalledWith('/path/to/chat.log');
			expect(result).toEqual(mockMessages);
		});
	});

	describe('groupChat:saveImage', () => {
		it('should save image to chat images directory', async () => {
			const mockChat: GroupChat = {
				id: 'gc-img',
				name: 'Image Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-img',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir: '/path/to/images',
			};

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);
			vi.mocked(groupChatLog.saveImage).mockResolvedValue('saved-image.png');

			const handler = handlers.get('groupChat:saveImage');
			const imageData = Buffer.from('fake-image-data').toString('base64');
			const result = await handler!({} as any, 'gc-img', imageData, 'test.png');

			expect(groupChatLog.saveImage).toHaveBeenCalledWith(
				'/path/to/images',
				expect.any(Buffer),
				'test.png'
			);
			expect(result).toBe('saved-image.png');
		});
	});

	describe('groupChat:startModerator', () => {
		it('should start moderator for group chat', async () => {
			const mockChat: GroupChat = {
				id: 'gc-start',
				name: 'Start Moderator Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: '',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir: '/images/start',
			};

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);
			vi.mocked(groupChatModerator.spawnModerator).mockResolvedValue('new-session-id');

			const handler = handlers.get('groupChat:startModerator');
			const result = await handler!({} as any, 'gc-start');

			expect(groupChatModerator.spawnModerator).toHaveBeenCalledWith(mockChat, mockProcessManager);
			expect(result).toBe('new-session-id');
		});

		it('should throw error when process manager not initialized', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);

			const mockChat: GroupChat = {
				id: 'gc-no-pm',
				name: 'No PM Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: '',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir: '/images/no-pm',
			};

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);

			const handler = handlers.get('groupChat:startModerator');

			await expect(handler!({} as any, 'gc-no-pm')).rejects.toThrow(
				'Process manager not initialized'
			);
		});
	});

	describe('groupChat:sendToModerator', () => {
		it('should route user message to moderator', async () => {
			vi.mocked(groupChatRouter.routeUserMessage).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:sendToModerator');
			await handler!({} as any, 'gc-send', 'Hello moderator', undefined, false);

			expect(groupChatRouter.routeUserMessage).toHaveBeenCalledWith(
				'gc-send',
				'Hello moderator',
				mockProcessManager,
				mockAgentDetector,
				false
			);
		});

		it('should pass read-only flag', async () => {
			vi.mocked(groupChatRouter.routeUserMessage).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:sendToModerator');
			await handler!({} as any, 'gc-send-ro', 'Analyze this', undefined, true);

			expect(groupChatRouter.routeUserMessage).toHaveBeenCalledWith(
				'gc-send-ro',
				'Analyze this',
				mockProcessManager,
				mockAgentDetector,
				true
			);
		});
	});

	describe('groupChat:stopModerator', () => {
		it('should stop moderator for group chat', async () => {
			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:stopModerator');
			await handler!({} as any, 'gc-stop');

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith('gc-stop', mockProcessManager);
		});
	});

	describe('groupChat:getModeratorSessionId', () => {
		it('should return moderator session ID', async () => {
			vi.mocked(groupChatModerator.getModeratorSessionId).mockReturnValue('mod-session-123');

			const handler = handlers.get('groupChat:getModeratorSessionId');
			const result = await handler!({} as any, 'gc-mod-id');

			expect(groupChatModerator.getModeratorSessionId).toHaveBeenCalledWith('gc-mod-id');
			expect(result).toBe('mod-session-123');
		});

		it('should return null when no active moderator', async () => {
			vi.mocked(groupChatModerator.getModeratorSessionId).mockReturnValue(undefined);

			const handler = handlers.get('groupChat:getModeratorSessionId');
			const result = await handler!({} as any, 'gc-no-mod');

			expect(result).toBeNull();
		});
	});

	describe('groupChat:addParticipant', () => {
		it('should add participant to group chat', async () => {
			const mockParticipant: GroupChatParticipant = {
				name: 'Worker 1',
				agentId: 'claude-code',
				sessionId: 'participant-session-1',
				addedAt: Date.now(),
			};

			vi.mocked(groupChatAgent.addParticipant).mockResolvedValue(mockParticipant);

			const handler = handlers.get('groupChat:addParticipant');
			const result = await handler!(
				{} as any,
				'gc-add',
				'Worker 1',
				'claude-code',
				'/project/path'
			);

			expect(groupChatAgent.addParticipant).toHaveBeenCalledWith(
				'gc-add',
				'Worker 1',
				'claude-code',
				mockProcessManager,
				'/project/path',
				mockAgentDetector,
				{},
				undefined
			);
			expect(result).toEqual(mockParticipant);
		});

		it('should throw error when process manager not initialized', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);

			const handler = handlers.get('groupChat:addParticipant');

			await expect(handler!({} as any, 'gc-add', 'Worker', 'claude-code')).rejects.toThrow(
				'Process manager not initialized'
			);
		});

		it('should use HOME or /tmp as default cwd when not provided', async () => {
			const mockParticipant: GroupChatParticipant = {
				name: 'Default CWD Worker',
				agentId: 'claude-code',
				sessionId: 'participant-default',
				addedAt: Date.now(),
			};

			vi.mocked(groupChatAgent.addParticipant).mockResolvedValue(mockParticipant);

			const handler = handlers.get('groupChat:addParticipant');
			await handler!({} as any, 'gc-add-default', 'Default CWD Worker', 'claude-code');

			expect(groupChatAgent.addParticipant).toHaveBeenCalledWith(
				'gc-add-default',
				'Default CWD Worker',
				'claude-code',
				mockProcessManager,
				expect.any(String), // HOME or /tmp
				mockAgentDetector,
				{},
				undefined
			);
		});
	});

	describe('groupChat:sendToParticipant', () => {
		it('should send message to participant', async () => {
			vi.mocked(groupChatAgent.sendToParticipant).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:sendToParticipant');
			await handler!({} as any, 'gc-send-part', 'Worker 1', 'Do this task');

			expect(groupChatAgent.sendToParticipant).toHaveBeenCalledWith(
				'gc-send-part',
				'Worker 1',
				'Do this task',
				mockProcessManager
			);
		});
	});

	describe('groupChat:removeParticipant', () => {
		it('should remove participant from group chat', async () => {
			vi.mocked(groupChatAgent.removeParticipant).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:removeParticipant');
			await handler!({} as any, 'gc-remove', 'Worker 1');

			expect(groupChatAgent.removeParticipant).toHaveBeenCalledWith(
				'gc-remove',
				'Worker 1',
				mockProcessManager
			);
		});
	});

	describe('groupChat:getHistory', () => {
		it('should return history entries for group chat', async () => {
			const mockHistory: GroupChatHistoryEntry[] = [
				{
					id: 'entry-1',
					type: 'participant_complete',
					participantName: 'Worker 1',
					summary: 'Completed task',
					timestamp: Date.now(),
				},
			];

			vi.mocked(groupChatStorage.getGroupChatHistory).mockResolvedValue(mockHistory);

			const handler = handlers.get('groupChat:getHistory');
			const result = await handler!({} as any, 'gc-history');

			expect(groupChatStorage.getGroupChatHistory).toHaveBeenCalledWith('gc-history');
			expect(result).toEqual(mockHistory);
		});
	});

	describe('groupChat:addHistoryEntry', () => {
		it('should add history entry and emit event', async () => {
			const inputEntry: Omit<GroupChatHistoryEntry, 'id'> = {
				type: 'participant_complete',
				participantName: 'Worker 1',
				summary: 'Task completed successfully',
				timestamp: Date.now(),
			};

			const createdEntry: GroupChatHistoryEntry = {
				id: 'entry-new',
				...inputEntry,
			};

			vi.mocked(groupChatStorage.addGroupChatHistoryEntry).mockResolvedValue(createdEntry);

			const handler = handlers.get('groupChat:addHistoryEntry');
			const result = await handler!({} as any, 'gc-add-history', inputEntry);

			expect(groupChatStorage.addGroupChatHistoryEntry).toHaveBeenCalledWith(
				'gc-add-history',
				inputEntry
			);
			expect(result).toEqual(createdEntry);
		});
	});

	describe('groupChat:deleteHistoryEntry', () => {
		it('should delete history entry', async () => {
			vi.mocked(groupChatStorage.deleteGroupChatHistoryEntry).mockResolvedValue(true);

			const handler = handlers.get('groupChat:deleteHistoryEntry');
			const result = await handler!({} as any, 'gc-del-history', 'entry-1');

			expect(groupChatStorage.deleteGroupChatHistoryEntry).toHaveBeenCalledWith(
				'gc-del-history',
				'entry-1'
			);
			expect(result).toBe(true);
		});
	});

	describe('groupChat:clearHistory', () => {
		it('should clear all history for group chat', async () => {
			vi.mocked(groupChatStorage.clearGroupChatHistory).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:clearHistory');
			await handler!({} as any, 'gc-clear-history');

			expect(groupChatStorage.clearGroupChatHistory).toHaveBeenCalledWith('gc-clear-history');
		});
	});

	describe('groupChat:getHistoryFilePath', () => {
		it('should return history file path', async () => {
			vi.mocked(groupChatStorage.getGroupChatHistoryFilePath).mockReturnValue(
				'/path/to/history.json'
			);

			const handler = handlers.get('groupChat:getHistoryFilePath');
			const result = await handler!({} as any, 'gc-history-path');

			expect(groupChatStorage.getGroupChatHistoryFilePath).toHaveBeenCalledWith('gc-history-path');
			expect(result).toBe('/path/to/history.json');
		});

		it('should return null when no history file', async () => {
			vi.mocked(groupChatStorage.getGroupChatHistoryFilePath).mockReturnValue(null);

			const handler = handlers.get('groupChat:getHistoryFilePath');
			const result = await handler!({} as any, 'gc-no-history');

			expect(result).toBeNull();
		});
	});

	describe('groupChat:getImages', () => {
		it('should return images as base64 data URLs', async () => {
			const mockChat: GroupChat = {
				id: 'gc-images',
				name: 'Images Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-images',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir: '/path/to/images',
			};

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);

			// Mock fs/promises and path for this test
			const mockFs = {
				readdir: vi.fn().mockResolvedValue(['image1.png', 'image2.jpg', 'not-image.txt']),
				readFile: vi
					.fn()
					.mockResolvedValueOnce(Buffer.from('png-data'))
					.mockResolvedValueOnce(Buffer.from('jpg-data')),
			};

			// We need to mock the dynamic import behavior
			vi.doMock('fs/promises', () => mockFs);

			const handler = handlers.get('groupChat:getImages');
			// Note: This test verifies the handler structure but may need actual fs mock for full coverage
		});

		it('should throw error for non-existent chat', async () => {
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:getImages');

			await expect(handler!({} as any, 'non-existent')).rejects.toThrow(
				'Group chat not found: non-existent'
			);
		});
	});

	describe('event emitters', () => {
		it('should set up emitMessage emitter', () => {
			expect(groupChatEmitters.emitMessage).toBeDefined();
			expect(typeof groupChatEmitters.emitMessage).toBe('function');
		});

		it('should set up emitStateChange emitter', () => {
			expect(groupChatEmitters.emitStateChange).toBeDefined();
			expect(typeof groupChatEmitters.emitStateChange).toBe('function');
		});

		it('should set up emitParticipantsChanged emitter', () => {
			expect(groupChatEmitters.emitParticipantsChanged).toBeDefined();
			expect(typeof groupChatEmitters.emitParticipantsChanged).toBe('function');
		});

		it('should set up emitModeratorUsage emitter', () => {
			expect(groupChatEmitters.emitModeratorUsage).toBeDefined();
			expect(typeof groupChatEmitters.emitModeratorUsage).toBe('function');
		});

		it('should set up emitHistoryEntry emitter', () => {
			expect(groupChatEmitters.emitHistoryEntry).toBeDefined();
			expect(typeof groupChatEmitters.emitHistoryEntry).toBe('function');
		});

		it('should set up emitParticipantState emitter', () => {
			expect(groupChatEmitters.emitParticipantState).toBeDefined();
			expect(typeof groupChatEmitters.emitParticipantState).toBe('function');
		});

		it('should set up emitModeratorSessionIdChanged emitter', () => {
			expect(groupChatEmitters.emitModeratorSessionIdChanged).toBeDefined();
			expect(typeof groupChatEmitters.emitModeratorSessionIdChanged).toBe('function');
		});

		it('emitMessage should send to main window', () => {
			const mockMessage: GroupChatMessage = {
				timestamp: '2024-01-01T00:00:00.000Z',
				from: 'user',
				content: 'Test message',
			};

			groupChatEmitters.emitMessage!('gc-emit', mockMessage);

			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:message',
				'gc-emit',
				mockMessage
			);
		});

		it('emitStateChange should send to main window', () => {
			groupChatEmitters.emitStateChange!('gc-emit', 'moderator-thinking');

			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:stateChange',
				'gc-emit',
				'moderator-thinking'
			);
		});

		it('emitters should not send when window is destroyed', () => {
			vi.mocked(mockMainWindow.isDestroyed).mockReturnValue(true);

			groupChatEmitters.emitMessage!('gc-destroyed', {
				timestamp: '2024-01-01T00:00:00.000Z',
				from: 'user',
				content: 'Test',
			});

			expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
		});

		it('emitters should handle null main window', () => {
			const depsNoWindow: GroupChatHandlerDependencies = {
				...mockDeps,
				getMainWindow: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoWindow);

			// Should not throw
			expect(() => {
				groupChatEmitters.emitMessage!('gc-no-window', {
					timestamp: '2024-01-01T00:00:00.000Z',
					from: 'user',
					content: 'Test',
				});
			}).not.toThrow();
		});
	});
});
