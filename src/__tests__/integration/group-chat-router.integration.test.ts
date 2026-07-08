/**
 * @file group-chat-router.test.ts
 * @description Unit tests for the Group Chat message router.
 *
 * Tests cover:
 * - Extracting @mentions (5.1, 5.2)
 * - Routing user messages (5.3)
 * - Routing moderator responses (5.4)
 * - Routing agent responses (5.5)
 * - Read-only mode propagation (5.6)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

// Mock Electron's app module before importing modules that use it
let mockUserDataPath: string;
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') {
				return mockUserDataPath;
			}
			throw new Error(`Unknown path name: ${name}`);
		}),
	},
}));

// Mock electron-store to return no custom path (use userData)
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			get() {
				return undefined;
			} // No custom sync path
			set() {}
		},
	};
});

vi.mock('../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => {
		const prompts: Record<string, string> = {
			'group-chat-moderator-system':
				'You are a Group Chat Moderator.\n\n{{CONDUCTOR_PROFILE}}\n\nAlways call out tradeoffs.\n\n{{PARTICIPANT_CONTEXT}}\n\n{{CHAT_HISTORY}}\n\n{{MESSAGE}}',
			'group-chat-moderator-synthesis':
				'You are reviewing responses from AI agents and synthesizing a coherent answer.\n\n{{CONDUCTOR_PROFILE}}\n\nSummarize decisions crisply.\n\n{{PARTICIPANT_CONTEXT}}\n\n{{CHAT_HISTORY}}\n\nDo NOT include any !autorun directives.',
			'group-chat-participant-request':
				'You are @{{PARTICIPANT_NAME}} in {{GROUP_CHAT_NAME}}{{READ_ONLY_LABEL}}.\n\n{{READ_ONLY_NOTE}}\n\nGroup chat folder: {{GROUP_CHAT_FOLDER}}\n\n{{HISTORY_CONTEXT}}\n\n{{MESSAGE}}\n\n{{READ_ONLY_INSTRUCTION}}',
			'group-chat-participant-continuation':
				'Continue as @{{PARTICIPANT_NAME}} in {{GROUP_CHAT_NAME}}{{READ_ONLY_LABEL}}.\n\n{{HISTORY_CONTEXT}}\n\n{{MESSAGE}}\n\n{{READ_ONLY_INSTRUCTION}}',
		};
		return prompts[id] ?? `mock prompt for ${id}`;
	}),
}));

const mockFsPromiseFaults = vi.hoisted(() => ({
	appendFile: undefined as undefined | ((file: unknown) => Error | undefined),
	rename: undefined as undefined | ((oldPath: unknown, newPath: unknown) => Error | undefined),
}));

vi.mock('fs/promises', async () => {
	const actual = await import('node:fs/promises');
	return {
		mkdir: actual.mkdir,
		rm: actual.rm,
		readFile: actual.readFile,
		writeFile: actual.writeFile,
		readdir: actual.readdir,
		stat: actual.stat,
		appendFile: (...args: unknown[]) => {
			const error = mockFsPromiseFaults.appendFile?.(args[0]);
			if (error) return Promise.reject(error);
			return (actual.appendFile as (...appendArgs: unknown[]) => Promise<void>)(...args);
		},
		rename: (...args: unknown[]) => {
			const error = mockFsPromiseFaults.rename?.(args[0], args[1]);
			if (error) return Promise.reject(error);
			return (actual.rename as (...renameArgs: unknown[]) => Promise<void>)(...args);
		},
	};
});

const mockGroupChatAgentOverrides = vi.hoisted(() => ({
	addParticipant: undefined as undefined | ((...args: unknown[]) => unknown),
}));

vi.mock('../../main/group-chat/group-chat-agent', async () => {
	const actual = await vi.importActual<typeof import('../../main/group-chat/group-chat-agent')>(
		'../../main/group-chat/group-chat-agent'
	);

	return {
		...actual,
		addParticipant: (...args: Parameters<typeof actual.addParticipant>) => {
			if (mockGroupChatAgentOverrides.addParticipant) {
				return mockGroupChatAgentOverrides.addParticipant(...args);
			}

			return actual.addParticipant(...args);
		},
	};
});

// Mock wrapSpawnWithSsh so we can verify it's called for SSH sessions
const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
}));

// Mock stores/getters: router reads global shellEnvVars via getSettingsStore().
// The mock is driven by `mockedShellEnvVars` so individual tests can assert the
// value actually flows through to processManager.spawn() and (for SSH) into
// wrapSpawnWithSsh's customEnvVars input.
let mockedShellEnvVars: Record<string, string> = {};
vi.mock('../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, defaultValue: unknown) =>
			key === 'shellEnvVars' ? mockedShellEnvVars : defaultValue,
	}),
}));

import {
	extractMentions,
	extractAllMentions,
	extractAutoRunDirectives,
	routeUserMessage,
	routeModeratorResponse,
	routeAgentResponse,
	spawnModeratorSynthesis,
	getGroupChatReadOnlyState,
	setGroupChatReadOnlyState,
	clearActiveParticipantTaskSession,
	getPendingParticipants,
	clearPendingParticipants,
	markParticipantResponded,
	respawnParticipantWithRecovery,
	setGetSessionsCallback,
	setGetCustomEnvVarsCallback,
	setGetAgentConfigCallback,
	setGetModeratorSettingsCallback,
	setSshStore,
	type SessionInfo,
} from '../../main/group-chat/group-chat-router';
import {
	spawnModerator,
	clearAllModeratorSessions,
	type IProcessManager,
} from '../../main/group-chat/group-chat-moderator';
import {
	addParticipant,
	clearAllParticipantSessionsGlobal,
	getParticipantSessionId,
} from '../../main/group-chat/group-chat-agent';
import {
	createGroupChat,
	deleteGroupChat,
	loadGroupChat,
	updateGroupChat,
	GroupChatParticipant,
} from '../../main/group-chat/group-chat-storage';
import { appendToLog, readLog } from '../../main/group-chat/group-chat-log';
import { AgentDetector } from '../../main/agents';
import { groupChatEmitters } from '../../main/ipc/handlers/groupChat';
import { setGetCustomShellPathCallback } from '../../main/group-chat/group-chat-config';

describe('group-chat-router', () => {
	let mockProcessManager: IProcessManager;
	let mockAgentDetector: AgentDetector;
	let createdChats: string[] = [];
	let testDir: string;
	const originalPlatform = process.platform;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
	let unexpectedConsoleLogs: string[] = [];
	let unexpectedConsoleErrors: string[] = [];

	const expectedConsoleLogPrefixes = [
		'[GroupChat:Debug]',
		'[GroupChatRouter]',
		'[GroupChatModerator]',
	];
	const expectedConsoleErrorPrefixes = ['[GroupChat:Debug] ERROR:', '[GroupChatRouter]'];

	beforeEach(async () => {
		unexpectedConsoleLogs = [];
		unexpectedConsoleErrors = [];
		const originalConsoleLog = console.log.bind(console);
		const originalConsoleError = console.error.bind(console);
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((message?: unknown, ...args) => {
			const text = String(message);
			if (expectedConsoleLogPrefixes.some((prefix) => text.startsWith(prefix))) {
				return;
			}

			unexpectedConsoleLogs.push(text);
			originalConsoleLog(message, ...args);
		});
		consoleErrorSpy = vi
			.spyOn(console, 'error')
			.mockImplementation((message?: unknown, ...args) => {
				const text = String(message);
				if (
					expectedConsoleErrorPrefixes.some((prefix) => text.includes(prefix)) ||
					text.includes('[ERROR] [[GroupChatRouter]]')
				) {
					return;
				}

				unexpectedConsoleErrors.push(text);
				originalConsoleError(message, ...args);
			});

		// Create a unique temp directory for each test
		testDir = path.join(
			os.tmpdir(),
			`group-chat-router-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await fs.mkdir(testDir, { recursive: true });

		// Set the mock userData path to our test directory
		mockUserDataPath = testDir;

		// Reset the global-settings shell env mock between tests
		mockedShellEnvVars = {};

		// Create a fresh mock for each test
		mockProcessManager = {
			spawn: vi.fn().mockReturnValue({ pid: 12345, success: true }),
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		};

		// Create a mock agent detector that returns a mock agent config
		mockAgentDetector = {
			getAgent: vi.fn().mockResolvedValue({
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: ['--print', '--verbose', '--output-format', 'stream-json'],
				available: true,
				path: '/usr/local/bin/claude',
				capabilities: {},
			}),
			detectAgents: vi.fn().mockResolvedValue([]),
			clearCache: vi.fn(),
			setCustomPaths: vi.fn(),
			getCustomPaths: vi.fn().mockReturnValue({}),
			discoverModels: vi.fn().mockResolvedValue([]),
			clearModelCache: vi.fn(),
		} as unknown as AgentDetector;

		// Clear any leftover sessions from previous tests
		clearAllModeratorSessions();
		clearAllParticipantSessionsGlobal();
		mockGroupChatAgentOverrides.addParticipant = undefined;
		mockFsPromiseFaults.appendFile = undefined;
		mockFsPromiseFaults.rename = undefined;
	});

	afterEach(async () => {
		for (const id of createdChats) {
			clearPendingParticipants(id);
		}

		// Clean up any created chats
		for (const id of createdChats) {
			try {
				await deleteGroupChat(id);
			} catch {
				// Ignore errors
			}
		}
		createdChats = [];

		consoleLogSpy.mockRestore();
		consoleErrorSpy.mockRestore();
		expect(unexpectedConsoleLogs).toEqual([]);
		expect(unexpectedConsoleErrors).toEqual([]);

		// Clear sessions
		clearAllModeratorSessions();
		clearAllParticipantSessionsGlobal();

		// Clean up temp directory
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}

		// Clear mocks
		vi.clearAllMocks();
		groupChatEmitters.emitMessage = undefined;
		groupChatEmitters.emitStateChange = undefined;
		groupChatEmitters.emitParticipantState = undefined;
		groupChatEmitters.emitParticipantsChanged = undefined;
		groupChatEmitters.emitHistoryEntry = undefined;
		groupChatEmitters.emitAutoRunTriggered = undefined;
		groupChatEmitters.emitAutoRunBatchComplete = undefined;
		setGetSessionsCallback(null as unknown as () => SessionInfo[]);
		setGetCustomEnvVarsCallback(null as unknown as () => undefined);
		setGetAgentConfigCallback(null as unknown as () => undefined);
		setGetModeratorSettingsCallback(
			null as unknown as () => {
				standingInstructions: string;
				conductorProfile: string;
			}
		);
		setGetCustomShellPathCallback(() => undefined);
		setSshStore(null as never);
		mockFsPromiseFaults.appendFile = undefined;
		mockFsPromiseFaults.rename = undefined;
		Object.defineProperty(process, 'platform', {
			value: originalPlatform,
			configurable: true,
		});
	});

	// Helper to track created chats for cleanup
	async function createTestChat(name: string, agentId: string = 'claude-code') {
		const chat = await createGroupChat(name, agentId);
		createdChats.push(chat.id);
		return chat;
	}

	// Helper to create chat with moderator spawned
	async function createTestChatWithModerator(name: string, agentId: string = 'claude-code') {
		const chat = await createTestChat(name, agentId);
		await spawnModerator(chat, mockProcessManager);
		return chat;
	}

	async function waitForAssertion(assertion: () => void): Promise<void> {
		const deadline = Date.now() + 1000;
		let lastError: unknown;

		while (Date.now() < deadline) {
			try {
				assertion();
				return;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}

		if (lastError) throw lastError;
		assertion();
	}

	function simulateWindows(shellPath = 'C:\\Tools\\pwsh.exe'): void {
		Object.defineProperty(process, 'platform', {
			value: 'win32',
			configurable: true,
		});
		setGetCustomShellPathCallback(() => shellPath);
	}

	// ===========================================================================
	// Test 5.1: extractMentions finds @mentions
	// ===========================================================================
	describe('extractMentions', () => {
		it('extracts @mentions from text', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
				{ name: 'Server', agentId: 'claude-code', sessionId: '2', addedAt: 0 },
			];

			const mentions = extractMentions('Hey @Client and @Server, please coordinate', participants);
			expect(mentions).toEqual(['Client', 'Server']);
		});

		it('returns mentions in order of appearance', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Alpha', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
				{ name: 'Beta', agentId: 'claude-code', sessionId: '2', addedAt: 0 },
				{ name: 'Gamma', agentId: 'claude-code', sessionId: '3', addedAt: 0 },
			];

			const mentions = extractMentions('@Gamma first, then @Alpha, finally @Beta', participants);
			expect(mentions).toEqual(['Gamma', 'Alpha', 'Beta']);
		});

		it('handles single mention', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			];

			const mentions = extractMentions('@Client: Please implement this', participants);
			expect(mentions).toEqual(['Client']);
		});

		it('returns empty array for no mentions', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			];

			const mentions = extractMentions('No mentions here', participants);
			expect(mentions).toEqual([]);
		});

		it('handles empty text', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			];

			const mentions = extractMentions('', participants);
			expect(mentions).toEqual([]);
		});

		it('handles empty participants list', () => {
			const mentions = extractMentions('@Client and @Server', []);
			expect(mentions).toEqual([]);
		});

		it('does not duplicate mentions', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			];

			const mentions = extractMentions('@Client and then @Client again', participants);
			expect(mentions).toEqual(['Client']);
		});

		it('handles mentions with underscores', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Backend_Dev', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			];

			const mentions = extractMentions('@Backend_Dev: Please help', participants);
			expect(mentions).toEqual(['Backend_Dev']);
		});

		it('handles mentions with numbers', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Agent1', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
				{ name: 'Agent2', agentId: 'claude-code', sessionId: '2', addedAt: 0 },
			];

			const mentions = extractMentions('@Agent1 and @Agent2', participants);
			expect(mentions).toEqual(['Agent1', 'Agent2']);
		});

		it('handles mentions with emojis', () => {
			const participants: GroupChatParticipant[] = [
				{ name: '✅-autorun-wizard', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
				{ name: '🚀-launcher', agentId: 'claude-code', sessionId: '2', addedAt: 0 },
			];

			const mentions = extractMentions(
				'@✅-autorun-wizard and @🚀-launcher please help',
				participants
			);
			expect(mentions).toEqual(['✅-autorun-wizard', '🚀-launcher']);
		});

		it('handles mentions with mixed unicode characters', () => {
			const participants: GroupChatParticipant[] = [
				{ name: '日本語-agent', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
				{ name: 'émoji-✨-test', agentId: 'claude-code', sessionId: '2', addedAt: 0 },
			];

			const mentions = extractMentions('@日本語-agent and @émoji-✨-test', participants);
			expect(mentions).toEqual(['日本語-agent', 'émoji-✨-test']);
		});
	});

	// ===========================================================================
	// Test 5.2: extractMentions ignores unknown mentions
	// ===========================================================================
	describe('extractMentions - unknown mentions', () => {
		it('ignores mentions not in participants', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			];

			const mentions = extractMentions('Hey @Client and @Unknown', participants);
			expect(mentions).toEqual(['Client']);
		});

		it('returns empty when all mentions are unknown', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			];

			const mentions = extractMentions('@Unknown1 and @Unknown2', participants);
			expect(mentions).toEqual([]);
		});

		it('case sensitive - ignores wrong case', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			];

			const mentions = extractMentions('@client @CLIENT @Client', participants);
			expect(mentions).toEqual(['Client']); // Only exact match
		});

		it('only matches valid participant names', () => {
			const participants: GroupChatParticipant[] = [
				{ name: 'Client', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
				{ name: 'Server', agentId: 'claude-code', sessionId: '2', addedAt: 0 },
			];

			// @Cli shouldn't match Client, @ServerX shouldn't match Server
			const mentions = extractMentions('@Cli and @ServerX and @Client', participants);
			expect(mentions).toEqual(['Client']);
		});
	});

	// ===========================================================================
	// Test 5.2b: Markdown-formatted mentions
	// AI moderators often wrap mentions in bold/italic/code markdown.
	// ===========================================================================
	describe('extractMentions - markdown formatting', () => {
		const participants: GroupChatParticipant[] = [
			{ name: 'controlplane', agentId: 'claude-code', sessionId: '1', addedAt: 0 },
			{ name: 'dataplane', agentId: 'claude-code', sessionId: '2', addedAt: 0 },
			{ name: 'Client', agentId: 'claude-code', sessionId: '3', addedAt: 0 },
		];

		it('handles bold markdown **@name**', () => {
			const mentions = extractMentions(
				'**@controlplane** - Please execute your plan.',
				participants
			);
			expect(mentions).toEqual(['controlplane']);
		});

		it('handles italic markdown _@name_', () => {
			const mentions = extractMentions('_@Client_ should review this', participants);
			expect(mentions).toEqual(['Client']);
		});

		it('handles bold+italic markdown ***@name***', () => {
			const mentions = extractMentions('***@dataplane*** is ready', participants);
			expect(mentions).toEqual(['dataplane']);
		});

		it('handles backtick markdown `@name`', () => {
			const mentions = extractMentions('`@controlplane` run the task', participants);
			expect(mentions).toEqual(['controlplane']);
		});

		it('handles strikethrough markdown ~~@name~~', () => {
			const mentions = extractMentions('~~@Client~~ was reassigned', participants);
			expect(mentions).toEqual(['Client']);
		});

		it('handles multiple markdown-formatted mentions in one message', () => {
			const mentions = extractMentions(
				'- **@controlplane** - execute plan\n- **@dataplane** - verify results',
				participants
			);
			expect(mentions).toEqual(['controlplane', 'dataplane']);
		});

		it('handles mixed formatted and plain mentions', () => {
			const mentions = extractMentions(
				'**@controlplane** and @dataplane should coordinate',
				participants
			);
			expect(mentions).toEqual(['controlplane', 'dataplane']);
		});

		it('skips empty names created by markdown-only mention tokens', () => {
			const mentions = extractMentions('@** and @Client should coordinate', participants);
			expect(mentions).toEqual(['Client']);
		});
	});

	// ===========================================================================
	// Test 5.2c: extractAllMentions with markdown formatting
	// ===========================================================================
	describe('extractAllMentions - markdown formatting', () => {
		it('strips markdown from extracted mention names', () => {
			const mentions = extractAllMentions('**@controlplane** and _@dataplane_');
			expect(mentions).toEqual(['controlplane', 'dataplane']);
		});

		it('handles backtick-wrapped mentions', () => {
			const mentions = extractAllMentions('`@myAgent` should handle this');
			expect(mentions).toEqual(['myAgent']);
		});

		it('does not produce empty mentions from bare @**', () => {
			const mentions = extractAllMentions('@** is not a real mention');
			expect(mentions).toEqual([]);
		});

		it('deduplicates repeated mentions after markdown is stripped', () => {
			const mentions = extractAllMentions('**@Client** and @Client and `@Server`');
			expect(mentions).toEqual(['Client', 'Server']);
		});
	});

	// ===========================================================================
	// Test 5.2d: extractAutoRunDirectives with markdown formatting
	// ===========================================================================
	describe('extractAutoRunDirectives - markdown formatting', () => {
		it('strips markdown from autorun directive participant names', () => {
			const result = extractAutoRunDirectives('!autorun @**controlplane**');
			expect(result.autoRunParticipants).toEqual(['controlplane']);
		});

		it('handles autorun with filename and markdown', () => {
			const result = extractAutoRunDirectives('!autorun @*controlplane*:plan.md');
			expect(result.autoRunDirectives).toEqual([
				{ participantName: 'controlplane', filename: 'plan.md' },
			]);
		});

		it('skips empty markdown-only directives and keeps the first duplicate directive', () => {
			const result = extractAutoRunDirectives(
				'!autorun @**\n!autorun @controlplane\n!autorun @controlplane:plan.md'
			);

			expect(result.autoRunDirectives).toEqual([{ participantName: 'controlplane' }]);
			expect(result.autoRunParticipants).toEqual(['controlplane']);
		});
	});

	// ===========================================================================
	// Test 5.3: routeUserMessage spawns moderator process in batch mode
	// Note: routeUserMessage now spawns a batch process per message instead of
	// writing to a persistent session.
	// ===========================================================================
	describe('routeUserMessage', () => {
		it('routes user message to moderator', async () => {
			const chat = await createTestChatWithModerator('Route Test');

			await routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector);

			// Should be in log
			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'user')).toBe(true);
			expect(messages.some((m) => m.content === 'Hello')).toBe(true);

			// Should spawn a batch process for the moderator
			expect(mockProcessManager.spawn).toHaveBeenCalled();
		});

		it('logs message with correct sender', async () => {
			const chat = await createTestChatWithModerator('Sender Test');

			await routeUserMessage(chat.id, 'User message here', mockProcessManager, mockAgentDetector);

			const messages = await readLog(chat.logPath);
			const userMessage = messages.find((m) => m.from === 'user');
			expect(userMessage).toBeDefined();
			expect(userMessage?.content).toBe('User message here');
		});

		it('sends message to moderator session', async () => {
			const chat = await createTestChatWithModerator('Session Test');

			await routeUserMessage(chat.id, 'Test message', mockProcessManager, mockAgentDetector);

			// Check that spawn was called with prompt containing the message
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('Test message'),
				})
			);
		});

		it('throws for non-existent chat', async () => {
			await expect(
				routeUserMessage('non-existent-id', 'Hello', mockProcessManager, mockAgentDetector)
			).rejects.toThrow(/not found/i);
		});

		it('throws when moderator is not active', async () => {
			const chat = await createTestChat('No Moderator');
			// Don't spawn moderator

			await expect(
				routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector)
			).rejects.toThrow(/not active/i);
		});

		it('works without process manager (log only)', async () => {
			const chat = await createTestChatWithModerator('Log Only Test');

			// No process manager - should still log
			await routeUserMessage(chat.id, 'Log only message');

			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'user' && m.content === 'Log only message')).toBe(
				true
			);
		});

		it('includes available session context, moderator settings, and custom env vars in moderator spawn', async () => {
			const chat = await createTestChatWithModerator('Moderator Context Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			setGetSessionsCallback(() => [
				{
					id: 'server-session',
					name: 'Server Agent',
					toolType: 'claude-code',
					cwd: '/repo/server',
				},
				{
					id: 'terminal-session',
					name: 'Terminal',
					toolType: 'terminal',
					cwd: '/repo/project',
				},
				{
					id: 'client-session',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/repo/client',
				},
			]);
			setGetCustomEnvVarsCallback((agentId) =>
				agentId === 'claude-code' ? { MAESTRO_ENV: 'group-chat' } : undefined
			);
			setGetModeratorSettingsCallback(() => ({
				standingInstructions: 'Always call out tradeoffs.',
				conductorProfile: 'Pragmatic conductor profile',
			}));
			mockProcessManager.spawn.mockClear();

			await routeUserMessage(
				chat.id,
				'Please coordinate the server work',
				mockProcessManager,
				mockAgentDetector
			);

			const spawnConfig = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnConfig.prompt).toContain('Pragmatic conductor profile');
			expect(spawnConfig.prompt).toContain('Always call out tradeoffs.');
			expect(spawnConfig.prompt).toContain('@Server-Agent (claude-code)');
			expect(spawnConfig.prompt).not.toContain('@Terminal');
			expect(spawnConfig.customEnvVars).toEqual({ MAESTRO_ENV: 'group-chat' });
		});

		it('throws when a process manager is provided without an agent detector', async () => {
			const chat = await createTestChatWithModerator('Missing Detector Test');

			await expect(routeUserMessage(chat.id, 'Hello', mockProcessManager)).rejects.toThrow(
				'AgentDetector not available'
			);
		});

		it('throws when the moderator agent cannot be resolved as available', async () => {
			const chat = await createTestChatWithModerator('Unavailable Moderator Test');
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce({
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: [],
				available: false,
				path: '/usr/local/bin/claude',
				capabilities: {},
			});

			await expect(
				routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector)
			).rejects.toThrow("Agent 'claude-code' is not available");
		});

		it('continues routing when auto-adding a mentioned session fails', async () => {
			const chat = await createTestChatWithModerator('User Mention Auto Add Failure Test');
			setGetSessionsCallback(() => [
				{
					id: 'broken-session',
					name: 'BrokenAgent',
					toolType: 'claude-code',
					cwd: '/repo/broken',
				},
			]);
			mockGroupChatAgentOverrides.addParticipant = vi
				.fn()
				.mockRejectedValueOnce(new Error('participant storage unavailable'));

			await routeUserMessage(
				chat.id,
				'@BrokenAgent please investigate',
				mockProcessManager,
				mockAgentDetector
			);

			const updatedChat = await loadGroupChat(chat.id);
			expect(updatedChat?.participants).toEqual([]);
			expect(mockGroupChatAgentOverrides.addParticipant).toHaveBeenCalledWith(
				chat.id,
				'BrokenAgent',
				'claude-code',
				mockProcessManager,
				'/repo/broken',
				mockAgentDetector,
				{},
				undefined,
				expect.objectContaining({ sshRemoteConfig: undefined }),
				undefined
			);
			const spawnConfig = vi.mocked(mockProcessManager.spawn).mock.calls[0]?.[0];
			expect(spawnConfig.prompt).toContain('@BrokenAgent please investigate');
			expect(spawnConfig.prompt).toContain('@BrokenAgent (claude-code)');
		});

		it('does not auto-add a user mention that already matches a participant name', async () => {
			const chat = await createTestChatWithModerator('Existing User Mention Test');
			await addParticipant(chat.id, 'Client Agent', 'claude-code', mockProcessManager);
			setGetSessionsCallback(() => [
				{
					id: 'client-session',
					name: 'Client Agent',
					toolType: 'claude-code',
					cwd: '/repo/client',
				},
			]);
			mockGroupChatAgentOverrides.addParticipant = vi.fn();
			mockProcessManager.spawn.mockClear();

			await routeUserMessage(
				chat.id,
				'@Client-Agent please continue',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockGroupChatAgentOverrides.addParticipant).not.toHaveBeenCalled();
			const updatedChat = await loadGroupChat(chat.id);
			expect(updatedChat?.participants).toHaveLength(1);
			expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		});

		it('does not auto-add terminal sessions mentioned by the user', async () => {
			const chat = await createTestChatWithModerator('User Mention Terminal Skip Test');
			setGetSessionsCallback(() => [
				{
					id: 'terminal-session',
					name: 'Terminal',
					toolType: 'terminal',
					cwd: '/repo/terminal',
				},
			]);
			mockGroupChatAgentOverrides.addParticipant = vi.fn();
			mockProcessManager.spawn.mockClear();

			await routeUserMessage(
				chat.id,
				'Please ask @Terminal to inspect this',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockGroupChatAgentOverrides.addParticipant).not.toHaveBeenCalled();
			const updatedChat = await loadGroupChat(chat.id);
			expect(updatedChat?.participants).toEqual([]);
			expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		});

		it('throws when a user mention auto-add removes the chat before reload', async () => {
			const chat = await createTestChatWithModerator('User Mention Vanishing Chat Test');
			setGetSessionsCallback(() => [
				{
					id: 'vanishing-session',
					name: 'VanishingAgent',
					toolType: 'claude-code',
					cwd: '/repo/vanishing',
				},
			]);
			mockGroupChatAgentOverrides.addParticipant = vi.fn(async () => {
				await deleteGroupChat(chat.id);
			});
			mockProcessManager.spawn.mockClear();

			await expect(
				routeUserMessage(
					chat.id,
					'@VanishingAgent please join',
					mockProcessManager,
					mockAgentDetector
				)
			).rejects.toThrow(`Group chat not found after participant update: ${chat.id}`);
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('applies SSH wrapping for a moderator configured on a remote', async () => {
			const sshRemoteConfig = {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/user/project',
			};
			const mockSshStore = {
				getSshRemotes: vi
					.fn()
					.mockReturnValue([
						{ id: 'remote-1', name: 'PedTome', host: 'pedtome.local', user: 'user' },
					]),
			};
			mockWrapSpawnWithSsh.mockResolvedValueOnce({
				command: 'ssh',
				args: ['-t', 'user@pedtome.local', 'claude', '--print'],
				cwd: '/home/user/project',
				prompt: 'remote moderator prompt',
				customEnvVars: { REMOTE: '1' },
				sshRemoteUsed: { name: 'PedTome' },
			});
			const chat = await createGroupChat('SSH Moderator User Message Test', 'claude-code', {
				sshRemoteConfig,
			});
			createdChats.push(chat.id);
			await spawnModerator(chat, mockProcessManager);
			setSshStore(mockSshStore);
			mockProcessManager.spawn.mockClear();

			await routeUserMessage(chat.id, 'Coordinate remotely', mockProcessManager, mockAgentDetector);

			expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
				expect.objectContaining({
					command: '/usr/local/bin/claude',
					agentBinaryName: 'claude',
					prompt: expect.stringContaining('Coordinate remotely'),
				}),
				sshRemoteConfig,
				mockSshStore
			);
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					cwd: '/home/user/project',
					prompt: 'remote moderator prompt',
					customEnvVars: { REMOTE: '1' },
				})
			);
		});

		it('handles SSH-wrapped moderator spawns when no remote record is returned', async () => {
			const sshRemoteConfig = {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/user/project',
			};
			const chat = await createGroupChat('SSH Moderator No Remote Used Test', 'claude-code', {
				sshRemoteConfig,
			});
			createdChats.push(chat.id);
			await spawnModerator(chat, mockProcessManager);
			setSshStore({
				getSshRemotes: vi.fn().mockReturnValue([]),
			});
			mockWrapSpawnWithSsh.mockResolvedValueOnce({
				command: 'ssh',
				args: ['claude', '--print'],
				cwd: '/home/user/project',
				prompt: 'remote moderator prompt',
				customEnvVars: {},
			});
			mockProcessManager.spawn.mockClear();

			await routeUserMessage(chat.id, 'Coordinate remotely', mockProcessManager, mockAgentDetector);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					cwd: '/home/user/project',
					prompt: 'remote moderator prompt',
				})
			);
		});

		it('resets state and reports spawn failure when moderator spawn throws', async () => {
			const chat = await createTestChatWithModerator('Moderator Spawn Failure Test');
			groupChatEmitters.emitStateChange = vi.fn();
			mockProcessManager.spawn.mockImplementationOnce(() => {
				throw new Error('moderator spawn failed');
			});

			await expect(
				routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector)
			).rejects.toThrow('Failed to spawn moderator: moderator spawn failed');
			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'moderator-thinking');
			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle');
		});

		it('reports non-Error moderator spawn failures with their string value', async () => {
			const chat = await createTestChatWithModerator('Moderator String Spawn Failure Test');
			mockProcessManager.spawn.mockImplementationOnce(() => {
				throw 'spawn failed as string';
			});

			await expect(
				routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector)
			).rejects.toThrow('Failed to spawn moderator: spawn failed as string');
		});

		it('applies Windows shell config to local moderator spawns', async () => {
			const chat = await createTestChatWithModerator('Windows Moderator Spawn Test');
			simulateWindows();
			mockProcessManager.spawn.mockClear();

			await routeUserMessage(
				chat.id,
				'Coordinate on Windows',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: 'C:\\Tools\\pwsh.exe',
					runInShell: true,
					sendPromptViaStdin: true,
					sendPromptViaStdinRaw: false,
				})
			);
		});

		it('throws when the moderator agent detector returns no config', async () => {
			const chat = await createTestChatWithModerator('Missing Moderator Config Test');
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce(null as never);

			await expect(
				routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector)
			).rejects.toThrow("Agent 'claude-code' is not available");
			expect(mockProcessManager.spawn).not.toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('Hello'),
				})
			);
		});

		it('uses command fallback and disables Gemini sandbox when read-only is CLI-enforced', async () => {
			const chat = await createTestChatWithModerator('Gemini Moderator Spawn Test');
			await updateGroupChat(chat.id, { moderatorAgentId: 'gemini-cli' });
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce({
				id: 'gemini-cli',
				name: 'Gemini CLI',
				binaryName: 'gemini',
				command: 'gemini',
				args: ['--yolo'],
				available: true,
				capabilities: {},
				promptArgs: ['--prompt'],
				readOnlyCliEnforced: true,
			});
			mockProcessManager.spawn.mockClear();

			await routeUserMessage(
				chat.id,
				'Coordinate through Gemini',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					toolType: 'gemini-cli',
					command: 'gemini',
					args: expect.arrayContaining(['--no-sandbox']),
					readOnlyMode: true,
				})
			);
		});
	});

	// ===========================================================================
	// Test 5.4: routeModeratorResponse forwards to mentioned agents
	// ===========================================================================
	describe('routeModeratorResponse', () => {
		it('spawns mentioned agents', async () => {
			const chat = await createTestChatWithModerator('Forward Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			await routeModeratorResponse(
				chat.id,
				'@Client: Please implement the login form',
				mockProcessManager,
				mockAgentDetector
			);

			const spawnCall = mockProcessManager.spawn.mock.calls.find((call) =>
				call[0]?.prompt?.includes('login form')
			);
			expect(spawnCall).toBeDefined();
		});

		it('logs moderator message', async () => {
			const chat = await createTestChatWithModerator('Log Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			await routeModeratorResponse(chat.id, '@Client: Task for you', mockProcessManager);

			const messages = await readLog(chat.logPath);
			expect(
				messages.some((m) => m.from === 'moderator' && m.content.includes('Task for you'))
			).toBe(true);
		});

		it('spawns multiple mentioned agents', async () => {
			const chat = await createTestChatWithModerator('Multi Forward Test');
			const client = await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			const server = await addParticipant(chat.id, 'Server', 'claude-code', mockProcessManager);

			await routeModeratorResponse(
				chat.id,
				'@Client and @Server: Coordinate on API',
				mockProcessManager,
				mockAgentDetector
			);

			const spawnCalls = mockProcessManager.spawn.mock.calls;
			const clientSpawn = spawnCalls.find((call) => call[0]?.prompt?.includes('Client'));
			const serverSpawn = spawnCalls.find((call) => call[0]?.prompt?.includes('Server'));

			expect(clientSpawn).toBeDefined();
			expect(serverSpawn).toBeDefined();
		});

		it('ignores unknown mentions', async () => {
			const chat = await createTestChatWithModerator('Unknown Mention Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			// Clear the write mock after setup
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@Unknown: This should not route',
				mockProcessManager,
				mockAgentDetector
			);

			// Should not spawn any participant (since Unknown doesn't exist)
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('treats unresolved @tokens as plain text without emitting a system warning', async () => {
			const chat = await createTestChatWithModerator('Literal At Symbol Test');
			const emitMessage = vi.fn();
			groupChatEmitters.emitMessage = emitMessage;

			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'Please keep the literal @example value in the final message.',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(emitMessage).not.toHaveBeenCalledWith(
				chat.id,
				expect.objectContaining({
					from: 'system',
				})
			);
		});

		it('continues moderator response flow when adding a history entry fails', async () => {
			const chat = await createTestChatWithModerator('Moderator History Failure Test');
			mockFsPromiseFaults.appendFile = (file) =>
				String(file).endsWith('history.jsonl') ? new Error('history write failed') : undefined;

			await routeModeratorResponse(
				chat.id,
				'Final answer without participant mentions',
				mockProcessManager,
				mockAgentDetector
			);

			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'moderator')).toBe(true);
			expect(mockProcessManager.spawn).not.toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: expect.stringContaining('participant'),
				})
			);
		});

		it('skips routing for a non-existent chat', async () => {
			await expect(
				routeModeratorResponse('non-existent-id', 'Hello', mockProcessManager)
			).resolves.toBeUndefined();

			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('works without process manager (log only)', async () => {
			const chat = await createTestChatWithModerator('Log Only Mod Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			mockProcessManager.write.mockClear();

			// No process manager - should still log
			await routeModeratorResponse(chat.id, '@Client: Log only');

			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'moderator')).toBe(true);
		});

		it('logs long final moderator messages without routing unresolved mentions', async () => {
			const chat = await createTestChatWithModerator('Long Moderator Final Test');
			const longMessage = `${'M'.repeat(320)} final synthesis without participants`;
			groupChatEmitters.emitMessage = vi.fn();
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(chat.id, longMessage, mockProcessManager, mockAgentDetector);

			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(groupChatEmitters.emitMessage).toHaveBeenCalledWith(
				chat.id,
				expect.objectContaining({
					from: 'moderator',
					content: longMessage,
				})
			);
		});

		it('triggers autorun directives without persisting directive-only moderator messages', async () => {
			const chat = await createTestChatWithModerator('Autorun Trigger Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			setGetSessionsCallback(() => [
				{
					id: 'client-session',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/repo/client',
					autoRunFolderPath: '/repo/client/docs',
				},
			]);
			groupChatEmitters.emitAutoRunTriggered = vi.fn();
			groupChatEmitters.emitParticipantState = vi.fn();
			groupChatEmitters.emitStateChange = vi.fn();
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'!autorun @Client:plan.md',
				mockProcessManager,
				mockAgentDetector
			);

			expect(groupChatEmitters.emitParticipantState).toHaveBeenCalledWith(
				chat.id,
				'Client',
				'working'
			);
			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'agent-working');
			expect(groupChatEmitters.emitAutoRunTriggered).toHaveBeenCalledWith(
				chat.id,
				'Client',
				'plan.md'
			);
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect([...getPendingParticipants(chat.id)]).toEqual(['Client']);
			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'moderator')).toBe(false);
			expect(markParticipantResponded(chat.id, 'Client')).toBe(true);
		});

		it('triggers autorun directives without target filenames', async () => {
			const chat = await createTestChatWithModerator('Autorun No Filename Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			setGetSessionsCallback(() => [
				{
					id: 'client-session',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/repo/client',
					autoRunFolderPath: '/repo/client/docs',
				},
			]);
			groupChatEmitters.emitAutoRunTriggered = vi.fn();
			groupChatEmitters.emitStateChange = vi.fn();

			await routeModeratorResponse(
				chat.id,
				'!autorun @Client',
				mockProcessManager,
				mockAgentDetector
			);

			expect(groupChatEmitters.emitAutoRunTriggered).toHaveBeenCalledWith(
				chat.id,
				'Client',
				undefined
			);
			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'agent-working');
			expect(markParticipantResponded(chat.id, 'Client')).toBe(true);
		});

		it('triggers multiple autorun participants without process dependencies', async () => {
			const chat = await createTestChatWithModerator('Autorun No Process Dependencies Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			await addParticipant(chat.id, 'Server', 'claude-code', mockProcessManager);
			setGetSessionsCallback(() => [
				{
					id: 'client-session',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/repo/client',
					autoRunFolderPath: '/repo/client/docs',
				},
				{
					id: 'server-session',
					name: 'Server',
					toolType: 'claude-code',
					cwd: '/repo/server',
					autoRunFolderPath: '/repo/server/docs',
				},
			]);
			groupChatEmitters.emitAutoRunTriggered = vi.fn();
			groupChatEmitters.emitStateChange = vi.fn();

			await routeModeratorResponse(chat.id, '!autorun @Client\n!autorun @Server');

			expect(groupChatEmitters.emitAutoRunTriggered).toHaveBeenCalledWith(
				chat.id,
				'Client',
				undefined
			);
			expect(groupChatEmitters.emitAutoRunTriggered).toHaveBeenCalledWith(
				chat.id,
				'Server',
				undefined
			);
			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledTimes(1);
			expect([...getPendingParticipants(chat.id)].sort()).toEqual(['Client', 'Server']);
			clearPendingParticipants(chat.id);
		});

		it('emits system warnings when autorun directives cannot be activated', async () => {
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Autorun Missing Participant Test');
				const emitMessage = vi.fn();
				groupChatEmitters.emitMessage = emitMessage;
				groupChatEmitters.emitStateChange = vi.fn();

				await routeModeratorResponse(
					chat.id,
					'!autorun @MissingAgent',
					mockProcessManager,
					mockAgentDetector
				);

				expect(emitMessage).toHaveBeenCalledWith(
					chat.id,
					expect.objectContaining({
						from: 'system',
						content: expect.stringContaining('Could not find participant @MissingAgent'),
					})
				);
				expect(emitMessage).toHaveBeenCalledWith(
					chat.id,
					expect.objectContaining({
						from: 'system',
						content: expect.stringContaining('none could be activated'),
					})
				);
				expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle');
				expect(getPendingParticipants(chat.id).size).toBe(0);
				expect(consoleWarn).toHaveBeenCalledWith(
					'[GroupChat:Debug] Autorun participant MissingAgent not found in chat - skipping'
				);
			} finally {
				consoleWarn.mockRestore();
			}
		});

		it('warns when an autorun participant has no configured Auto Run folder', async () => {
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Autorun Missing Folder Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
				setGetSessionsCallback(() => [
					{
						id: 'client-session',
						name: 'Client',
						toolType: 'claude-code',
						cwd: '/repo/client',
					},
				]);
				const emitMessage = vi.fn();
				groupChatEmitters.emitMessage = emitMessage;
				groupChatEmitters.emitStateChange = vi.fn();
				groupChatEmitters.emitAutoRunTriggered = vi.fn();
				mockProcessManager.spawn.mockClear();

				await routeModeratorResponse(
					chat.id,
					'!autorun @Client',
					mockProcessManager,
					mockAgentDetector
				);

				expect(emitMessage).toHaveBeenCalledWith(
					chat.id,
					expect.objectContaining({
						from: 'system',
						content: expect.stringContaining('No Auto Run folder configured for @Client'),
					})
				);
				expect(groupChatEmitters.emitAutoRunTriggered).not.toHaveBeenCalled();
				expect(mockProcessManager.spawn).not.toHaveBeenCalled();
				expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle');
				expect(consoleWarn).toHaveBeenCalledWith(
					'[GroupChat:Debug] No autoRunFolderPath configured for Client - skipping'
				);
			} finally {
				consoleWarn.mockRestore();
			}
		});

		it('cleans up lifecycle state when participant spawn fails', async () => {
			const chat = await createTestChatWithModerator('Participant Spawn Failure Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			setGetSessionsCallback(() => [
				{
					id: 'client-session',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/repo/client',
				},
			]);
			groupChatEmitters.emitStateChange = vi.fn();
			mockProcessManager.spawn.mockImplementationOnce(() => {
				throw new Error('participant spawn failed');
			});

			await routeModeratorResponse(
				chat.id,
				'@Client please handle this',
				mockProcessManager,
				mockAgentDetector
			);

			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle');
			expect(getPendingParticipants(chat.id).size).toBe(0);
		});

		it('continues when moderator auto-adding a mentioned session fails', async () => {
			const chat = await createTestChatWithModerator('Moderator Auto Add Failure Test');
			setGetSessionsCallback(() => [
				{
					id: 'broken-session',
					name: 'BrokenAgent',
					toolType: 'claude-code',
					cwd: '/repo/broken',
				},
			]);
			mockGroupChatAgentOverrides.addParticipant = vi
				.fn()
				.mockRejectedValueOnce(new Error('participant add failed'));
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@BrokenAgent please help',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockGroupChatAgentOverrides.addParticipant).toHaveBeenCalled();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			const updatedChat = await loadGroupChat(chat.id);
			expect(updatedChat?.participants).toEqual([]);
		});

		it('does not auto-add terminal sessions mentioned by the moderator', async () => {
			const chat = await createTestChatWithModerator('Moderator Mention Terminal Skip Test');
			setGetSessionsCallback(() => [
				{
					id: 'terminal-session',
					name: 'Terminal',
					toolType: 'terminal',
					cwd: '/repo/terminal',
				},
			]);
			mockGroupChatAgentOverrides.addParticipant = vi.fn();
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@Terminal should stay literal, not become a participant',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockGroupChatAgentOverrides.addParticipant).not.toHaveBeenCalled();
			const updatedChat = await loadGroupChat(chat.id);
			expect(updatedChat?.participants).toEqual([]);
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('returns without spawning if moderator auto-add removes the chat before reload', async () => {
			const chat = await createTestChatWithModerator('Moderator Vanishing Chat Test');
			setGetSessionsCallback(() => [
				{
					id: 'vanishing-session',
					name: 'VanishingAgent',
					toolType: 'claude-code',
					cwd: '/repo/vanishing',
				},
			]);
			mockGroupChatAgentOverrides.addParticipant = vi.fn(async () => {
				await deleteGroupChat(chat.id);
			});
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@VanishingAgent please help',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('skips a mentioned participant when the participant agent is unavailable', async () => {
			const chat = await createTestChatWithModerator('Unavailable Participant Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce({
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: [],
				available: false,
				path: '/usr/local/bin/claude',
				capabilities: {},
			});
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@Client please handle this',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(getPendingParticipants(chat.id).size).toBe(0);
		});

		it('skips a mentioned participant when the agent detector returns no config', async () => {
			const chat = await createTestChatWithModerator('Missing Agent Config Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce(null as never);
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@Client please handle this',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(getPendingParticipants(chat.id).size).toBe(0);
		});

		it('applies Windows shell config to local participant spawns', async () => {
			const chat = await createTestChatWithModerator('Windows Participant Spawn Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			simulateWindows();
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@Client please handle this on Windows',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: 'C:\\Tools\\pwsh.exe',
					runInShell: true,
					sendPromptViaStdin: true,
					sendPromptViaStdinRaw: false,
				})
			);
		});

		it('uses agent command fallback when participant config has no resolved path', async () => {
			const chat = await createTestChatWithModerator('Participant Command Fallback Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			await appendToLog(chat.logPath, 'user', 'B'.repeat(520));
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce({
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: ['--print'],
				available: true,
				capabilities: {},
				promptArgs: ['--prompt'],
			});
			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@Client please handle command fallback',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'claude',
					cwd: os.homedir(),
				})
			);
		});

		it('replaces an existing participant response timeout for repeated handoffs', async () => {
			vi.useFakeTimers();
			try {
				const chat = await createTestChatWithModerator('Repeated Timeout Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

				await routeModeratorResponse(
					chat.id,
					'@Client please start this task',
					mockProcessManager,
					mockAgentDetector
				);
				await routeModeratorResponse(
					chat.id,
					'@Client please restart with this context',
					mockProcessManager,
					mockAgentDetector
				);

				expect([...getPendingParticipants(chat.id)]).toEqual(['Client']);
			} finally {
				vi.useRealTimers();
			}
		});

		it('ignores a stale timeout after the participant is no longer pending', async () => {
			vi.useFakeTimers();
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Stale Timeout Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
				groupChatEmitters.emitParticipantState = vi.fn();

				await routeModeratorResponse(
					chat.id,
					'@Client please handle this task',
					mockProcessManager,
					mockAgentDetector
				);
				getPendingParticipants(chat.id).delete('Client');

				await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);

				expect(groupChatEmitters.emitParticipantState).not.toHaveBeenCalledWith(
					chat.id,
					'Client',
					'idle'
				);
				expect(consoleWarn).not.toHaveBeenCalledWith(
					expect.stringContaining('Participant Client timed out')
				);
			} finally {
				vi.useRealTimers();
				consoleWarn.mockRestore();
			}
		});

		it('continues timeout completion when writing the timeout log entry fails', async () => {
			vi.useFakeTimers();
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Timeout Log Failure Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
				groupChatEmitters.emitParticipantState = vi.fn();

				await routeModeratorResponse(
					chat.id,
					'@Client please handle a task that may time out',
					mockProcessManager,
					mockAgentDetector
				);
				mockFsPromiseFaults.appendFile = (file) =>
					String(file) === chat.logPath ? new Error('timeout log write failed') : undefined;

				await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
				vi.useRealTimers();

				await waitForAssertion(() =>
					expect(groupChatEmitters.emitParticipantState).toHaveBeenCalledWith(
						chat.id,
						'Client',
						'idle'
					)
				);
				expect(getPendingParticipants(chat.id).size).toBe(0);
			} finally {
				vi.useRealTimers();
				consoleWarn.mockRestore();
				mockFsPromiseFaults.appendFile = undefined;
			}
		});

		it('resets group state when synthesis after a participant timeout fails', async () => {
			vi.useFakeTimers();
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Timeout Synthesis Failure Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
				groupChatEmitters.emitStateChange = vi.fn();

				await routeModeratorResponse(
					chat.id,
					'@Client please handle a task before synthesis fails',
					mockProcessManager,
					mockAgentDetector
				);
				vi.mocked(mockAgentDetector.getAgent).mockRejectedValueOnce(new Error('detector offline'));

				await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
				vi.useRealTimers();

				await waitForAssertion(() =>
					expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle')
				);
			} finally {
				vi.useRealTimers();
				consoleWarn.mockRestore();
			}
		});

		it('force-completes unanswered mentioned participants and triggers synthesis after timeout', async () => {
			vi.useFakeTimers();
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Mention Timeout Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
				groupChatEmitters.emitMessage = vi.fn();
				groupChatEmitters.emitParticipantState = vi.fn();
				groupChatEmitters.emitStateChange = vi.fn();
				mockProcessManager.spawn.mockClear();

				await routeModeratorResponse(
					chat.id,
					'@Client: please handle this long task',
					mockProcessManager,
					mockAgentDetector
				);

				expect([...getPendingParticipants(chat.id)]).toEqual(['Client']);
				mockProcessManager.spawn.mockClear();

				await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
				vi.useRealTimers();
				await waitForAssertion(() =>
					expect(groupChatEmitters.emitParticipantState).toHaveBeenCalledWith(
						chat.id,
						'Client',
						'idle'
					)
				);

				expect(consoleWarn).toHaveBeenCalledWith(
					expect.stringContaining('Participant Client timed out')
				);
				expect(groupChatEmitters.emitMessage).toHaveBeenCalledWith(
					chat.id,
					expect.objectContaining({
						from: 'system',
						content: expect.stringContaining('@Client did not respond within 10 minutes'),
					})
				);
				expect(getPendingParticipants(chat.id).size).toBe(0);
				await waitForAssertion(() =>
					expect(mockProcessManager.spawn).toHaveBeenCalledWith(
						expect.objectContaining({
							toolType: 'claude-code',
							readOnlyMode: true,
						})
					)
				);
				const messages = await readLog(chat.logPath);
				expect(
					messages.some(
						(message) =>
							message.from === 'Client' &&
							message.content.includes('[Timed out') &&
							message.content.includes('10 minutes')
					)
				).toBe(true);
			} finally {
				vi.useRealTimers();
				consoleWarn.mockRestore();
			}
		});

		it('emits Auto Run batch completion when an autorun participant times out', async () => {
			vi.useFakeTimers();
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Autorun Timeout Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
				setGetSessionsCallback(() => [
					{
						id: 'client-session',
						name: 'Client',
						toolType: 'claude-code',
						cwd: '/repo/client',
						autoRunFolderPath: '/repo/client/docs',
					},
				]);
				groupChatEmitters.emitAutoRunTriggered = vi.fn();
				groupChatEmitters.emitAutoRunBatchComplete = vi.fn();
				groupChatEmitters.emitParticipantState = vi.fn();
				groupChatEmitters.emitStateChange = vi.fn();
				mockProcessManager.spawn.mockClear();

				await routeModeratorResponse(
					chat.id,
					'!autorun @Client:plan.md',
					mockProcessManager,
					mockAgentDetector
				);

				expect(groupChatEmitters.emitAutoRunTriggered).toHaveBeenCalledWith(
					chat.id,
					'Client',
					'plan.md'
				);
				expect([...getPendingParticipants(chat.id)]).toEqual(['Client']);

				await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
				vi.useRealTimers();
				await waitForAssertion(() =>
					expect(groupChatEmitters.emitAutoRunBatchComplete).toHaveBeenCalledWith(chat.id, 'Client')
				);

				expect(groupChatEmitters.emitParticipantState).toHaveBeenCalledWith(
					chat.id,
					'Client',
					'idle'
				);
				expect(getPendingParticipants(chat.id).size).toBe(0);
			} finally {
				vi.useRealTimers();
				consoleWarn.mockRestore();
			}
		});

		it('keeps Auto Run tracking active until all timed-out participants finish', async () => {
			vi.useFakeTimers();
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Multiple Autorun Timeout Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
				await addParticipant(chat.id, 'Server', 'claude-code', mockProcessManager);
				setGetSessionsCallback(() => [
					{
						id: 'client-session',
						name: 'Client',
						toolType: 'claude-code',
						cwd: '/repo/client',
						autoRunFolderPath: '/repo/client/docs',
					},
					{
						id: 'server-session',
						name: 'Server',
						toolType: 'claude-code',
						cwd: '/repo/server',
						autoRunFolderPath: '/repo/server/docs',
					},
				]);
				groupChatEmitters.emitAutoRunTriggered = vi.fn();
				groupChatEmitters.emitAutoRunBatchComplete = vi.fn();
				groupChatEmitters.emitParticipantState = vi.fn();
				mockProcessManager.spawn.mockClear();

				await routeModeratorResponse(chat.id, '!autorun @Client:plan.md\n!autorun @Server:api.md');
				expect([...getPendingParticipants(chat.id)].sort()).toEqual(['Client', 'Server']);

				await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
				vi.useRealTimers();
				await waitForAssertion(() =>
					expect(groupChatEmitters.emitAutoRunBatchComplete).toHaveBeenCalledTimes(2)
				);

				expect(groupChatEmitters.emitAutoRunBatchComplete).toHaveBeenCalledWith(chat.id, 'Client');
				expect(groupChatEmitters.emitAutoRunBatchComplete).toHaveBeenCalledWith(chat.id, 'Server');
				expect(getPendingParticipants(chat.id).size).toBe(0);
				expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
				consoleWarn.mockRestore();
			}
		});

		it('continues Auto Run timeout cleanup when the chat was deleted', async () => {
			vi.useFakeTimers();
			const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const chat = await createTestChatWithModerator('Deleted Autorun Timeout Test');
				await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
				setGetSessionsCallback(() => [
					{
						id: 'client-session',
						name: 'Client',
						toolType: 'claude-code',
						cwd: '/repo/client',
						autoRunFolderPath: '/repo/client/docs',
					},
				]);
				groupChatEmitters.emitAutoRunTriggered = vi.fn();
				groupChatEmitters.emitAutoRunBatchComplete = vi.fn();
				groupChatEmitters.emitParticipantState = vi.fn();

				await routeModeratorResponse(chat.id, '!autorun @Client:plan.md');
				await deleteGroupChat(chat.id);

				await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
				vi.useRealTimers();
				await waitForAssertion(() =>
					expect(groupChatEmitters.emitAutoRunBatchComplete).toHaveBeenCalledWith(chat.id, 'Client')
				);

				expect(groupChatEmitters.emitParticipantState).toHaveBeenCalledWith(
					chat.id,
					'Client',
					'idle'
				);
				expect(getPendingParticipants(chat.id).size).toBe(0);
			} finally {
				vi.useRealTimers();
				consoleWarn.mockRestore();
			}
		});
	});

	describe('routing state helpers', () => {
		it('tracks read-only state and pending participant lifecycle', async () => {
			const chat = await createTestChatWithModerator('Pending State Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			expect(getGroupChatReadOnlyState(chat.id)).toBe(false);
			setGroupChatReadOnlyState(chat.id, true);
			expect(getGroupChatReadOnlyState(chat.id)).toBe(true);
			setGroupChatReadOnlyState(chat.id, false);
			expect(getGroupChatReadOnlyState(chat.id)).toBe(false);
			expect(getPendingParticipants(chat.id).size).toBe(0);
			expect(markParticipantResponded(chat.id, 'Client')).toBe(false);

			await routeModeratorResponse(
				chat.id,
				'@Client: please implement this',
				mockProcessManager,
				mockAgentDetector
			);

			expect([...getPendingParticipants(chat.id)]).toEqual(['Client']);
			expect(markParticipantResponded(chat.id, 'Client')).toBe(true);
			expect(getPendingParticipants(chat.id).size).toBe(0);

			await routeModeratorResponse(
				chat.id,
				'@Client: please review this too',
				mockProcessManager,
				mockAgentDetector
			);
			expect([...getPendingParticipants(chat.id)]).toEqual(['Client']);
			clearPendingParticipants(chat.id);
			expect(getPendingParticipants(chat.id).size).toBe(0);
		});

		it('returns false when one of multiple pending participants has responded', async () => {
			const chat = await createTestChatWithModerator('Multiple Pending State Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			await addParticipant(chat.id, 'Server', 'claude-code', mockProcessManager);

			await routeModeratorResponse(
				chat.id,
				'@Client and @Server please coordinate',
				mockProcessManager,
				mockAgentDetector
			);

			expect([...getPendingParticipants(chat.id)].sort()).toEqual(['Client', 'Server']);
			expect(markParticipantResponded(chat.id, 'Client')).toBe(false);
			expect([...getPendingParticipants(chat.id)]).toEqual(['Server']);
			expect(markParticipantResponded(chat.id, 'Server')).toBe(true);
		});

		it('clears the active participant task session tracked by a router spawn', async () => {
			const chat = await createTestChatWithModerator('Active Participant Clear Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			await routeModeratorResponse(
				chat.id,
				'@Client please implement this',
				mockProcessManager,
				mockAgentDetector
			);

			expect(getParticipantSessionId(chat.id, 'Client')).toContain(
				`group-chat-${chat.id}-participant-Client-`
			);
			clearActiveParticipantTaskSession(chat.id, 'Client');
			expect(getParticipantSessionId(chat.id, 'Client')).toBeUndefined();
		});
	});

	describe('spawnModeratorSynthesis', () => {
		it('spawns a synthesis moderator with recent history, participant context, settings, and env vars', async () => {
			const chat = await createTestChatWithModerator('Synthesis Test');
			await addParticipant(chat.id, 'Client Agent', 'claude-code', mockProcessManager);
			await routeAgentResponse(
				chat.id,
				'Client Agent',
				'Implemented the server route. The API is ready.',
				mockProcessManager
			);
			setGetModeratorSettingsCallback(() => ({
				standingInstructions: 'Summarize decisions crisply.',
				conductorProfile: 'Synthesis conductor profile',
			}));
			setGetCustomEnvVarsCallback((agentId) =>
				agentId === 'claude-code' ? { SYNTH_ENV: 'enabled' } : undefined
			);
			groupChatEmitters.emitStateChange = vi.fn();
			mockProcessManager.spawn.mockClear();

			await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'moderator-thinking');
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					toolType: 'claude-code',
					readOnlyMode: true,
					customEnvVars: { SYNTH_ENV: 'enabled' },
					prompt: expect.stringContaining('Synthesis conductor profile'),
				})
			);
			const spawnConfig = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnConfig.prompt).toContain('Summarize decisions crisply.');
			expect(spawnConfig.prompt).toContain('@Client-Agent (claude-code session)');
			expect(spawnConfig.prompt).toContain('[Client Agent]: Implemented the server route.');
			expect(spawnConfig.prompt).toContain('Do NOT include any !autorun directives');
		});

		it('resets state without spawning when the chat or moderator is unavailable', async () => {
			groupChatEmitters.emitStateChange = vi.fn();

			await spawnModeratorSynthesis('missing-chat', mockProcessManager, mockAgentDetector);

			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith('missing-chat', 'idle');
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();

			const chat = await createTestChat('Inactive Moderator Synthesis Test');
			groupChatEmitters.emitStateChange = vi.fn();

			await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle');
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('resets state when synthesis cannot resolve or spawn the moderator agent', async () => {
			const unavailableChat = await createTestChatWithModerator('Unavailable Synthesis Test');
			groupChatEmitters.emitStateChange = vi.fn();
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce({
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: [],
				available: false,
				path: '/usr/local/bin/claude',
				capabilities: {},
			});

			await spawnModeratorSynthesis(unavailableChat.id, mockProcessManager, mockAgentDetector);

			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(unavailableChat.id, 'idle');
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();

			const spawnErrorChat = await createTestChatWithModerator('Synthesis Spawn Error Test');
			groupChatEmitters.emitStateChange = vi.fn();
			vi.mocked(mockProcessManager.spawn).mockImplementationOnce(() => {
				throw new Error('spawn failed');
			});

			await spawnModeratorSynthesis(spawnErrorChat.id, mockProcessManager, mockAgentDetector);

			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(
				spawnErrorChat.id,
				'moderator-thinking'
			);
			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(spawnErrorChat.id, 'idle');
		});

		it('resets state without spawning when the moderator session id was cleared', async () => {
			const chat = await createTestChatWithModerator('Missing Moderator Session Synthesis Test');
			groupChatEmitters.emitStateChange = vi.fn();
			clearAllModeratorSessions();
			mockProcessManager.spawn.mockClear();

			await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle');
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('applies Windows shell config to synthesis moderator spawns', async () => {
			const chat = await createTestChatWithModerator('Windows Synthesis Spawn Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			await appendToLog(chat.logPath, 'Client', 'Windows synthesis input.');
			simulateWindows();
			mockProcessManager.spawn.mockClear();

			await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: 'C:\\Tools\\pwsh.exe',
					runInShell: true,
					sendPromptViaStdin: true,
					sendPromptViaStdinRaw: false,
				})
			);
		});

		it('resets state when synthesis agent config is missing', async () => {
			const chat = await createTestChatWithModerator('Missing Synthesis Agent Test');
			groupChatEmitters.emitStateChange = vi.fn();
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce(null as never);
			mockProcessManager.spawn.mockClear();

			await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

			expect(groupChatEmitters.emitStateChange).toHaveBeenCalledWith(chat.id, 'idle');
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('uses Gemini command fallback and no-sandbox args for synthesis', async () => {
			const chat = await createTestChatWithModerator('Gemini Synthesis Test');
			await updateGroupChat(chat.id, { moderatorAgentId: 'gemini-cli' });
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce({
				id: 'gemini-cli',
				name: 'Gemini CLI',
				binaryName: 'gemini',
				command: 'gemini',
				args: ['--json'],
				available: true,
				capabilities: {},
				promptArgs: ['--prompt'],
				readOnlyCliEnforced: true,
			});
			mockProcessManager.spawn.mockClear();

			await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					toolType: 'gemini-cli',
					command: 'gemini',
					args: expect.arrayContaining(['--no-sandbox']),
					readOnlyMode: true,
				})
			);
		});

		it('handles SSH-wrapped synthesis when no remote record is returned', async () => {
			const sshRemoteConfig = {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/user/project',
			};
			const chat = await createGroupChat('SSH Synthesis No Remote Used Test', 'claude-code', {
				sshRemoteConfig,
			});
			createdChats.push(chat.id);
			await spawnModerator(chat, mockProcessManager);
			await appendToLog(chat.logPath, 'Client', 'Synthesis input.');
			setSshStore({
				getSshRemotes: vi.fn().mockReturnValue([]),
			});
			mockWrapSpawnWithSsh.mockResolvedValueOnce({
				command: 'ssh',
				args: ['claude', '--print'],
				cwd: '/home/user/project',
				prompt: 'remote synthesis prompt',
				customEnvVars: {},
			});
			mockProcessManager.spawn.mockClear();

			await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					cwd: '/home/user/project',
					prompt: 'remote synthesis prompt',
				})
			);
		});
	});

	describe('respawnParticipantWithRecovery', () => {
		it('respawns a participant with recovery context, read-only mode, cwd, and env vars', async () => {
			const chat = await createTestChatWithModerator('Recovery Respawn Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			await appendToLog(chat.logPath, 'user', 'Please recover the prior work.');
			await appendToLog(chat.logPath, 'Client', 'Prior conclusion from Client.');
			setGroupChatReadOnlyState(chat.id, true);
			setGetSessionsCallback(() => [
				{
					id: 'client-session',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/repo/client',
					customEnvVars: { SESSION_ENV: 'ignored-when-callback-present' },
				},
			]);
			setGetCustomEnvVarsCallback((agentId) =>
				agentId === 'claude-code' ? { RECOVERY_ENV: 'enabled' } : undefined
			);
			groupChatEmitters.emitParticipantState = vi.fn();
			mockProcessManager.spawn.mockClear();

			await respawnParticipantWithRecovery(
				chat.id,
				'Client',
				mockProcessManager,
				mockAgentDetector
			);

			expect(groupChatEmitters.emitParticipantState).toHaveBeenCalledWith(
				chat.id,
				'Client',
				'working'
			);
			expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
			const spawnConfig = mockProcessManager.spawn.mock.calls[0][0];
			expect(spawnConfig.sessionId).toContain(`group-chat-${chat.id}-participant-Client-recovery-`);
			expect(spawnConfig.cwd).toBe('/repo/client');
			expect(spawnConfig.readOnlyMode).toBe(true);
			expect(spawnConfig.customEnvVars).toEqual({
				SESSION_ENV: 'ignored-when-callback-present',
			});
			expect(spawnConfig.prompt).toContain('Session Recovery Context');
			expect(spawnConfig.prompt).toContain('Prior conclusion from Client.');
			expect(spawnConfig.prompt).toContain('READ-ONLY MODE');
			expect(spawnConfig.prompt).toContain('Please continue from where you left off');
		});

		it('applies Windows shell config to recovery participant spawns', async () => {
			const chat = await createTestChatWithModerator('Windows Recovery Respawn Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			await appendToLog(chat.logPath, 'Client', 'Prior Windows conclusion.');
			setGetSessionsCallback(() => [
				{
					id: 'client-session',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/repo/client',
				},
			]);
			simulateWindows();
			mockProcessManager.spawn.mockClear();

			await respawnParticipantWithRecovery(
				chat.id,
				'Client',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					shell: 'C:\\Tools\\pwsh.exe',
					runInShell: true,
					sendPromptViaStdin: true,
					sendPromptViaStdinRaw: false,
				})
			);
		});

		it('uses fallback cwd, command, and read-write mode when recovery has no session match', async () => {
			const chat = await createTestChatWithModerator('Recovery Fallback Spawn Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			await appendToLog(chat.logPath, 'user', 'R'.repeat(520));
			await appendToLog(chat.logPath, 'Client', 'Prior fallback conclusion.');
			setGetSessionsCallback(() => null as never);
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce({
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: ['--print'],
				available: true,
				capabilities: {},
				promptArgs: ['--prompt'],
			});
			mockProcessManager.spawn.mockClear();

			await respawnParticipantWithRecovery(
				chat.id,
				'Client',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'claude',
					cwd: os.homedir(),
					readOnlyMode: false,
					prompt: expect.stringContaining('Prior fallback conclusion.'),
				})
			);
		});

		it('handles SSH-wrapped recovery when no remote record is returned', async () => {
			const sshRemoteConfig = {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/user/project',
			};
			const chat = await createTestChatWithModerator('Recovery SSH No Remote Used Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			await appendToLog(chat.logPath, 'Client', 'Prior remote conclusion.');
			setGetSessionsCallback(() => [
				{
					id: 'client-session',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/home/user/project',
					sshRemoteConfig,
				},
			]);
			setSshStore({
				getSshRemotes: vi.fn().mockReturnValue([]),
			});
			mockWrapSpawnWithSsh.mockResolvedValueOnce({
				command: 'ssh',
				args: ['claude', '--print'],
				cwd: '/home/user/project',
				prompt: 'remote recovery prompt',
				customEnvVars: {},
			});
			mockProcessManager.spawn.mockClear();

			await respawnParticipantWithRecovery(
				chat.id,
				'Client',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					cwd: '/home/user/project',
					prompt: 'remote recovery prompt',
				})
			);
		});

		it('throws when recovery chat, participant, or agent cannot be resolved', async () => {
			await expect(
				respawnParticipantWithRecovery(
					'missing-chat',
					'Client',
					mockProcessManager,
					mockAgentDetector
				)
			).rejects.toThrow('Group chat not found');

			const chat = await createTestChatWithModerator('Recovery Missing Participant Test');
			await expect(
				respawnParticipantWithRecovery(chat.id, 'Missing', mockProcessManager, mockAgentDetector)
			).rejects.toThrow('Participant not found: Missing');

			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			vi.mocked(mockAgentDetector.getAgent).mockResolvedValueOnce({
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: [],
				available: false,
				path: '/usr/local/bin/claude',
				capabilities: {},
			});

			await expect(
				respawnParticipantWithRecovery(chat.id, 'Client', mockProcessManager, mockAgentDetector)
			).rejects.toThrow('Agent not available: claude-code');
		});
	});

	// ===========================================================================
	// Test 5.5: routeAgentResponse logs and notifies moderator
	// ===========================================================================
	describe('routeAgentResponse', () => {
		it('logs agent response', async () => {
			const chat = await createTestChatWithModerator('Agent Response Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			await routeAgentResponse(chat.id, 'Client', 'Done implementing the form', mockProcessManager);

			// Should be in log
			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'Client')).toBe(true);
			expect(messages.some((m) => m.content === 'Done implementing the form')).toBe(true);
		});

		it('logs message with participant name as sender', async () => {
			const chat = await createTestChatWithModerator('Sender Name Test');
			await addParticipant(chat.id, 'Backend', 'claude-code', mockProcessManager);

			await routeAgentResponse(chat.id, 'Backend', 'API endpoint created', mockProcessManager);

			const messages = await readLog(chat.logPath);
			const agentMessage = messages.find((m) => m.from === 'Backend');
			expect(agentMessage).toBeDefined();
			expect(agentMessage?.content).toBe('API endpoint created');
		});

		it('does not notify moderator via process manager write', async () => {
			const chat = await createTestChatWithModerator('Format Test');
			await addParticipant(chat.id, 'Frontend', 'claude-code', mockProcessManager);

			mockProcessManager.write.mockClear();

			await routeAgentResponse(chat.id, 'Frontend', 'Component ready', mockProcessManager);

			expect(mockProcessManager.write).not.toHaveBeenCalled();
		});

		it('throws for non-existent chat', async () => {
			await expect(
				routeAgentResponse('non-existent-id', 'Client', 'Hello', mockProcessManager)
			).rejects.toThrow(/not found/i);
		});

		it('throws for unknown participant', async () => {
			const chat = await createTestChatWithModerator('Unknown Agent Test');

			await expect(
				routeAgentResponse(chat.id, 'Unknown', 'Hello', mockProcessManager)
			).rejects.toThrow(/not found/i);
		});

		it('works without process manager (log only)', async () => {
			const chat = await createTestChatWithModerator('Log Only Agent Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			mockProcessManager.write.mockClear();

			// No process manager - should still log
			await routeAgentResponse(chat.id, 'Client', 'Log only response');

			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'Client' && m.content === 'Log only response')).toBe(
				true
			);
		});

		it('handles multiple responses from same agent', async () => {
			const chat = await createTestChatWithModerator('Multi Response Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			await routeAgentResponse(chat.id, 'Client', 'First message', mockProcessManager);
			await routeAgentResponse(chat.id, 'Client', 'Second message', mockProcessManager);

			const messages = await readLog(chat.logPath);
			const clientMessages = messages.filter((m) => m.from === 'Client');
			expect(clientMessages).toHaveLength(2);
		});

		it('emits and logs long agent response previews without truncating stored content', async () => {
			const chat = await createTestChatWithModerator('Long Agent Response Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			const longMessage = `${'A'.repeat(220)} final detail`;
			groupChatEmitters.emitMessage = vi.fn();

			await routeAgentResponse(chat.id, 'Client', longMessage, mockProcessManager);

			expect(groupChatEmitters.emitMessage).toHaveBeenCalledWith(
				chat.id,
				expect.objectContaining({
					from: 'Client',
					content: longMessage,
				})
			);
			const messages = await readLog(chat.logPath);
			expect(messages.some((m) => m.from === 'Client' && m.content === longMessage)).toBe(true);
		});

		it('continues agent response flow when participant stats update fails', async () => {
			const chat = await createTestChatWithModerator('Agent Stats Failure Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			let shouldFailRename = true;
			mockFsPromiseFaults.rename = (oldPath) => {
				if (shouldFailRename && String(oldPath).endsWith('metadata.json.tmp')) {
					shouldFailRename = false;
					return new Error('metadata rename failed');
				}
				return undefined;
			};

			await routeAgentResponse(
				chat.id,
				'Client',
				'Stats update should fail but response should be logged.',
				mockProcessManager
			);

			const messages = await readLog(chat.logPath);
			expect(
				messages.some((m) => m.from === 'Client' && m.content.includes('Stats update should fail'))
			).toBe(true);
		});

		it('continues agent response flow when adding a participant history entry fails', async () => {
			const chat = await createTestChatWithModerator('Agent History Failure Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);
			mockFsPromiseFaults.appendFile = (file) =>
				String(file).endsWith('history.jsonl')
					? new Error('participant history write failed')
					: undefined;

			await routeAgentResponse(
				chat.id,
				'Client',
				'History update should fail but response should be logged.',
				mockProcessManager
			);

			const messages = await readLog(chat.logPath);
			expect(
				messages.some(
					(m) => m.from === 'Client' && m.content.includes('History update should fail')
				)
			).toBe(true);
		});
	});

	// ===========================================================================
	// Test 5.6: Read-only mode propagation
	// ===========================================================================
	describe('read-only mode propagation', () => {
		it('moderator spawns with readOnlyMode: true', async () => {
			const chat = await createTestChatWithModerator('Moderator ReadOnly Test');

			await routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector);

			// Moderator should always be spawned with readOnlyMode: true
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					readOnlyMode: true,
				})
			);
		});

		it('includes READ-ONLY MODE in prompt when readOnly flag is set', async () => {
			const chat = await createTestChatWithModerator('ReadOnly Prompt Test');

			await routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector, true);

			// Prompt should include READ-ONLY MODE indicator
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: expect.stringContaining('READ-ONLY MODE'),
				})
			);
		});

		it('logs message with readOnly flag when set', async () => {
			const chat = await createTestChatWithModerator('ReadOnly Log Test');

			await routeUserMessage(
				chat.id,
				'Read-only message',
				mockProcessManager,
				mockAgentDetector,
				true
			);

			const messages = await readLog(chat.logPath);
			const userMessage = messages.find((m) => m.from === 'user');
			expect(userMessage).toBeDefined();
			expect(userMessage?.readOnly).toBe(true);
		});

		it('stores readOnly state for the group chat', async () => {
			const chat = await createTestChatWithModerator('ReadOnly State Test');

			// Initially should be false
			expect(getGroupChatReadOnlyState(chat.id)).toBe(false);

			// After sending read-only message, state should be true
			await routeUserMessage(
				chat.id,
				'Read-only message',
				mockProcessManager,
				mockAgentDetector,
				true
			);
			expect(getGroupChatReadOnlyState(chat.id)).toBe(true);

			// After sending non-read-only message, state should be false
			await routeUserMessage(
				chat.id,
				'Normal message',
				mockProcessManager,
				mockAgentDetector,
				false
			);
			expect(getGroupChatReadOnlyState(chat.id)).toBe(false);
		});

		it('does not include READ-ONLY MODE in prompt when readOnly flag is not set', async () => {
			const chat = await createTestChatWithModerator('No ReadOnly Prompt Test');

			await routeUserMessage(
				chat.id,
				'Normal message',
				mockProcessManager,
				mockAgentDetector,
				false
			);

			// Prompt should NOT include READ-ONLY MODE indicator
			const spawnCall = mockProcessManager.spawn.mock.calls.find((call) =>
				call[0].prompt?.includes('Normal message')
			);
			expect(spawnCall).toBeDefined();
			expect(spawnCall?.[0].prompt).not.toContain('READ-ONLY MODE');
		});

		it('participants spawn with readOnlyMode matching the readOnly flag', async () => {
			const chat = await createTestChatWithModerator('Participant ReadOnly Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			// Clear spawn mock to only capture the participant batch spawn
			mockProcessManager.spawn.mockClear();

			// This should trigger participant batch process with readOnly propagated
			await routeModeratorResponse(
				chat.id,
				'@Client: Please analyze this code',
				mockProcessManager,
				mockAgentDetector,
				true // readOnly flag
			);

			// Participant should be spawned with readOnlyMode matching the flag
			const participantSpawnCall = mockProcessManager.spawn.mock.calls.find((call) =>
				call[0].sessionId?.includes('participant')
			);
			expect(participantSpawnCall).toBeDefined();
			expect(participantSpawnCall?.[0].readOnlyMode).toBe(true);
		});

		it('participants spawn with readOnlyMode: false when readOnly is not set', async () => {
			const chat = await createTestChatWithModerator('Participant No ReadOnly Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			// Clear spawn mock to only capture the participant batch spawn
			mockProcessManager.spawn.mockClear();

			// This should trigger participant batch process without readOnly
			await routeModeratorResponse(
				chat.id,
				'@Client: Please implement this feature',
				mockProcessManager,
				mockAgentDetector
				// no readOnly flag = false
			);

			// Participant should be spawned with readOnlyMode: false
			const participantSpawnCall = mockProcessManager.spawn.mock.calls.find((call) =>
				call[0].sessionId?.includes('participant')
			);
			expect(participantSpawnCall).toBeDefined();
			expect(participantSpawnCall?.[0].readOnlyMode).toBe(false);
		});

		it('auto-added participants are only started once for a moderator handoff', async () => {
			const chat = await createTestChatWithModerator('Auto Add Single Spawn Test');
			setGetSessionsCallback(() => [
				{
					id: 'session-client',
					name: 'Client',
					toolType: 'claude-code',
					cwd: '/tmp/project',
				},
			]);

			await routeModeratorResponse(
				chat.id,
				'@Client: Please create the requested file',
				mockProcessManager,
				mockAgentDetector
			);

			const participantSpawns = mockProcessManager.spawn.mock.calls.filter((call) =>
				call[0].sessionId?.includes(`group-chat-${chat.id}-participant-Client-`)
			);
			expect(participantSpawns).toHaveLength(1);
		});
	});

	// ===========================================================================
	// Edge cases and integration scenarios
	// ===========================================================================
	describe('edge cases', () => {
		it('handles full message flow', async () => {
			const chat = await createTestChatWithModerator('Full Flow Test');
			await addParticipant(chat.id, 'Dev', 'claude-code', mockProcessManager);

			// User message
			await routeUserMessage(
				chat.id,
				'Please help me build a feature',
				mockProcessManager,
				mockAgentDetector
			);

			// Moderator response
			await routeModeratorResponse(chat.id, '@Dev: Build the feature', mockProcessManager);

			// Agent response
			await routeAgentResponse(chat.id, 'Dev', 'Feature built!', mockProcessManager);

			const messages = await readLog(chat.logPath);
			expect(messages.filter((m) => m.from === 'user')).toHaveLength(1);
			expect(messages.filter((m) => m.from === 'moderator')).toHaveLength(1);
			expect(messages.filter((m) => m.from === 'Dev')).toHaveLength(1);
		});

		it('handles special characters in messages', async () => {
			const chat = await createTestChatWithModerator('Special Char Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			await routeUserMessage(
				chat.id,
				'Message with pipes | and newlines\nand more',
				mockProcessManager,
				mockAgentDetector
			);

			const messages = await readLog(chat.logPath);
			const userMessage = messages.find((m) => m.from === 'user');
			expect(userMessage?.content).toBe('Message with pipes | and newlines\nand more');
		});

		it('handles concurrent routing', async () => {
			const chat = await createTestChatWithModerator('Concurrent Test');
			await addParticipant(chat.id, 'Agent1', 'claude-code', mockProcessManager);
			await addParticipant(chat.id, 'Agent2', 'claude-code', mockProcessManager);

			// Send multiple messages concurrently
			await Promise.all([
				routeAgentResponse(chat.id, 'Agent1', 'Response 1', mockProcessManager),
				routeAgentResponse(chat.id, 'Agent2', 'Response 2', mockProcessManager),
			]);

			const messages = await readLog(chat.logPath);
			expect(messages.filter((m) => m.from === 'Agent1' || m.from === 'Agent2')).toHaveLength(2);
		});
	});

	// ===========================================================================
	// Test 5.7: SSH remote execution for group chat participants
	// ===========================================================================
	describe('SSH remote participant support', () => {
		const sshRemoteConfig = {
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/home/user/project',
		};

		const mockSshStore = {
			getSshRemotes: vi
				.fn()
				.mockReturnValue([
					{ id: 'remote-1', name: 'PedTome', host: 'pedtome.local', user: 'user' },
				]),
		};

		beforeEach(() => {
			// Configure the SSH wrapping mock to return transformed spawn config
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['-t', 'user@pedtome.local', 'claude', '--print'],
				cwd: '/home/user/project',
				prompt: 'test prompt',
				customEnvVars: {},
				sshRemoteUsed: { name: 'PedTome' },
			});
		});

		afterEach(() => {
			// Clear the module-level callbacks after SSH tests
			setGetSessionsCallback(() => []);
			mockWrapSpawnWithSsh.mockReset();
		});

		it('user-mention auto-add stores SSH participant metadata without spawning yet', async () => {
			const chat = await createTestChatWithModerator('SSH User Mention Test');

			// Set up a session with SSH config that the router can discover
			const sshSession: SessionInfo = {
				id: 'ses-ssh-1',
				name: 'RemoteAgent',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				sshRemoteName: 'PedTome',
				sshRemoteConfig,
			};
			setGetSessionsCallback(() => [sshSession]);
			setSshStore(mockSshStore);

			// User mentions @RemoteAgent - this should auto-add with SSH config
			await routeUserMessage(
				chat.id,
				'@RemoteAgent: please help',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
			const updatedChat = await loadGroupChat(chat.id);
			expect(updatedChat?.participants).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: 'RemoteAgent',
						sshRemoteName: 'PedTome',
					}),
				])
			);
		});

		it('moderator-mention participant spawn applies SSH wrapping', async () => {
			const chat = await createTestChatWithModerator('SSH Moderator Mention Test');

			// Set up session with SSH config
			const sshSession: SessionInfo = {
				id: 'ses-ssh-2',
				name: 'SSHWorker',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				sshRemoteName: 'PedTome',
				sshRemoteConfig,
			};
			setGetSessionsCallback(() => [sshSession]);
			setSshStore(mockSshStore);

			// Add the participant (this triggers SSH wrapping during spawn)
			await addParticipant(
				chat.id,
				'SSHWorker',
				'claude-code',
				mockProcessManager,
				'/home/user/project',
				mockAgentDetector,
				{},
				undefined,
				{ sshRemoteName: 'PedTome', sshRemoteConfig },
				mockSshStore
			);

			mockWrapSpawnWithSsh.mockClear();

			// Moderator mentions the SSH participant - batch spawn should use SSH wrapping
			await routeModeratorResponse(
				chat.id,
				'@SSHWorker: implement the feature',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
				expect.objectContaining({
					command: expect.any(String),
					agentBinaryName: 'claude',
				}),
				sshRemoteConfig,
				mockSshStore
			);
		});

		it('uses SSH participant spawn output when the remote record is omitted', async () => {
			const chat = await createTestChatWithModerator('SSH Participant No Remote Record Test');
			const sshSession: SessionInfo = {
				id: 'ses-ssh-no-remote',
				name: 'SSHWorker',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				sshRemoteName: 'PedTome',
				sshRemoteConfig,
			};
			setGetSessionsCallback(() => [sshSession]);
			setSshStore(mockSshStore);

			await addParticipant(
				chat.id,
				'SSHWorker',
				'claude-code',
				mockProcessManager,
				'/home/user/project',
				mockAgentDetector,
				{},
				undefined,
				{ sshRemoteName: 'PedTome', sshRemoteConfig },
				mockSshStore
			);

			mockWrapSpawnWithSsh.mockClear();
			mockProcessManager.spawn.mockClear();
			mockWrapSpawnWithSsh.mockResolvedValueOnce({
				command: 'ssh',
				args: ['-t', 'user@pedtome.local', 'claude', '--print'],
				cwd: '/home/user/project',
				prompt: 'remote participant prompt',
				customEnvVars: { REMOTE_EXECUTION: '1' },
			});

			await routeModeratorResponse(
				chat.id,
				'@SSHWorker: implement the remote feature',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					args: ['-t', 'user@pedtome.local', 'claude', '--print'],
					cwd: '/home/user/project',
					prompt: 'remote participant prompt',
					customEnvVars: { REMOTE_EXECUTION: '1' },
				})
			);
		});

		it('does not apply SSH wrapping for non-SSH sessions', async () => {
			const chat = await createTestChatWithModerator('No SSH Test');

			// Session without SSH config
			const localSession: SessionInfo = {
				id: 'ses-local-1',
				name: 'LocalAgent',
				toolType: 'claude-code',
				cwd: '/Users/dev/project',
			};
			setGetSessionsCallback(() => [localSession]);
			setSshStore(mockSshStore);

			await routeUserMessage(
				chat.id,
				'@LocalAgent: help please',
				mockProcessManager,
				mockAgentDetector
			);

			// SSH wrapper should NOT be called for local sessions
			expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
		});

		it('participant recovery spawn applies SSH wrapping from the matching session', async () => {
			const chat = await createTestChatWithModerator('SSH Recovery Test');
			await addParticipant(chat.id, 'SSHWorker', 'claude-code', mockProcessManager);
			await appendToLog(chat.logPath, 'SSHWorker', 'Remote work summary.');
			const sshSession: SessionInfo = {
				id: 'ses-ssh-recovery',
				name: 'SSHWorker',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				sshRemoteName: 'PedTome',
				sshRemoteConfig,
			};
			setGetSessionsCallback(() => [sshSession]);
			setSshStore(mockSshStore);
			mockProcessManager.spawn.mockClear();

			await respawnParticipantWithRecovery(
				chat.id,
				'SSHWorker',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
				expect.objectContaining({
					command: expect.any(String),
					cwd: '/home/user/project',
					agentBinaryName: 'claude',
				}),
				sshRemoteConfig,
				mockSshStore
			);
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					args: ['-t', 'user@pedtome.local', 'claude', '--print'],
					cwd: '/home/user/project',
					prompt: 'test prompt',
				})
			);
		});

		it('moderator synthesis applies SSH wrapping from moderator config', async () => {
			const chat = await createGroupChat('SSH Synthesis Test', 'claude-code', {
				sshRemoteConfig,
			});
			createdChats.push(chat.id);
			await spawnModerator(chat, mockProcessManager);
			await addParticipant(chat.id, 'SSHWorker', 'claude-code', mockProcessManager);
			await appendToLog(chat.logPath, 'SSHWorker', 'Remote work is complete.');
			setSshStore(mockSshStore);
			mockWrapSpawnWithSsh.mockClear();
			mockProcessManager.spawn.mockClear();

			await spawnModeratorSynthesis(chat.id, mockProcessManager, mockAgentDetector);

			expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
				expect.objectContaining({
					command: '/usr/local/bin/claude',
					agentBinaryName: 'claude',
					prompt: expect.stringContaining('Remote work is complete.'),
				}),
				sshRemoteConfig,
				mockSshStore
			);
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					command: 'ssh',
					cwd: '/home/user/project',
					prompt: 'test prompt',
				})
			);
		});
	});

	// ===========================================================================
	// Global shell env vars from Settings → Shell Configuration must flow into
	// moderator / participant spawns for the local path, and must be merged into
	// customEnvVars (per-agent takes precedence) for the SSH path so they reach
	// the remote agent via the SSH stdin script.
	// ===========================================================================
	describe('global shell env vars forwarded to spawns', () => {
		it('moderator spawn receives globally-configured shellEnvVars', async () => {
			mockedShellEnvVars = { ANTHROPIC_API_KEY: 'sentinel-moderator-key' };
			const chat = await createTestChatWithModerator('Moderator ShellEnv Test');

			await routeUserMessage(chat.id, 'Hello', mockProcessManager, mockAgentDetector);

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					shellEnvVars: { ANTHROPIC_API_KEY: 'sentinel-moderator-key' },
				})
			);
		});

		it('participant spawn receives globally-configured shellEnvVars', async () => {
			mockedShellEnvVars = { ANTHROPIC_API_KEY: 'sentinel-participant-key' };
			const chat = await createTestChatWithModerator('Participant ShellEnv Test');
			await addParticipant(chat.id, 'Client', 'claude-code', mockProcessManager);

			mockProcessManager.spawn.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@Client please help',
				mockProcessManager,
				mockAgentDetector
			);

			const participantSpawn = mockProcessManager.spawn.mock.calls.find((call) =>
				call[0].prompt?.includes('please help')
			);
			expect(participantSpawn).toBeDefined();
			expect(participantSpawn![0]).toEqual(
				expect.objectContaining({
					shellEnvVars: { ANTHROPIC_API_KEY: 'sentinel-participant-key' },
				})
			);
		});

		it('SSH participant spawn merges shellEnvVars into customEnvVars with per-agent precedence', async () => {
			// SSH wrapper strips customEnvVars after embedding them into the remote script,
			// so assertions target the INPUT to wrapSpawnWithSsh - that's where globals must land.
			mockedShellEnvVars = {
				ANTHROPIC_API_KEY: 'sentinel-global-key',
				GLOBAL_ONLY: 'global-value',
			};

			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['user@pedtome.local', 'claude', '--print'],
				cwd: '/home/user/project',
				prompt: 'test prompt',
				customEnvVars: undefined,
				sshRemoteUsed: { name: 'PedTome' },
			});
			const mockSshStore = {
				getSshRemotes: vi
					.fn()
					.mockReturnValue([
						{ id: 'remote-1', name: 'PedTome', host: 'pedtome.local', user: 'user' },
					]),
			};
			const sshRemoteConfig = {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/home/user/project',
			};

			const chat = await createTestChatWithModerator('SSH Participant ShellEnv Test');

			// Session-level override: should win over the global sentinel for the same key.
			const sshSession: SessionInfo = {
				id: 'ses-ssh-shellenv',
				name: 'SSHWorker',
				toolType: 'claude-code',
				cwd: '/home/user/project',
				sshRemoteName: 'PedTome',
				sshRemoteConfig,
				customEnvVars: { ANTHROPIC_API_KEY: 'per-agent-override' },
			};
			setGetSessionsCallback(() => [sshSession]);
			setSshStore(mockSshStore);

			await addParticipant(
				chat.id,
				'SSHWorker',
				'claude-code',
				mockProcessManager,
				'/home/user/project',
				mockAgentDetector,
				{},
				undefined,
				{ sshRemoteName: 'PedTome', sshRemoteConfig },
				mockSshStore
			);

			mockWrapSpawnWithSsh.mockClear();

			await routeModeratorResponse(
				chat.id,
				'@SSHWorker implement the feature',
				mockProcessManager,
				mockAgentDetector
			);

			expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
				expect.objectContaining({
					customEnvVars: {
						GLOBAL_ONLY: 'global-value',
						ANTHROPIC_API_KEY: 'per-agent-override',
					},
				}),
				sshRemoteConfig,
				mockSshStore
			);

			mockWrapSpawnWithSsh.mockReset();
		});
	});
});
