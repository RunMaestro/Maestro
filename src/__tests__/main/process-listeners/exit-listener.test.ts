/**
 * Tests for exit listener.
 * Handles process exit events including group chat moderator/participant exits.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupExitListener } from '../../../main/process-listeners/exit-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';

describe('Exit Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockDeps: Parameters<typeof setupExitListener>[1];
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
			powerManager: {
				addBlockReason: vi.fn(),
				removeBlockReason: vi.fn(),
			},
			groupChatEmitters: {
				emitStateChange: vi.fn(),
				emitParticipantState: vi.fn(),
				emitParticipantsChanged: vi.fn(),
				emitModeratorUsage: vi.fn(),
			},
			groupChatRouter: {
				routeModeratorResponse: vi.fn().mockResolvedValue(undefined),
				routeAgentResponse: vi.fn().mockResolvedValue(undefined),
				markParticipantResponded: vi.fn().mockResolvedValue(undefined),
				spawnModeratorSynthesis: vi.fn().mockResolvedValue(undefined),
				getGroupChatReadOnlyState: vi.fn().mockReturnValue(false),
				respawnParticipantWithRecovery: vi.fn().mockResolvedValue(undefined),
			},
			groupChatStorage: {
				loadGroupChat: vi.fn().mockResolvedValue(createMockGroupChat()),
				updateGroupChat: vi.fn().mockResolvedValue(createMockGroupChat()),
				updateParticipant: vi.fn().mockResolvedValue(createMockGroupChat()),
			},
			sessionRecovery: {
				needsSessionRecovery: vi.fn().mockReturnValue(false),
				initiateSessionRecovery: vi.fn().mockResolvedValue(true),
			},
			outputBuffer: {
				appendToGroupChatBuffer: vi.fn().mockReturnValue(100),
				getGroupChatBufferedOutput: vi.fn().mockReturnValue('{"type":"text","text":"test output"}'),
				clearGroupChatBuffer: vi.fn(),
			},
			outputParser: {
				extractTextFromStreamJson: vi.fn().mockReturnValue('parsed response'),
				parseParticipantSessionId: vi.fn().mockReturnValue(null),
			},
			getProcessManager: () => mockProcessManager,
			getAgentDetector: () =>
				({
					detectAgents: vi.fn(),
				}) as unknown as ReturnType<ProcessListenerDependencies['getAgentDetector']>,
			getWebServer: () => null,
			logger: {
				info: vi.fn(),
				error: vi.fn(),
				warn: vi.fn(),
				debug: vi.fn(),
			},
			debugLog: vi.fn(),
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
		setupExitListener(mockProcessManager, mockDeps);
	};

	describe('Event Registration', () => {
		it('should register the exit event listener', () => {
			setupListener();
			expect(mockProcessManager.on).toHaveBeenCalledWith('exit', expect.any(Function));
		});
	});

	describe('Regular Process Exit', () => {
		it('should forward exit event to renderer for non-group-chat sessions', () => {
			setupListener();
			const handler = eventHandlers.get('exit');

			handler?.('regular-session-123', 0);

			expect(mockDeps.safeSend).toHaveBeenCalledWith('process:exit', 'regular-session-123', 0);
		});

		it('should remove power block for non-group-chat sessions', () => {
			setupListener();
			const handler = eventHandlers.get('exit');

			handler?.('regular-session-123', 0);

			expect(mockDeps.powerManager.removeBlockReason).toHaveBeenCalledWith(
				'session:regular-session-123'
			);
		});
	});

	describe('Participant Exit', () => {
		beforeEach(() => {
			mockDeps.outputParser.parseParticipantSessionId = vi.fn().mockReturnValue({
				groupChatId: 'test-chat-123',
				participantName: 'TestAgent',
			});
		});

		it('should parse and route participant response on exit', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.routeAgentResponse).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					'parsed response',
					expect.anything()
				);
			});
		});

		it('should mark participant as responded after successful routing', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.markParticipantResponded).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent'
				);
			});
		});

		it('should clear output buffer after processing', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.outputBuffer.clearGroupChatBuffer).toHaveBeenCalledWith(sessionId);
			});
		});

		it('should not route when buffered output is empty', async () => {
			mockDeps.outputBuffer.getGroupChatBufferedOutput = vi.fn().mockReturnValue('');
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			// Give async operations time to complete
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(mockDeps.groupChatRouter.routeAgentResponse).not.toHaveBeenCalled();
		});

		it('should not route when parsed text is empty', async () => {
			mockDeps.outputParser.extractTextFromStreamJson = vi.fn().mockReturnValue('   ');
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			// Give async operations time to complete
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(mockDeps.groupChatRouter.routeAgentResponse).not.toHaveBeenCalled();
		});
	});

	describe('Session Recovery', () => {
		beforeEach(() => {
			mockDeps.outputParser.parseParticipantSessionId = vi.fn().mockReturnValue({
				groupChatId: 'test-chat-123',
				participantName: 'TestAgent',
			});
			mockDeps.sessionRecovery.needsSessionRecovery = vi.fn().mockReturnValue(true);
		});

		it('should initiate session recovery when needed', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.sessionRecovery.initiateSessionRecovery).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent'
				);
			});
		});

		it('should respawn participant after recovery initiation', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.respawnParticipantWithRecovery).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					expect.anything(),
					expect.anything()
				);
			});
		});

		it('should clear buffer before initiating recovery', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.outputBuffer.clearGroupChatBuffer).toHaveBeenCalledWith(sessionId);
			});
		});

		it('should not mark participant as responded when recovery succeeds', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			// Wait for async operations
			await new Promise((resolve) => setTimeout(resolve, 50));

			// When recovery succeeds, markParticipantResponded should NOT be called
			// because the recovery spawn will handle that
			expect(mockDeps.groupChatRouter.markParticipantResponded).not.toHaveBeenCalled();
		});

		it('should mark participant as responded when recovery fails', async () => {
			mockDeps.groupChatRouter.respawnParticipantWithRecovery = vi
				.fn()
				.mockRejectedValue(new Error('Recovery failed'));
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.markParticipantResponded).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent'
				);
			});
		});
	});

	describe('Moderator Exit', () => {
		it('should route moderator response on exit', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.routeModeratorResponse).toHaveBeenCalledWith(
					'test-chat-123',
					'parsed response',
					expect.anything(),
					expect.anything(),
					false
				);
			});
		});

		it('should clear moderator buffer after processing', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.outputBuffer.clearGroupChatBuffer).toHaveBeenCalledWith(sessionId);
			});
		});

		it('should handle synthesis sessions correctly', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-synthesis-1234567890';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.routeModeratorResponse).toHaveBeenCalled();
			});
		});
	});

	describe('Error Handling', () => {
		beforeEach(() => {
			mockDeps.outputParser.parseParticipantSessionId = vi.fn().mockReturnValue({
				groupChatId: 'test-chat-123',
				participantName: 'TestAgent',
			});
		});

		it('should log error when routing fails', async () => {
			mockDeps.groupChatRouter.routeAgentResponse = vi
				.fn()
				.mockRejectedValue(new Error('Route failed'));
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.logger.error).toHaveBeenCalled();
			});
		});

		it('should attempt fallback parsing when primary parsing fails', async () => {
			// First call throws, second call (fallback) succeeds
			mockDeps.outputParser.extractTextFromStreamJson = vi
				.fn()
				.mockImplementationOnce(() => {
					throw new Error('Parse error');
				})
				.mockReturnValueOnce('fallback parsed response');

			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				// Should have been called twice: once with agentType, once without (fallback)
				expect(mockDeps.outputParser.extractTextFromStreamJson).toHaveBeenCalledTimes(2);
			});
		});

		it('should still mark participant as responded after routing error', async () => {
			mockDeps.groupChatRouter.routeAgentResponse = vi
				.fn()
				.mockRejectedValue(new Error('Route failed'));
			mockDeps.outputParser.extractTextFromStreamJson = vi
				.fn()
				.mockReturnValueOnce('parsed response')
				.mockReturnValueOnce('fallback response');

			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.markParticipantResponded).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent'
				);
			});
		});
	});
});
