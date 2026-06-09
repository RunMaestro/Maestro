/**
 * Tests for exit listener.
 * Handles process exit events including group chat moderator/participant exits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupExitListener } from '../exit-listener';
import type { ProcessManager } from '../../process-manager';
import type { ProcessListenerDependencies } from '../types';

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
}));

vi.mock('../../utils/sentry', () => ({
	captureException: sentryMocks.captureException,
}));

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
				emitMessage: vi.fn(),
			},
			groupChatRouter: {
				routeModeratorResponse: vi.fn().mockResolvedValue(undefined),
				routeAgentResponse: vi.fn().mockResolvedValue(undefined),
				markParticipantResponded: vi.fn().mockReturnValue(false),
				spawnModeratorSynthesis: vi.fn().mockResolvedValue(undefined),
				getGroupChatReadOnlyState: vi.fn().mockReturnValue(false),
				respawnParticipantWithRecovery: vi.fn().mockResolvedValue(undefined),
				clearActiveParticipantTaskSession: vi.fn(),
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

	afterEach(() => {
		vi.useRealTimers();
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

		it('should broadcast regular exits to web clients using the base session id', () => {
			const broadcastToSessionClients = vi.fn();
			mockDeps.getWebServer = () =>
				({
					broadcastToSessionClients,
				}) as unknown as ReturnType<ProcessListenerDependencies['getWebServer']>;
			setupListener();
			const handler = eventHandlers.get('exit');

			handler?.('session-123-ai-tab-456', 143);

			expect(broadcastToSessionClients).toHaveBeenCalledWith(
				'session-123',
				expect.objectContaining({
					type: 'session_exit',
					sessionId: 'session-123',
					exitCode: 143,
					timestamp: expect.any(Number),
				})
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

		it('should wait for other participants when this response is not the last one', async () => {
			mockDeps.groupChatRouter.markParticipantResponded = vi.fn().mockReturnValue(false);
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
			expect(mockDeps.groupChatRouter.spawnModeratorSynthesis).not.toHaveBeenCalled();
		});

		it('should spawn moderator synthesis when the last participant responds', async () => {
			mockDeps.groupChatRouter.markParticipantResponded = vi.fn().mockReturnValue(true);
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.spawnModeratorSynthesis).toHaveBeenCalledWith(
					'test-chat-123',
					mockProcessManager,
					expect.anything()
				);
			});
		});

		it('should report synthesis failures and reset the group chat to idle', async () => {
			const synthesisError = new Error('synthesis failed');
			mockDeps.groupChatRouter.markParticipantResponded = vi.fn().mockReturnValue(true);
			mockDeps.groupChatRouter.spawnModeratorSynthesis = vi.fn().mockRejectedValue(synthesisError);
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitStateChange).toHaveBeenCalledWith(
					'test-chat-123',
					'idle'
				);
			});
			expect(mockDeps.groupChatEmitters.emitMessage).toHaveBeenCalledWith(
				'test-chat-123',
				expect.objectContaining({
					from: 'system',
					content: expect.stringContaining('Synthesis failed'),
				})
			);
			expect(sentryMocks.captureException).toHaveBeenCalledWith(synthesisError, {
				operation: 'groupChat:spawnModeratorSynthesis',
				groupChatId: 'test-chat-123',
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

		it('should mark participant as responded when buffered output is unavailable', () => {
			mockDeps.outputBuffer.getGroupChatBufferedOutput = vi.fn().mockReturnValue(undefined);
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			expect(mockDeps.groupChatRouter.markParticipantResponded).toHaveBeenCalledWith(
				'test-chat-123',
				'TestAgent'
			);
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

		it('should route long buffered participant output without truncating parsed content', async () => {
			mockDeps.outputBuffer.getGroupChatBufferedOutput = vi.fn().mockReturnValue('x'.repeat(301));
			mockDeps.outputParser.extractTextFromStreamJson = vi
				.fn()
				.mockReturnValue('parsed long output');
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.routeAgentResponse).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					'parsed long output',
					expect.anything()
				);
			});
		});

		it('should route long participant output when chat metadata and process manager are unavailable', async () => {
			const parsedText = 'p'.repeat(201);
			mockDeps.groupChatStorage.loadGroupChat = vi.fn().mockResolvedValue(null);
			mockDeps.getProcessManager = () => null;
			mockDeps.outputParser.extractTextFromStreamJson = vi.fn().mockReturnValue(parsedText);
			mockDeps.groupChatRouter.markParticipantResponded = vi.fn().mockReturnValue(true);
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.routeAgentResponse).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					parsedText,
					undefined
				);
			});
			expect(mockDeps.groupChatRouter.spawnModeratorSynthesis).not.toHaveBeenCalled();
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

		it('should mark participant as responded when recovery dependencies are unavailable', async () => {
			mockDeps.getProcessManager = () => null;
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
			expect(mockDeps.groupChatRouter.respawnParticipantWithRecovery).not.toHaveBeenCalled();
		});

		it('should emit recovery system message when recovery starts', async () => {
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitMessage).toHaveBeenCalledWith(
					'test-chat-123',
					expect.objectContaining({
						from: 'system',
						content: expect.stringContaining('Creating a new session'),
					})
				);
			});
		});

		it('should emit failure message when recovery fails', async () => {
			mockDeps.groupChatRouter.respawnParticipantWithRecovery = vi
				.fn()
				.mockRejectedValue(new Error('Recovery failed'));
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatEmitters.emitMessage).toHaveBeenCalledWith(
					'test-chat-123',
					expect.objectContaining({
						from: 'system',
						content: expect.stringContaining('Failed to create new session'),
					})
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

		it('should retry a transient moderator chat load failure before routing', async () => {
			vi.useFakeTimers();
			mockDeps.groupChatStorage.loadGroupChat = vi
				.fn()
				.mockRejectedValueOnce(new Error('temporary read failure'))
				.mockResolvedValueOnce(createMockGroupChat());
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatStorage.loadGroupChat).toHaveBeenCalledTimes(1);
			});
			await vi.advanceTimersByTimeAsync(100);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.routeModeratorResponse).toHaveBeenCalledWith(
					'test-chat-123',
					'parsed response',
					expect.anything(),
					expect.anything(),
					false
				);
			});
			expect(mockDeps.groupChatStorage.loadGroupChat).toHaveBeenCalledTimes(2);
			expect(mockDeps.logger.warn).toHaveBeenCalledWith(
				'[GroupChat] Chat load failed, retrying once',
				'ProcessListener',
				expect.objectContaining({
					groupChatId: 'test-chat-123',
				})
			);
		});

		it('should log and skip routing when moderator chat load fails after retry', async () => {
			vi.useFakeTimers();
			mockDeps.groupChatStorage.loadGroupChat = vi
				.fn()
				.mockRejectedValueOnce(new Error('first failure'))
				.mockRejectedValueOnce(new Error('second failure'));
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);
			await vi.advanceTimersByTimeAsync(100);

			await vi.waitFor(() => {
				expect(mockDeps.logger.error).toHaveBeenCalledWith(
					'[GroupChat] Failed to load chat for moderator output parsing after retry',
					'ProcessListener',
					expect.objectContaining({
						groupChatId: 'test-chat-123',
						parsedTextPreview: 'parsed response',
						parsedTextLength: 'parsed response'.length,
					})
				);
			});
			expect(mockDeps.groupChatRouter.routeModeratorResponse).not.toHaveBeenCalled();
		});

		it('should log route failures for moderator responses', async () => {
			mockDeps.groupChatRouter.routeModeratorResponse = vi
				.fn()
				.mockRejectedValue(new Error('moderator route failed'));
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.logger.error).toHaveBeenCalledWith(
					'[GroupChat] Failed to route moderator response',
					'ProcessListener',
					expect.objectContaining({
						error: 'Error: moderator route failed',
					})
				);
			});
		});

		it('should not route moderator responses when parsing returns empty text', async () => {
			mockDeps.outputParser.extractTextFromStreamJson = vi.fn().mockReturnValue('   ');
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.logger.warn).toHaveBeenCalledWith(
					'[GroupChat] Moderator output parsed to empty string',
					'ProcessListener',
					expect.objectContaining({
						groupChatId: 'test-chat-123',
					})
				);
			});
			expect(mockDeps.groupChatRouter.routeModeratorResponse).not.toHaveBeenCalled();
		});

		it('should warn and skip routing when moderator exits without buffered output', () => {
			mockDeps.outputBuffer.getGroupChatBufferedOutput = vi.fn().mockReturnValue(undefined);
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);

			expect(mockDeps.logger.warn).toHaveBeenCalledWith(
				'[GroupChat] Moderator exit with no buffered output',
				'ProcessListener',
				expect.objectContaining({
					groupChatId: 'test-chat-123',
					sessionId,
				})
			);
			expect(mockDeps.groupChatRouter.routeModeratorResponse).not.toHaveBeenCalled();
		});

		it('should route moderator output without chat metadata, process manager, or agent detector', async () => {
			const parsedText = 'm'.repeat(301);
			mockDeps.groupChatStorage.loadGroupChat = vi.fn().mockResolvedValue(null);
			mockDeps.getProcessManager = () => null;
			mockDeps.getAgentDetector = () => null;
			mockDeps.outputParser.extractTextFromStreamJson = vi.fn().mockReturnValue(parsedText);
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.routeModeratorResponse).toHaveBeenCalledWith(
					'test-chat-123',
					parsedText,
					undefined,
					undefined,
					false
				);
			});
		});

		it('should route long buffered moderator output without truncating parsed content', async () => {
			mockDeps.outputBuffer.getGroupChatBufferedOutput = vi.fn().mockReturnValue('x'.repeat(301));
			mockDeps.outputParser.extractTextFromStreamJson = vi
				.fn()
				.mockReturnValue('parsed moderator long output');
			setupListener();
			const handler = eventHandlers.get('exit');
			const sessionId = 'group-chat-test-chat-123-moderator-1234567890';

			handler?.(sessionId, 0);

			await vi.waitFor(() => {
				expect(mockDeps.groupChatRouter.routeModeratorResponse).toHaveBeenCalledWith(
					'test-chat-123',
					'parsed moderator long output',
					expect.anything(),
					expect.anything(),
					false
				);
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

		it('should route fallback parsed participant responses without a process manager', async () => {
			mockDeps.getProcessManager = () => null;
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
				expect(mockDeps.groupChatRouter.routeAgentResponse).toHaveBeenCalledWith(
					'test-chat-123',
					'TestAgent',
					'fallback parsed response',
					undefined
				);
			});
		});

		it('should mark participant as responded when fallback parsing returns empty text', async () => {
			mockDeps.outputParser.extractTextFromStreamJson = vi
				.fn()
				.mockImplementationOnce(() => {
					throw new Error('Parse error');
				})
				.mockReturnValueOnce('   ');

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
			expect(mockDeps.groupChatRouter.routeAgentResponse).not.toHaveBeenCalled();
		});
	});
});
