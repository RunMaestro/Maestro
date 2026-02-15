/**
 * Tests for session ID listener.
 * Handles agent session ID storage for conversation resume.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupSessionIdListener } from '../session-id-listener';
import type { ProcessManager } from '../../process-manager';

describe('Session ID Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockDeps: Parameters<typeof setupSessionIdListener>[1];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	// Create a minimal mock group chat
	const createMockGroupChat = () => ({
		id: 'test-chat-123',
		name: 'Test Chat',
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'group-chat-test-chat-123-moderator',
		participants: [
			{
				name: 'TestAgent',
				agentId: 'claude-code',
				sessionId: 'group-chat-test-chat-123-participant-TestAgent-abc123',
				addedAt: Date.now(),
			},
		],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		logPath: '/tmp/test-chat.log',
		imagesDir: '/tmp/test-chat-images',
	});

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;

		mockDeps = {
			safeSend: vi.fn(),
			logger: {
				info: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn(),
			},
			groupChatEmitters: {
				emitParticipantsChanged: vi.fn(),
				emitModeratorSessionIdChanged: vi.fn(),
			},
			groupChatStorage: {
				loadGroupChat: vi.fn().mockResolvedValue(createMockGroupChat()),
				updateGroupChat: vi.fn().mockResolvedValue(createMockGroupChat()),
				updateParticipant: vi.fn().mockResolvedValue(createMockGroupChat()),
			},
			outputParser: {
				extractTextFromStreamJson: vi.fn().mockReturnValue('parsed response'),
				parseParticipantSessionId: vi.fn().mockReturnValue(null),
			},
			patterns: {
				REGEX_MODERATOR_SESSION: /^group-chat-(.+)-moderator-/,
				REGEX_MODERATOR_SESSION_TIMESTAMP: /^group-chat-(.+)-moderator-\d+$/,
				REGEX_AI_SUFFIX: /-ai-.+$/,
				REGEX_AI_TAB_ID: /-ai-(.+)$/,
				REGEX_BATCH_SESSION: /-batch-\d+$/,
				REGEX_SYNOPSIS_SESSION: /-synopsis-\d+$/,
			},
		};
	});

	const setupListener = () => {
		setupSessionIdListener(mockProcessManager, mockDeps);
	};

	describe('Event Registration', () => {
		it('should register the session-id event listener', () => {
			setupListener();
			expect(mockProcessManager.on).toHaveBeenCalledWith('session-id', expect.any(Function));
		});
	});

	describe('Regular Process Session ID', () => {
		it('should forward session ID to renderer', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('regular-session-123', 'agent-session-abc');

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				'regular-session-123',
				'agent-session-abc'
			);
		});
	});

	describe('Participant Session ID Storage', () => {
		beforeEach(() => {
			mockDeps.outputParser.parseParticipantSessionId = vi.fn().mockReturnValue({
				groupChatId: 'test-chat-123',
				participantName: 'TestAgent',
			});
		});

		it('should store agent session ID for participant', async () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', 'agent-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.groupChatStorage.updateParticipant).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					{ agentSessionId: 'agent-session-xyz' }
				);
			});
		});

		it('should emit participants changed after storage', async () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', 'agent-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitParticipantsChanged).toHaveBeenCalledWith(
					'test-chat-123',
					expect.any(Array)
				);
			});
		});

		it('should use updateParticipant return value instead of loading chat again (DB caching)', async () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', 'agent-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitParticipantsChanged).toHaveBeenCalled();
			});

			// Verify we didn't make a redundant loadGroupChat call
			// The code should use the return value from updateParticipant directly
			expect(mockDeps.groupChatStorage.loadGroupChat).not.toHaveBeenCalled();
		});

		it('should pass exact participants from updateParticipant return value', async () => {
			const specificParticipants = [
				{ name: 'Agent1', agentId: 'claude-code', sessionId: 'session-1', addedAt: 1000 },
				{ name: 'Agent2', agentId: 'codex', sessionId: 'session-2', addedAt: 2000 },
			];
			mockDeps.groupChatStorage.updateParticipant = vi.fn().mockResolvedValue({
				...createMockGroupChat(),
				participants: specificParticipants,
			});
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', 'agent-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitParticipantsChanged).toHaveBeenCalledWith(
					'test-chat-123',
					specificParticipants
				);
			});
		});

		it('should handle empty participants array from updateParticipant', async () => {
			mockDeps.groupChatStorage.updateParticipant = vi.fn().mockResolvedValue({
				...createMockGroupChat(),
				participants: [],
			});
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', 'agent-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitParticipantsChanged).toHaveBeenCalledWith(
					'test-chat-123',
					[]
				);
			});
		});

		it('should handle undefined emitParticipantsChanged gracefully (optional chaining)', async () => {
			mockDeps.groupChatEmitters.emitParticipantsChanged = undefined;
			setupListener();
			const handler = eventHandlers.get('session-id');

			// Should not throw
			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', 'agent-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.groupChatStorage.updateParticipant).toHaveBeenCalled();
			});
			// No error should be logged for the optional emitter
			expect(mockDeps.logger.error).not.toHaveBeenCalled();
		});

		it('should log error when storage fails', async () => {
			mockDeps.groupChatStorage.updateParticipant = vi
				.fn()
				.mockRejectedValue(new Error('DB error'));
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', 'agent-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.logger.error).toHaveBeenCalledWith(
					'[GroupChat] Failed to update participant agentSessionId',
					'ProcessListener',
					expect.objectContaining({
						error: 'Error: DB error',
						participant: 'TestAgent',
					})
				);
			});
		});

		it('should still forward to renderer after storage', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', 'agent-session-xyz');

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				'group-chat-test-chat-123-participant-TestAgent-abc123',
				'agent-session-xyz'
			);
		});
	});

	describe('Moderator Session ID Storage', () => {
		it('should store agent session ID for moderator', async () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-moderator-1234567890', 'moderator-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.groupChatStorage.updateGroupChat).toHaveBeenCalledWith('test-chat-123', {
					moderatorAgentSessionId: 'moderator-session-xyz',
				});
			});
		});

		it('should emit moderator session ID changed after storage', async () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-moderator-1234567890', 'moderator-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitModeratorSessionIdChanged).toHaveBeenCalledWith(
					'test-chat-123',
					'moderator-session-xyz'
				);
			});
		});

		it('should log error when moderator storage fails', async () => {
			mockDeps.groupChatStorage.updateGroupChat = vi.fn().mockRejectedValue(new Error('DB error'));
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-moderator-1234567890', 'moderator-session-xyz');

			await vi.waitFor(() => {
				expect(mockDeps.logger.error).toHaveBeenCalledWith(
					'[GroupChat] Failed to update moderator agent session ID',
					'ProcessListener',
					expect.objectContaining({
						error: 'Error: DB error',
						groupChatId: 'test-chat-123',
					})
				);
			});
		});

		it('should still forward to renderer for moderator sessions', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('group-chat-test-chat-123-moderator-1234567890', 'moderator-session-xyz');

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				'group-chat-test-chat-123-moderator-1234567890',
				'moderator-session-xyz'
			);
		});

		it('should NOT store for synthesis moderator sessions (different pattern)', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			// Synthesis session ID doesn't match REGEX_MODERATOR_SESSION_TIMESTAMP
			// because it has 'synthesis' in it: group-chat-xxx-moderator-synthesis-timestamp
			handler?.('group-chat-test-chat-123-moderator-synthesis-1234567890', 'synthesis-session-xyz');

			// Should NOT call updateGroupChat for synthesis sessions (doesn't match timestamp pattern)
			expect(mockDeps.groupChatStorage.updateGroupChat).not.toHaveBeenCalled();
		});
	});

	describe('Session ID Format Handling', () => {
		it('should handle empty agent session ID', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('regular-session-123', '');

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				'regular-session-123',
				''
			);
		});

		it('should handle UUID format session IDs', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			handler?.('regular-session-123', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				'regular-session-123',
				'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
			);
		});

		it('should handle long session IDs', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');
			const longSessionId = 'a'.repeat(500);

			handler?.('regular-session-123', longSessionId);

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:session-id',
				'regular-session-123',
				longSessionId
			);
		});
	});

	describe('Performance Optimization', () => {
		it('should skip participant parsing for non-group-chat sessions (prefix check)', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			// Regular session ID doesn't start with 'group-chat-'
			handler?.('regular-session-123', 'agent-session-abc');

			// parseParticipantSessionId should NOT be called for non-group-chat sessions
			expect(mockDeps.outputParser.parseParticipantSessionId).not.toHaveBeenCalled();
		});

		it('should only parse participant session ID for group-chat sessions', () => {
			mockDeps.outputParser.parseParticipantSessionId = vi.fn().mockReturnValue(null);
			setupListener();
			const handler = eventHandlers.get('session-id');

			// Group chat session ID starts with 'group-chat-'
			handler?.('group-chat-test-123-participant-Agent-abc', 'agent-session-xyz');

			// parseParticipantSessionId SHOULD be called for group-chat sessions
			expect(mockDeps.outputParser.parseParticipantSessionId).toHaveBeenCalledWith(
				'group-chat-test-123-participant-Agent-abc'
			);
		});

		it('should skip moderator regex for non-group-chat sessions', () => {
			setupListener();
			const handler = eventHandlers.get('session-id');

			// Process many non-group-chat sessions - should be fast since regex is skipped
			for (let i = 0; i < 100; i++) {
				handler?.(`regular-session-${i}`, `agent-session-${i}`);
			}

			// Neither storage method should be called for regular sessions
			expect(mockDeps.groupChatStorage.updateParticipant).not.toHaveBeenCalled();
			expect(mockDeps.groupChatStorage.updateGroupChat).not.toHaveBeenCalled();
			// But all should still forward to renderer
			expect(mockDeps.safeSend).toHaveBeenCalledTimes(100);
		});
	});
});
