/**
 * Tests for the groupChat IPC handlers
 *
 * These tests verify the Group Chat CRUD operations, chat log operations,
 * moderator management, and participant management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, BrowserWindow } from 'electron';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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
	updateParticipant: vi.fn(),
	addGroupChatHistoryEntry: vi.fn(),
	getGroupChatHistory: vi.fn(),
	deleteGroupChatHistoryEntry: vi.fn(),
	clearGroupChatHistory: vi.fn(),
	getGroupChatHistoryFilePath: vi.fn(),
	getGroupChatDir: vi.fn(),
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
	clearPendingParticipants: vi.fn(),
	routeAgentResponse: vi.fn(),
	markParticipantResponded: vi.fn(),
	spawnModeratorSynthesis: vi.fn(),
}));

// Mock agent-detector
vi.mock('../../../../main/agent-detector', () => ({
	AgentDetector: vi.fn(),
}));

vi.mock('../../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
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
import { groomContext } from '../../../../main/utils/context-groomer';
import { logger } from '../../../../main/utils/logger';

async function withSuppressedGroupChatConsole(fn: () => Promise<void>): Promise<void> {
	const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
	const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	try {
		await fn();
	} finally {
		consoleLog.mockRestore();
		consoleWarn.mockRestore();
	}
}

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
				isDestroyed: vi.fn().mockReturnValue(false),
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
				'groupChat:archive',
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
				'groupChat:stopAll',
				'groupChat:reportAutoRunComplete',
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

		it('should return original chat when initialization reload misses the chat', async () => {
			const mockChat: GroupChat = {
				id: 'gc-reload-missing',
				name: 'Reload Missing Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				participants: [],
				logPath: '/path/to/log',
				imagesDir: '/path/to/images',
			};

			vi.mocked(groupChatStorage.createGroupChat).mockResolvedValue(mockChat);
			vi.mocked(groupChatModerator.spawnModerator).mockResolvedValue('session-missing');
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:create');
			const result = await handler!({} as any, 'Reload Missing Chat', 'claude-code');

			expect(groupChatModerator.spawnModerator).toHaveBeenCalledWith(mockChat, mockProcessManager);
			expect(groupChatStorage.loadGroupChat).toHaveBeenCalledWith('gc-reload-missing');
			expect(result).toEqual(mockChat);
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

	describe('groupChat:archive', () => {
		it('should stop active sessions before archiving a group chat', async () => {
			const mockUpdatedChat: GroupChat = {
				id: 'gc-archive',
				name: 'Archive Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-archive',
				participants: [],
				logPath: '/path/archive',
				imagesDir: '/images/archive',
				archived: true,
			};

			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);
			vi.mocked(groupChatAgent.clearAllParticipantSessions).mockResolvedValue(undefined);
			vi.mocked(groupChatStorage.updateGroupChat).mockResolvedValue(mockUpdatedChat);

			const handler = handlers.get('groupChat:archive');
			const result = await handler!({} as any, 'gc-archive', true);

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith(
				'gc-archive',
				mockProcessManager
			);
			expect(groupChatAgent.clearAllParticipantSessions).toHaveBeenCalledWith(
				'gc-archive',
				mockProcessManager
			);
			expect(groupChatStorage.updateGroupChat).toHaveBeenCalledWith('gc-archive', {
				archived: true,
			});
			expect(result).toEqual(mockUpdatedChat);
		});

		it('should unarchive without stopping inactive sessions', async () => {
			const mockUpdatedChat: GroupChat = {
				id: 'gc-unarchive',
				name: 'Unarchive Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-unarchive',
				participants: [],
				logPath: '/path/unarchive',
				imagesDir: '/images/unarchive',
				archived: false,
			};

			vi.mocked(groupChatStorage.updateGroupChat).mockResolvedValue(mockUpdatedChat);

			const handler = handlers.get('groupChat:archive');
			const result = await handler!({} as any, 'gc-unarchive', false);

			expect(groupChatModerator.killModerator).not.toHaveBeenCalled();
			expect(groupChatAgent.clearAllParticipantSessions).not.toHaveBeenCalled();
			expect(groupChatStorage.updateGroupChat).toHaveBeenCalledWith('gc-unarchive', {
				archived: false,
			});
			expect(result).toEqual(mockUpdatedChat);
		});

		it('should archive with undefined runtime cleanup when process manager is unavailable', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};
			const mockUpdatedChat: GroupChat = {
				id: 'gc-archive-no-pm',
				name: 'Archive No PM Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				participants: [],
				logPath: '/path/to/log',
				imagesDir: '/path/to/images',
				archived: true,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);
			vi.mocked(groupChatStorage.updateGroupChat).mockResolvedValue(mockUpdatedChat);

			const handler = handlers.get('groupChat:archive');
			const result = await handler!({} as any, 'gc-archive-no-pm', true);

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith('gc-archive-no-pm', undefined);
			expect(groupChatAgent.clearAllParticipantSessions).toHaveBeenCalledWith(
				'gc-archive-no-pm',
				undefined
			);
			expect(result).toEqual(mockUpdatedChat);
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

		it('should return updated chat when moderator restart reload finds no chat', async () => {
			const mockExistingChat: GroupChat = {
				id: 'gc-reload-null',
				name: 'Reload Null Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				participants: [],
				logPath: '/path/to/log',
				imagesDir: '/path/to/images',
			};
			const mockUpdatedChat: GroupChat = {
				...mockExistingChat,
				moderatorAgentId: 'opencode',
			};

			vi.mocked(groupChatStorage.loadGroupChat)
				.mockResolvedValueOnce(mockExistingChat)
				.mockResolvedValueOnce(null);
			vi.mocked(groupChatStorage.updateGroupChat).mockResolvedValue(mockUpdatedChat);
			vi.mocked(groupChatModerator.spawnModerator).mockResolvedValue('new-session');

			const handler = handlers.get('groupChat:update');
			const result = await handler!({} as any, 'gc-reload-null', {
				moderatorAgentId: 'opencode',
			});

			expect(groupChatModerator.spawnModerator).toHaveBeenCalledWith(
				mockUpdatedChat,
				mockProcessManager
			);
			expect(result).toEqual(mockUpdatedChat);
		});

		it('should update changed moderator without restarting when process manager is unavailable', async () => {
			const mockExistingChat: GroupChat = {
				id: 'gc-agent-change-no-pm',
				name: 'Agent Change No PM Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				participants: [],
				logPath: '/path/to/log',
				imagesDir: '/path/to/images',
			};
			const mockUpdatedChat: GroupChat = {
				...mockExistingChat,
				moderatorAgentId: 'opencode',
			};
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockExistingChat);
			vi.mocked(groupChatStorage.updateGroupChat).mockResolvedValue(mockUpdatedChat);

			const handler = handlers.get('groupChat:update');
			const result = await handler!({} as any, 'gc-agent-change-no-pm', {
				moderatorAgentId: 'opencode',
			});

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith(
				'gc-agent-change-no-pm',
				undefined
			);
			expect(groupChatModerator.spawnModerator).not.toHaveBeenCalled();
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

		it('should throw error for non-existent chat', async () => {
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:getMessages');

			await expect(handler!({} as any, 'non-existent')).rejects.toThrow(
				'Group chat not found: non-existent'
			);
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

		it('should throw error for non-existent chat', async () => {
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:saveImage');

			await expect(handler!({} as any, 'non-existent', 'ZmFrZQ==', 'image.png')).rejects.toThrow(
				'Group chat not found: non-existent'
			);
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

		it('should throw error for non-existent group chat', async () => {
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:startModerator');

			await expect(handler!({} as any, 'missing-chat')).rejects.toThrow(
				'Group chat not found: missing-chat'
			);
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
			await withSuppressedGroupChatConsole(async () => {
				await handler!({} as any, 'gc-send', 'Hello moderator', undefined, false);
			});

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
			await withSuppressedGroupChatConsole(async () => {
				await handler!({} as any, 'gc-send-ro', 'Analyze this', undefined, true);
			});

			expect(groupChatRouter.routeUserMessage).toHaveBeenCalledWith(
				'gc-send-ro',
				'Analyze this',
				mockProcessManager,
				mockAgentDetector,
				true
			);
		});

		it('should route long messages without runtime dependencies or read-only flag', async () => {
			const depsNoRuntime: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
				getAgentDetector: () => null,
			};
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const longMessage = 'x'.repeat(205);

			try {
				handlers.clear();
				registerGroupChatHandlers(depsNoRuntime);
				vi.mocked(groupChatRouter.routeUserMessage).mockResolvedValue(undefined);

				const handler = handlers.get('groupChat:sendToModerator');
				await handler!({} as any, 'gc-long', longMessage);

				expect(groupChatRouter.routeUserMessage).toHaveBeenCalledWith(
					'gc-long',
					longMessage,
					undefined,
					undefined,
					undefined
				);
				expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('...'));
				expect(logger.debug).toHaveBeenCalledWith(
					'Sent message to moderator in gc-long',
					'[GroupChat]',
					expect.objectContaining({
						messageLength: 205,
						imageCount: 0,
						readOnly: false,
					})
				);
			} finally {
				consoleLog.mockRestore();
			}
		});
	});

	describe('groupChat:stopModerator', () => {
		it('should stop moderator for group chat', async () => {
			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:stopModerator');
			await handler!({} as any, 'gc-stop');

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith('gc-stop', mockProcessManager);
		});

		it('should stop moderator with undefined process manager when runtime is unavailable', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);
			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:stopModerator');
			await handler!({} as any, 'gc-stop-no-pm');

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith('gc-stop-no-pm', undefined);
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

		it('should add participant with undefined agent detector when unavailable', async () => {
			const mockParticipant: GroupChatParticipant = {
				name: 'No Detector Worker',
				agentId: 'claude-code',
				sessionId: 'participant-no-detector',
				addedAt: Date.now(),
			};
			const depsNoAgentDetector: GroupChatHandlerDependencies = {
				...mockDeps,
				getAgentDetector: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoAgentDetector);
			vi.mocked(groupChatAgent.addParticipant).mockResolvedValue(mockParticipant);

			const handler = handlers.get('groupChat:addParticipant');
			const result = await handler!(
				{} as any,
				'gc-add-no-detector',
				'No Detector Worker',
				'claude-code',
				'/project/path'
			);

			expect(groupChatAgent.addParticipant).toHaveBeenCalledWith(
				'gc-add-no-detector',
				'No Detector Worker',
				'claude-code',
				mockProcessManager,
				'/project/path',
				undefined,
				{},
				undefined
			);
			expect(result).toEqual(mockParticipant);
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

		it('should send message to participant with undefined process manager when runtime is unavailable', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);
			vi.mocked(groupChatAgent.sendToParticipant).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:sendToParticipant');
			await handler!({} as any, 'gc-send-part-no-pm', 'Worker 1', 'Do this task');

			expect(groupChatAgent.sendToParticipant).toHaveBeenCalledWith(
				'gc-send-part-no-pm',
				'Worker 1',
				'Do this task',
				undefined
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

		it('should remove participant with undefined process manager when runtime is unavailable', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);
			vi.mocked(groupChatAgent.removeParticipant).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:removeParticipant');
			await handler!({} as any, 'gc-remove-no-pm', 'Worker 1');

			expect(groupChatAgent.removeParticipant).toHaveBeenCalledWith(
				'gc-remove-no-pm',
				'Worker 1',
				undefined
			);
		});
	});

	describe('groupChat:resetParticipantContext', () => {
		const participant: GroupChatParticipant = {
			name: 'Worker 1',
			agentId: 'claude-code',
			sessionId: 'participant-session-1',
			agentSessionId: 'agent-session-old',
			addedAt: 1700000000000,
			contextUsage: 88,
		};

		function makeChat(overrides: Partial<GroupChat> = {}): GroupChat {
			return {
				id: 'gc-reset',
				name: 'Reset Chat',
				createdAt: 1700000000000,
				updatedAt: 1700000000000,
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'moderator-session',
				participants: [participant],
				logPath: '/path/reset/chat.log',
				imagesDir: '/path/reset/images',
				...overrides,
			};
		}

		it('should summarize current context, reset participant session, and notify renderers', async () => {
			const chat = makeChat();
			const updatedChat = makeChat({
				participants: [{ ...participant, agentSessionId: undefined, contextUsage: 0 }],
			});

			vi.mocked(groupChatStorage.loadGroupChat)
				.mockResolvedValueOnce(chat)
				.mockResolvedValueOnce(updatedChat);
			vi.mocked(groupChatStorage.getGroupChatDir).mockReturnValue('/group-chats/gc-reset');
			vi.mocked(groupChatStorage.updateParticipant).mockResolvedValue(updatedChat);
			vi.mocked(groomContext).mockResolvedValue({
				response: 'Summary of current work',
				durationMs: 1234,
				completionReason: 'process exited with code 0',
			});

			const handler = handlers.get('groupChat:resetParticipantContext');
			const result = await handler!({} as any, 'gc-reset', 'Worker 1', '/project/root');

			expect(groomContext).toHaveBeenCalledWith(
				expect.objectContaining({
					projectRoot: '/project/root',
					agentType: 'claude-code',
					agentSessionId: 'agent-session-old',
					readOnlyMode: true,
					timeoutMs: 60000,
				}),
				mockProcessManager,
				mockAgentDetector
			);
			expect(vi.mocked(groomContext).mock.calls[0][0].prompt).toContain(
				'The shared group chat folder is: /group-chats/gc-reset'
			);
			expect(groupChatStorage.updateParticipant).toHaveBeenCalledWith('gc-reset', 'Worker 1', {
				agentSessionId: undefined,
				contextUsage: 0,
			});
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:participantsChanged',
				'gc-reset',
				updatedChat.participants
			);
			expect(result.newAgentSessionId).toEqual(expect.any(String));
		});

		it('should reset participant context without emitting participants when reload returns null', async () => {
			const chat = makeChat();

			vi.mocked(groupChatStorage.loadGroupChat)
				.mockResolvedValueOnce(chat)
				.mockResolvedValueOnce(null);
			vi.mocked(groupChatStorage.getGroupChatDir).mockReturnValue('/group-chats/gc-reset');
			vi.mocked(groupChatStorage.updateParticipant).mockResolvedValue(chat);
			vi.mocked(groomContext).mockResolvedValue({
				response: 'Summary of current work',
				durationMs: 1234,
				completionReason: 'process exited with code 0',
			});

			const handler = handlers.get('groupChat:resetParticipantContext');
			const result = await handler!({} as any, 'gc-reset', 'Worker 1', '/project/root');

			expect(groupChatStorage.updateParticipant).toHaveBeenCalledWith('gc-reset', 'Worker 1', {
				agentSessionId: undefined,
				contextUsage: 0,
			});
			expect(mockMainWindow.webContents.send).not.toHaveBeenCalledWith(
				'groupChat:participantsChanged',
				expect.any(String),
				expect.any(Array)
			);
			expect(result.newAgentSessionId).toEqual(expect.any(String));
		});

		it('should still reset context when summary generation fails', async () => {
			const chat = makeChat();
			const updatedChat = makeChat({
				participants: [{ ...participant, agentSessionId: undefined, contextUsage: 0 }],
			});

			vi.mocked(groupChatStorage.loadGroupChat)
				.mockResolvedValueOnce(chat)
				.mockResolvedValueOnce(updatedChat);
			vi.mocked(groupChatStorage.getGroupChatDir).mockReturnValue('/group-chats/gc-reset');
			vi.mocked(groupChatStorage.updateParticipant).mockResolvedValue(updatedChat);
			vi.mocked(groomContext).mockRejectedValue(new Error('agent timed out'));

			const handler = handlers.get('groupChat:resetParticipantContext');
			const result = await handler!({} as any, 'gc-reset', 'Worker 1');

			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Summary generation failed for Worker 1'),
				'[GroupChat]'
			);
			expect(groupChatStorage.updateParticipant).toHaveBeenCalledWith('gc-reset', 'Worker 1', {
				agentSessionId: undefined,
				contextUsage: 0,
			});
			expect(result.newAgentSessionId).toEqual(expect.any(String));
		});

		it('should reject missing chats, participants, process managers, and agent detectors', async () => {
			const handler = handlers.get('groupChat:resetParticipantContext');

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValueOnce(null);
			await expect(handler!({} as any, 'missing-chat', 'Worker 1')).rejects.toThrow(
				'Group chat not found: missing-chat'
			);

			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValueOnce(
				makeChat({ participants: [] })
			);
			await expect(handler!({} as any, 'gc-reset', 'Missing Worker')).rejects.toThrow(
				'Participant not found: Missing Worker'
			);

			handlers.clear();
			registerGroupChatHandlers({
				...mockDeps,
				getProcessManager: () => null,
			});
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValueOnce(makeChat());
			await expect(
				handlers.get('groupChat:resetParticipantContext')!({} as any, 'gc-reset', 'Worker 1')
			).rejects.toThrow('Process manager not initialized');

			handlers.clear();
			registerGroupChatHandlers({
				...mockDeps,
				getAgentDetector: () => null,
			});
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValueOnce(makeChat());
			await expect(
				handlers.get('groupChat:resetParticipantContext')!({} as any, 'gc-reset', 'Worker 1')
			).rejects.toThrow('Agent detector not initialized');
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
			const tempRoot = await mkdtemp(join(tmpdir(), 'maestro-group-images-'));
			const imagesDir = join(tempRoot, 'images');
			await mkdir(imagesDir);

			const mockChat: GroupChat = {
				id: 'gc-images',
				name: 'Images Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-images',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir,
			};

			try {
				await writeFile(join(imagesDir, 'one.png'), 'png-data');
				await writeFile(join(imagesDir, 'two.jpg'), 'jpg-data');
				await writeFile(join(imagesDir, 'three.gif'), 'gif-data');
				await writeFile(join(imagesDir, 'four.webp'), 'webp-data');
				await writeFile(join(imagesDir, 'notes.txt'), 'not an image');
				vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);

				const handler = handlers.get('groupChat:getImages');
				const result = await handler!({} as any, 'gc-images');

				expect(result).toEqual({
					'one.png': `data:image/png;base64,${Buffer.from('png-data').toString('base64')}`,
					'two.jpg': `data:image/jpeg;base64,${Buffer.from('jpg-data').toString('base64')}`,
					'three.gif': `data:image/gif;base64,${Buffer.from('gif-data').toString('base64')}`,
					'four.webp': `data:image/webp;base64,${Buffer.from('webp-data').toString('base64')}`,
				});
			} finally {
				await rm(tempRoot, { recursive: true, force: true });
			}
		});

		it('should throw error for non-existent chat', async () => {
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:getImages');

			await expect(handler!({} as any, 'non-existent')).rejects.toThrow(
				'Group chat not found: non-existent'
			);
		});

		it('should return no images when the images directory is missing', async () => {
			const mockChat: GroupChat = {
				id: 'gc-missing-images',
				name: 'Missing Images Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-images',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir: join(tmpdir(), `missing-images-${Date.now()}`),
			};
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);

			const handler = handlers.get('groupChat:getImages');
			const result = await handler!({} as any, 'gc-missing-images');

			expect(result).toEqual({});
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('should warn and return no images when the images path cannot be read', async () => {
			const tempRoot = await mkdtemp(join(tmpdir(), 'maestro-group-image-error-'));
			const imagePath = join(tempRoot, 'not-a-directory');
			await writeFile(imagePath, 'not a directory');

			const mockChat: GroupChat = {
				id: 'gc-image-error',
				name: 'Image Error Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-images',
				participants: [],
				logPath: '/path/to/chat.log',
				imagesDir: imagePath,
			};

			try {
				vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);

				const handler = handlers.get('groupChat:getImages');
				const result = await handler!({} as any, 'gc-image-error');

				expect(result).toEqual({});
				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining('Error reading images directory:'),
					'[GroupChat]'
				);
			} finally {
				await rm(tempRoot, { recursive: true, force: true });
			}
		});
	});

	describe('groupChat:stopAll', () => {
		it('should kill moderator, clear participant sessions, and emit idle states', async () => {
			const mockChat: GroupChat = {
				id: 'gc-stop-all',
				name: 'Stop All Chat',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				moderatorAgentId: 'claude-code',
				moderatorSessionId: 'session-stop',
				participants: [
					{
						name: 'Worker 1',
						agentId: 'claude-code',
						sessionId: 'p-1',
						addedAt: Date.now(),
					},
					{
						name: 'Worker 2',
						agentId: 'claude-code',
						sessionId: 'p-2',
						addedAt: Date.now(),
					},
				],
				logPath: '/path/stop',
				imagesDir: '/images/stop',
			};

			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);
			vi.mocked(groupChatAgent.clearAllParticipantSessions).mockResolvedValue(undefined);
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(mockChat);

			const handler = handlers.get('groupChat:stopAll');
			await withSuppressedGroupChatConsole(async () => {
				await handler!({} as any, 'gc-stop-all');
			});

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith(
				'gc-stop-all',
				mockProcessManager
			);
			expect(groupChatAgent.clearAllParticipantSessions).toHaveBeenCalledWith(
				'gc-stop-all',
				mockProcessManager
			);
			expect(groupChatRouter.clearPendingParticipants).toHaveBeenCalledWith('gc-stop-all');
		});

		it('should handle null process manager', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);

			vi.mocked(groupChatModerator.killModerator).mockResolvedValue(undefined);
			vi.mocked(groupChatAgent.clearAllParticipantSessions).mockResolvedValue(undefined);
			vi.mocked(groupChatStorage.loadGroupChat).mockResolvedValue(null);

			const handler = handlers.get('groupChat:stopAll');
			await handler!({} as any, 'gc-stop-null');

			expect(groupChatModerator.killModerator).toHaveBeenCalledWith('gc-stop-null', undefined);
			expect(groupChatAgent.clearAllParticipantSessions).toHaveBeenCalledWith(
				'gc-stop-null',
				undefined
			);
		});
	});

	describe('groupChat:reportAutoRunComplete', () => {
		it('should route agent response and mark participant as responded', async () => {
			vi.mocked(groupChatRouter.routeAgentResponse).mockResolvedValue(undefined);
			vi.mocked(groupChatRouter.markParticipantResponded).mockReturnValue(false);

			const handler = handlers.get('groupChat:reportAutoRunComplete');
			await withSuppressedGroupChatConsole(async () => {
				await handler!({} as any, 'gc-autorun', 'Worker 1', 'Task completed successfully');
			});

			expect(groupChatRouter.routeAgentResponse).toHaveBeenCalledWith(
				'gc-autorun',
				'Worker 1',
				'Task completed successfully',
				mockProcessManager
			);
		});

		it('should trigger synthesis when all participants have responded', async () => {
			vi.mocked(groupChatRouter.routeAgentResponse).mockResolvedValue(undefined);
			vi.mocked(groupChatRouter.markParticipantResponded).mockReturnValue(true);
			vi.mocked(groupChatRouter.spawnModeratorSynthesis).mockResolvedValue(undefined);

			const handler = handlers.get('groupChat:reportAutoRunComplete');
			await withSuppressedGroupChatConsole(async () => {
				await handler!({} as any, 'gc-autorun-done', 'Worker 1', 'All done');
			});

			expect(groupChatRouter.routeAgentResponse).toHaveBeenCalled();
			expect(groupChatRouter.markParticipantResponded).toHaveBeenCalledWith(
				'gc-autorun-done',
				'Worker 1'
			);
			expect(groupChatRouter.spawnModeratorSynthesis).toHaveBeenCalledWith(
				'gc-autorun-done',
				mockProcessManager,
				mockAgentDetector
			);
		});

		it('should route autorun completion with undefined process manager when runtime is unavailable', async () => {
			const depsNoProcessManager: GroupChatHandlerDependencies = {
				...mockDeps,
				getProcessManager: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoProcessManager);
			vi.mocked(groupChatRouter.routeAgentResponse).mockResolvedValue(undefined);
			vi.mocked(groupChatRouter.markParticipantResponded).mockReturnValue(true);

			const handler = handlers.get('groupChat:reportAutoRunComplete');
			await withSuppressedGroupChatConsole(async () => {
				await handler!({} as any, 'gc-autorun-no-pm', 'Worker 1', 'All done without PM');
			});

			expect(groupChatRouter.routeAgentResponse).toHaveBeenCalledWith(
				'gc-autorun-no-pm',
				'Worker 1',
				'All done without PM',
				undefined
			);
			expect(groupChatRouter.spawnModeratorSynthesis).not.toHaveBeenCalled();
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

		it('should emit renderer events for group chat participants, usage, history, sessions, autorun, and live output', () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const participants: GroupChatParticipant[] = [
				{
					name: 'Worker 1',
					agentId: 'claude-code',
					sessionId: 'participant-session',
					addedAt: 1700000000000,
				},
			];
			const usage = { contextUsage: 75, totalCost: 1.23, tokenCount: 4567 };
			const historyEntry: GroupChatHistoryEntry = {
				id: 'history-1',
				type: 'participant_complete',
				participantName: 'Worker 1',
				summary: 'Finished the task',
				timestamp: 1700000000000,
			};

			try {
				groupChatEmitters.emitParticipantsChanged!('gc-emit', participants);
				groupChatEmitters.emitModeratorUsage!('gc-emit', usage);
				groupChatEmitters.emitHistoryEntry!('gc-emit', historyEntry);
				groupChatEmitters.emitParticipantState!('gc-emit', 'Worker 1', 'working');
				groupChatEmitters.emitModeratorSessionIdChanged!('gc-emit', 'moderator-session');
				groupChatEmitters.emitAutoRunTriggered!('gc-emit', 'Worker 1', 'plan.md');
				groupChatEmitters.emitAutoRunBatchComplete!('gc-emit', 'Worker 1');
				groupChatEmitters.emitParticipantLiveOutput!('gc-emit', 'Worker 1', 'stream chunk');
			} finally {
				consoleLog.mockRestore();
			}

			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:participantsChanged',
				'gc-emit',
				participants
			);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:moderatorUsage',
				'gc-emit',
				usage
			);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:historyEntry',
				'gc-emit',
				historyEntry
			);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:participantState',
				'gc-emit',
				'Worker 1',
				'working'
			);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:moderatorSessionIdChanged',
				'gc-emit',
				'moderator-session'
			);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:autoRunTriggered',
				'gc-emit',
				'Worker 1',
				'plan.md'
			);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:autoRunBatchComplete',
				'gc-emit',
				'Worker 1'
			);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith(
				'groupChat:participantLiveOutput',
				'gc-emit',
				'Worker 1',
				'stream chunk'
			);
		});

		it('should warn when participant state cannot be sent to the renderer', () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const depsNoWindow: GroupChatHandlerDependencies = {
				...mockDeps,
				getMainWindow: () => null,
			};

			handlers.clear();
			registerGroupChatHandlers(depsNoWindow);

			try {
				groupChatEmitters.emitParticipantState!('gc-no-window', 'Worker 1', 'idle');
				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
				expect(consoleWarn).toHaveBeenCalledWith(
					'[GroupChat:IPC] WARNING: mainWindow not available, cannot send participant state'
				);
			} finally {
				consoleLog.mockRestore();
				consoleWarn.mockRestore();
			}
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

		it('remaining emitters should not send when window is destroyed', () => {
			const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			const participants: GroupChatParticipant[] = [
				{
					name: 'Worker 1',
					agentId: 'claude-code',
					sessionId: 'participant-session',
					addedAt: Date.now(),
				},
			];
			const historyEntry: GroupChatHistoryEntry = {
				id: 'entry-destroyed',
				type: 'participant_complete',
				participantName: 'Worker 1',
				summary: 'Done',
				timestamp: Date.now(),
			};

			try {
				vi.mocked(mockMainWindow.isDestroyed).mockReturnValue(true);

				groupChatEmitters.emitStateChange!('gc-destroyed', 'idle');
				groupChatEmitters.emitParticipantsChanged!('gc-destroyed', participants);
				groupChatEmitters.emitModeratorUsage!('gc-destroyed', {
					contextUsage: 10,
					totalCost: 0.01,
					tokenCount: 20,
				});
				groupChatEmitters.emitHistoryEntry!('gc-destroyed', historyEntry);
				groupChatEmitters.emitParticipantState!('gc-destroyed', 'Worker 1', 'idle');
				groupChatEmitters.emitModeratorSessionIdChanged!('gc-destroyed', 'moderator-session');
				groupChatEmitters.emitAutoRunTriggered!('gc-destroyed', 'Worker 1', 'plan.md');
				groupChatEmitters.emitAutoRunBatchComplete!('gc-destroyed', 'Worker 1');
				groupChatEmitters.emitParticipantLiveOutput!('gc-destroyed', 'Worker 1', 'chunk');

				expect(mockMainWindow.webContents.send).not.toHaveBeenCalled();
			} finally {
				consoleLog.mockRestore();
				consoleWarn.mockRestore();
			}
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
