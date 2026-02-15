/**
 * Tests for usage listener.
 * Handles token/cost statistics from AI responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupUsageListener } from '../usage-listener';
import type { ProcessManager } from '../../process-manager';
import type { UsageStats } from '../types';

describe('Usage Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockDeps: Parameters<typeof setupUsageListener>[1];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	const createMockUsageStats = (overrides: Partial<UsageStats> = {}): UsageStats => ({
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadInputTokens: 200,
		cacheCreationInputTokens: 100,
		totalCostUsd: 0.05,
		contextWindow: 100000,
		...overrides,
	});

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
				emitModeratorUsage: vi.fn(),
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
			usageAggregator: {
				calculateContextTokens: vi.fn().mockReturnValue(1800),
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
		setupUsageListener(mockProcessManager, mockDeps);
	};

	describe('Event Registration', () => {
		it('should register the usage event listener', () => {
			setupListener();
			expect(mockProcessManager.on).toHaveBeenCalledWith('usage', expect.any(Function));
		});
	});

	describe('Regular Process Usage', () => {
		it('should forward usage stats to renderer', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('regular-session-123', usageStats);

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:usage',
				'regular-session-123',
				usageStats
			);
		});
	});

	describe('Participant Usage', () => {
		beforeEach(() => {
			mockDeps.outputParser.parseParticipantSessionId = vi.fn().mockReturnValue({
				groupChatId: 'test-chat-123',
				participantName: 'TestAgent',
			});
		});

		it('should update participant with usage stats', async () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatStorage.updateParticipant).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					expect.objectContaining({
						contextUsage: expect.any(Number),
						tokenCount: 1800,
						totalCost: 0.05,
					})
				);
			});
		});

		it('should calculate context usage percentage correctly', async () => {
			mockDeps.usageAggregator.calculateContextTokens = vi.fn().mockReturnValue(50000); // 50% of 100000
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats({ contextWindow: 100000 });

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatStorage.updateParticipant).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					expect.objectContaining({
						contextUsage: 50,
					})
				);
			});
		});

		it('should handle zero context window gracefully', async () => {
			// When contextWindow is 0, it falls back to 200000 default
			// With calculateContextTokens returning 1800, expect (1800/200000)*100 = ~1%
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats({ contextWindow: 0 });

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatStorage.updateParticipant).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					expect.objectContaining({
						contextUsage: 1, // 1800/200000 * 100 = 0.9%, rounded to 1%
					})
				);
			});
		});

		it('should emit participants changed after update', async () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitParticipantsChanged).toHaveBeenCalledWith(
					'test-chat-123',
					expect.any(Array)
				);
			});
		});

		it('should use updateParticipant return value instead of loading chat again (DB caching)', async () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

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
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

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
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

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
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			// Should not throw
			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatStorage.updateParticipant).toHaveBeenCalled();
			});
			// No error should be logged for the optional emitter
			expect(mockDeps.logger.error).not.toHaveBeenCalled();
		});

		it('should log error when participant update fails', async () => {
			mockDeps.groupChatStorage.updateParticipant = vi
				.fn()
				.mockRejectedValue(new Error('DB error'));
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

			await vi.waitFor(() => {
				expect(mockDeps.logger.error).toHaveBeenCalledWith(
					'[GroupChat] Failed to update participant usage',
					'ProcessListener',
					expect.objectContaining({
						error: 'Error: DB error',
						participant: 'TestAgent',
					})
				);
			});
		});

		it('should still forward to renderer for participant usage', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-participant-TestAgent-abc123', usageStats);

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:usage',
				'group-chat-test-chat-123-participant-TestAgent-abc123',
				usageStats
			);
		});
	});

	describe('Moderator Usage', () => {
		it('should emit moderator usage for moderator sessions', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-moderator-1234567890', usageStats);

			expect(mockDeps.groupChatEmitters.emitModeratorUsage).toHaveBeenCalledWith(
				'test-chat-123',
				expect.objectContaining({
					contextUsage: expect.any(Number),
					totalCost: 0.05,
					tokenCount: 1800,
				})
			);
		});

		it('should calculate moderator context usage correctly', () => {
			mockDeps.usageAggregator.calculateContextTokens = vi.fn().mockReturnValue(25000); // 25% of 100000
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats({ contextWindow: 100000 });

			handler?.('group-chat-test-chat-123-moderator-1234567890', usageStats);

			expect(mockDeps.groupChatEmitters.emitModeratorUsage).toHaveBeenCalledWith(
				'test-chat-123',
				expect.objectContaining({
					contextUsage: 25,
				})
			);
		});

		it('should still forward to renderer for moderator usage', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-moderator-1234567890', usageStats);

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:usage',
				'group-chat-test-chat-123-moderator-1234567890',
				usageStats
			);
		});

		it('should handle synthesis moderator sessions', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			handler?.('group-chat-test-chat-123-moderator-synthesis-1234567890', usageStats);

			expect(mockDeps.groupChatEmitters.emitModeratorUsage).toHaveBeenCalledWith(
				'test-chat-123',
				expect.any(Object)
			);
		});
	});

	describe('Usage with Reasoning Tokens', () => {
		it('should handle usage stats with reasoning tokens', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats({ reasoningTokens: 1000 });

			handler?.('regular-session-123', usageStats);

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:usage',
				'regular-session-123',
				expect.objectContaining({ reasoningTokens: 1000 })
			);
		});
	});

	describe('Performance Optimization', () => {
		it('should skip participant parsing for non-group-chat sessions (prefix check)', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			// Regular session ID doesn't start with 'group-chat-'
			handler?.('regular-session-123', usageStats);

			// parseParticipantSessionId should NOT be called for non-group-chat sessions
			expect(mockDeps.outputParser.parseParticipantSessionId).not.toHaveBeenCalled();
		});

		it('should only parse participant session ID for group-chat sessions', () => {
			mockDeps.outputParser.parseParticipantSessionId = vi.fn().mockReturnValue(null);
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			// Group chat session ID starts with 'group-chat-'
			handler?.('group-chat-test-123-participant-Agent-abc', usageStats);

			// parseParticipantSessionId SHOULD be called for group-chat sessions
			expect(mockDeps.outputParser.parseParticipantSessionId).toHaveBeenCalledWith(
				'group-chat-test-123-participant-Agent-abc'
			);
		});

		it('should skip moderator regex for non-group-chat sessions', () => {
			setupListener();
			const handler = eventHandlers.get('usage');
			const usageStats = createMockUsageStats();

			// Process many non-group-chat sessions - should be fast since regex is skipped
			for (let i = 0; i < 100; i++) {
				handler?.(`regular-session-${i}`, usageStats);
			}

			// Moderator usage should NOT be emitted for any regular sessions
			expect(mockDeps.groupChatEmitters.emitModeratorUsage).not.toHaveBeenCalled();
			// But all should still forward to renderer
			expect(mockDeps.safeSend).toHaveBeenCalledTimes(100);
		});
	});
});
