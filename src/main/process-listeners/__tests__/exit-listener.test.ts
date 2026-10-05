/**
 * Tests for exit listener.
 * Handles process exit events including group chat moderator/participant exits.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupExitListener } from '../exit-listener';
import type { ProcessManager } from '../../process-manager';
import type { ProcessListenerDependencies } from '../types';

describe('Exit Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockDeps: Parameters<typeof setupExitListener>[1];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	// The launcher the listener hands the engine; the listener only passes it through
	const mockLauncher = {
		runner: { start: vi.fn(), stop: vi.fn() },
		resolveAgent: vi.fn(),
	};

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
			groupChatEngine: {
				turnEnded: vi.fn().mockResolvedValue(undefined),
			} as never,
			groupChatLauncherFor: vi.fn().mockReturnValue(mockLauncher),
			groupChatStorage: {
				loadGroupChat: vi.fn().mockResolvedValue(createMockGroupChat()),
				updateGroupChat: vi.fn().mockResolvedValue(createMockGroupChat()),
				updateParticipant: vi.fn().mockResolvedValue(createMockGroupChat()),
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
				REGEX_AI_SUFFIX: /-ai-.+$/,
				REGEX_AI_TAB_ID: /-ai-(.+?)(?:-fp-\d+)?$/,
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

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:exit',
				'regular-session-123',
				0,
				undefined
			);
		});

		it('should forward the kill signal to the renderer when the process was signalled', () => {
			setupListener();
			const handler = eventHandlers.get('exit');

			handler?.('regular-session-123', 0, 9);

			expect(mockDeps.safeSend).toHaveBeenCalledWith('process:exit', 'regular-session-123', 0, 9);
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

	describe('Group Chat Cross-Domain Containment', () => {
		// Regression: if a sessionId starts with GROUP_CHAT_PREFIX but does NOT
		// match either the moderator branch or the participant-parse branch,
		// the exit handler MUST drop it - never forwarding to process:exit,
		// never broadcasting to web clients, and never calling
		// cueEngine.notifyAgentCompleted. Otherwise a mis-shaped group-chat
		// sessionId leaks into the regular exit channel and fires Cue's
		// agent.completed subscriptions spuriously with group-chat provenance.
		it('drops unrecognized group-chat session exit without forwarding or notifying Cue', () => {
			const notifyAgentCompleted = vi.fn();
			const hasCompletionSubscribers = vi.fn().mockReturnValue(true);
			mockDeps = {
				...mockDeps,
				isCueEnabled: () => true,
				getCueEngine: () =>
					({
						notifyAgentCompleted,
						hasCompletionSubscribers,
					}) as unknown as ReturnType<NonNullable<ProcessListenerDependencies['getCueEngine']>>,
			};
			// parseParticipantSessionId returns null → participant branch skipped.
			// The sessionId has no "-moderator-" → moderator branch skipped.
			mockDeps.outputParser.parseParticipantSessionId = vi.fn().mockReturnValue(null);

			setupListener();
			const handler = eventHandlers.get('exit');

			handler?.('group-chat-something-unrecognized', 0);

			expect(mockDeps.safeSend).not.toHaveBeenCalled();
			expect(notifyAgentCompleted).not.toHaveBeenCalled();
			expect(hasCompletionSubscribers).not.toHaveBeenCalled();
		});

		it('notifies Cue for regular (non-group-chat) session exit', () => {
			const notifyAgentCompleted = vi.fn();
			const hasCompletionSubscribers = vi.fn().mockReturnValue(true);
			mockDeps = {
				...mockDeps,
				isCueEnabled: () => true,
				getCueEngine: () =>
					({
						notifyAgentCompleted,
						hasCompletionSubscribers,
					}) as unknown as ReturnType<NonNullable<ProcessListenerDependencies['getCueEngine']>>,
			};

			setupListener();
			const handler = eventHandlers.get('exit');

			handler?.('plain-session-xyz', 0);

			expect(mockDeps.safeSend).toHaveBeenCalledWith(
				'process:exit',
				'plain-session-xyz',
				0,
				undefined
			);
			expect(notifyAgentCompleted).toHaveBeenCalledWith('plain-session-xyz', {
				status: 'completed',
				exitCode: 0,
			});
		});

		it('passes only status+exitCode to Cue (no stdout leakage path)', () => {
			// Defensive: the exit-listener call shape is the load-bearing
			// invariant behind the "no stdout fallback" audit in cue-engine.ts.
			// If this test fails because someone added a stdout field, the
			// corresponding cue-completion-chains regression test must also be
			// updated.
			const notifyAgentCompleted = vi.fn();
			const hasCompletionSubscribers = vi.fn().mockReturnValue(true);
			mockDeps = {
				...mockDeps,
				isCueEnabled: () => true,
				getCueEngine: () =>
					({
						notifyAgentCompleted,
						hasCompletionSubscribers,
					}) as unknown as ReturnType<NonNullable<ProcessListenerDependencies['getCueEngine']>>,
			};

			setupListener();
			const handler = eventHandlers.get('exit');

			handler?.('plain-session-xyz', 1);

			expect(notifyAgentCompleted).toHaveBeenCalledTimes(1);
			const [, completionData] = notifyAgentCompleted.mock.calls[0];
			expect(Object.keys(completionData).sort()).toEqual(['exitCode', 'status']);
			expect(completionData.stdout).toBeUndefined();
		});
	});

	// The listener's half of a group chat turn is reading the process's buffered output
	// and reporting the finished turn to the engine. What the turn means (routing,
	// recovery, marking, synthesis) is the engine's, and is tested with it in
	// `src/shared/maestro-lib/groupchat/__tests__/router.test.ts`.
	describe('Group chat turns', () => {
		const PARTICIPANT_SESSION = 'group-chat-test-chat-123-participant-TestAgent-abc123';
		const MODERATOR_SESSION = 'group-chat-test-chat-123-moderator-1234567890';
		const turnEnded = () => mockDeps.groupChatEngine.turnEnded as ReturnType<typeof vi.fn>;

		beforeEach(() => {
			mockDeps.outputParser.parseParticipantSessionId = vi.fn((id: string) =>
				id === PARTICIPANT_SESSION
					? { groupChatId: 'test-chat-123', participantName: 'TestAgent' }
					: null
			);
		});

		it('reports a moderator exit to the engine with its buffered output and exit code', () => {
			setupListener();
			eventHandlers.get('exit')?.(MODERATOR_SESSION, 0);

			expect(turnEnded()).toHaveBeenCalledTimes(1);
			const [end, launcher] = turnEnded().mock.calls[0];
			expect(end).toEqual({
				processId: MODERATOR_SESSION,
				rawOutput: '{"type":"text","text":"test output"}',
				readText: expect.any(Function),
				exitCode: 0,
			});
			expect(launcher).toBe(mockLauncher);
		});

		it('reports a participant exit to the engine the same way', () => {
			setupListener();
			eventHandlers.get('exit')?.(PARTICIPANT_SESSION, 0);

			expect(turnEnded()).toHaveBeenCalledTimes(1);
			expect(turnEnded().mock.calls[0][0]).toEqual({
				processId: PARTICIPANT_SESSION,
				rawOutput: '{"type":"text","text":"test output"}',
				readText: expect.any(Function),
				exitCode: 0,
			});
		});

		it('handles a synthesis moderator session like any moderator turn', () => {
			setupListener();
			const sessionId = 'group-chat-test-chat-123-moderator-synthesis-1234567890';
			eventHandlers.get('exit')?.(sessionId, 0);

			expect(turnEnded().mock.calls[0][0].processId).toBe(sessionId);
		});

		it('carries a non-zero exit code to the engine and never decides on it', () => {
			setupListener();
			eventHandlers.get('exit')?.(PARTICIPANT_SESSION, 137);

			// B1: whether a participant responded is "did any text come back", so the
			// listener reports the turn whatever the code was
			expect(turnEnded().mock.calls[0][0].exitCode).toBe(137);
		});

		it('reads the buffered output with the parser the engine picks for the agent', () => {
			setupListener();
			eventHandlers.get('exit')?.(PARTICIPANT_SESSION, 0);

			const { readText } = turnEnded().mock.calls[0][0];
			expect(readText('claude-code')).toBe('parsed response');
			expect(mockDeps.outputParser.extractTextFromStreamJson).toHaveBeenCalledWith(
				'{"type":"text","text":"test output"}',
				'claude-code'
			);
			expect(readText(undefined)).toBe('parsed response');
			expect(mockDeps.outputParser.extractTextFromStreamJson).toHaveBeenLastCalledWith(
				'{"type":"text","text":"test output"}',
				undefined
			);
		});

		it('reports an empty buffer as no output at all, without parsing anything', () => {
			mockDeps.outputBuffer.getGroupChatBufferedOutput = vi.fn().mockReturnValue(undefined);
			setupListener();
			eventHandlers.get('exit')?.(MODERATOR_SESSION, 0);

			const [end] = turnEnded().mock.calls[0];
			expect(end.rawOutput).toBe('');
			expect(end.readText('claude-code')).toBe('');
			expect(mockDeps.outputParser.extractTextFromStreamJson).not.toHaveBeenCalled();
		});

		it('hands the engine no launcher when the process manager or detector is missing', () => {
			(mockDeps.groupChatLauncherFor as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
			setupListener();
			eventHandlers.get('exit')?.(PARTICIPANT_SESSION, 0);

			expect(mockDeps.groupChatLauncherFor).toHaveBeenCalledWith(
				mockProcessManager,
				expect.anything()
			);
			expect(turnEnded().mock.calls[0][1]).toBeUndefined();
		});

		it('releases the buffer only after the engine is done with the turn', async () => {
			let finish: () => void = () => {};
			turnEnded().mockReturnValue(
				new Promise<void>((resolve) => {
					finish = resolve;
				})
			);
			setupListener();
			eventHandlers.get('exit')?.(PARTICIPANT_SESSION, 0);

			// Recovery and routing both read the buffer, so it must outlive the engine call
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(mockDeps.outputBuffer.clearGroupChatBuffer).not.toHaveBeenCalled();

			finish();
			await vi.waitFor(() => {
				expect(mockDeps.outputBuffer.clearGroupChatBuffer).toHaveBeenCalledWith(
					PARTICIPANT_SESSION
				);
			});
		});

		it('logs, reports, and still releases the buffer when the engine rejects', async () => {
			turnEnded().mockRejectedValue(new Error('engine blew up'));
			setupListener();
			eventHandlers.get('exit')?.(MODERATOR_SESSION, 0);

			await vi.waitFor(() => {
				expect(mockDeps.logger.error).toHaveBeenCalledWith(
					'[GroupChat] Failed to report group chat turn',
					'ProcessListener',
					expect.objectContaining({ sessionId: MODERATOR_SESSION })
				);
				expect(mockDeps.outputBuffer.clearGroupChatBuffer).toHaveBeenCalledWith(MODERATOR_SESSION);
			});
		});

		it('does not forward a group chat exit to the renderer or the web clients', () => {
			setupListener();
			eventHandlers.get('exit')?.(PARTICIPANT_SESSION, 0);
			eventHandlers.get('exit')?.(MODERATOR_SESSION, 0);

			expect(mockDeps.safeSend).not.toHaveBeenCalled();
		});
	});
});
