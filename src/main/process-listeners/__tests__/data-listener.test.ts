/**
 * Tests for data listener.
 * Handles process output data including group chat buffering and web broadcasting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDataListener } from '../data-listener';
import type { ProcessManager } from '../../process-manager';
import type { SafeSendFn } from '../../utils/safe-send';
import type { ProcessListenerDependencies } from '../types';

describe('Data Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockSafeSend: SafeSendFn;
	let mockGetWebServer: ProcessListenerDependencies['getWebServer'];
	let mockWebServer: { broadcastToSessionClients: ReturnType<typeof vi.fn> };
	let mockOutputBuffer: ProcessListenerDependencies['outputBuffer'];
	let mockOutputParser: ProcessListenerDependencies['outputParser'];
	let mockDebugLog: ProcessListenerDependencies['debugLog'];
	let mockPatterns: ProcessListenerDependencies['patterns'];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockSafeSend = vi.fn();
		mockWebServer = {
			broadcastToSessionClients: vi.fn(),
		};
		mockGetWebServer = vi.fn().mockReturnValue(mockWebServer);
		mockOutputBuffer = {
			appendToGroupChatBuffer: vi.fn().mockReturnValue(100),
			getGroupChatBufferedOutput: vi.fn().mockReturnValue('test output'),
			clearGroupChatBuffer: vi.fn(),
		};
		mockOutputParser = {
			extractTextFromStreamJson: vi.fn().mockReturnValue('parsed response'),
			parseParticipantSessionId: vi.fn().mockReturnValue(null),
		};
		mockDebugLog = vi.fn();
		mockPatterns = {
			REGEX_MODERATOR_SESSION: /^group-chat-(.+)-moderator-/,
			REGEX_MODERATOR_SESSION_TIMESTAMP: /^group-chat-(.+)-moderator-\d+$/,
			REGEX_AI_SUFFIX: /-ai-.+$/,
			REGEX_AI_TAB_ID: /-ai-(.+)$/,
			REGEX_BATCH_SESSION: /-batch-\d+$/,
			REGEX_SYNOPSIS_SESSION: /-synopsis-\d+$/,
		};

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	const setupListener = () => {
		setupDataListener(mockProcessManager, {
			safeSend: mockSafeSend,
			getWebServer: mockGetWebServer,
			outputBuffer: mockOutputBuffer,
			outputParser: mockOutputParser,
			debugLog: mockDebugLog,
			patterns: mockPatterns,
		});
	};

	describe('Event Registration', () => {
		it('should register the data event listener', () => {
			setupListener();
			expect(mockProcessManager.on).toHaveBeenCalledWith('data', expect.any(Function));
		});
	});

	describe('Regular Process Data', () => {
		it('should forward data to renderer for non-group-chat sessions', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('regular-session-123', 'test output');

			expect(mockSafeSend).toHaveBeenCalledWith(
				'process:data',
				'regular-session-123',
				'test output'
			);
		});

		it('should broadcast to web clients for AI sessions with UUID tab IDs', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('51cee651-6629-4de8-abdd-1c1540555f2d-ai-73aaeb23-6673-45a4-8fdf-c769802f79bb', 'test output');

			expect(mockWebServer.broadcastToSessionClients).toHaveBeenCalledWith(
				'51cee651-6629-4de8-abdd-1c1540555f2d',
				expect.objectContaining({
					type: 'session_output',
					sessionId: '51cee651-6629-4de8-abdd-1c1540555f2d',
					tabId: '73aaeb23-6673-45a4-8fdf-c769802f79bb',
					data: 'test output',
					source: 'ai',
				})
			);
		});

		it('should extract base session ID correctly from UUID format', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('a053b4b3-95af-46cc-aaa4-3d37785038be-ai-66fc905c-3062-4192-9a84-d239af5fc826', 'test output');

			expect(mockWebServer.broadcastToSessionClients).toHaveBeenCalledWith(
				'a053b4b3-95af-46cc-aaa4-3d37785038be',
				expect.objectContaining({
					sessionId: 'a053b4b3-95af-46cc-aaa4-3d37785038be',
					tabId: '66fc905c-3062-4192-9a84-d239af5fc826',
				})
			);
		});
	});

	describe('Moderator Output Buffering', () => {
		it('should buffer moderator output instead of forwarding', () => {
			setupListener();
			const handler = eventHandlers.get('data');
			const sessionId = 'group-chat-test-chat-123-moderator-abc123';

			handler?.(sessionId, 'moderator output');

			expect(mockOutputBuffer.appendToGroupChatBuffer).toHaveBeenCalledWith(
				sessionId,
				'moderator output'
			);
			expect(mockSafeSend).not.toHaveBeenCalled();
		});

		it('should extract group chat ID from moderator session', () => {
			setupListener();
			const handler = eventHandlers.get('data');
			const sessionId = 'group-chat-my-chat-id-moderator-12345';

			handler?.(sessionId, 'test');

			expect(mockDebugLog).toHaveBeenCalledWith(
				'GroupChat:Debug',
				expect.stringContaining('my-chat-id')
			);
		});

		it('should warn when buffer size exceeds limit', () => {
			mockOutputBuffer.appendToGroupChatBuffer = vi.fn().mockReturnValue(15 * 1024 * 1024); // 15MB
			setupListener();
			const handler = eventHandlers.get('data');
			const sessionId = 'group-chat-test-chat-123-moderator-abc123';

			handler?.(sessionId, 'large output');

			expect(mockDebugLog).toHaveBeenCalledWith(
				'GroupChat:Debug',
				expect.stringContaining('WARNING: Buffer size')
			);
		});
	});

	describe('Participant Output Buffering', () => {
		beforeEach(() => {
			mockOutputParser.parseParticipantSessionId = vi.fn().mockReturnValue({
				groupChatId: 'test-chat-123',
				participantName: 'TestAgent',
			});
		});

		it('should buffer participant output instead of forwarding', () => {
			setupListener();
			const handler = eventHandlers.get('data');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 'participant output');

			expect(mockOutputBuffer.appendToGroupChatBuffer).toHaveBeenCalledWith(
				sessionId,
				'participant output'
			);
			expect(mockSafeSend).not.toHaveBeenCalled();
		});

		it('should warn when participant buffer size exceeds limit', () => {
			mockOutputBuffer.appendToGroupChatBuffer = vi.fn().mockReturnValue(15 * 1024 * 1024); // 15MB
			setupListener();
			const handler = eventHandlers.get('data');
			const sessionId = 'group-chat-test-chat-123-participant-TestAgent-abc123';

			handler?.(sessionId, 'large output');

			expect(mockDebugLog).toHaveBeenCalledWith(
				'GroupChat:Debug',
				expect.stringContaining('WARNING: Buffer size')
			);
		});
	});

	describe('Web Broadcast Filtering', () => {
		it('should skip PTY terminal output', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('session-123-terminal', 'terminal output');

			expect(mockWebServer.broadcastToSessionClients).not.toHaveBeenCalled();
			// But should still forward to renderer
			expect(mockSafeSend).toHaveBeenCalledWith(
				'process:data',
				'session-123-terminal',
				'terminal output'
			);
		});

		it('should skip batch session output using regex pattern', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('session-123-batch-1234567890', 'batch output');

			expect(mockWebServer.broadcastToSessionClients).not.toHaveBeenCalled();
		});

		it('should skip synopsis session output using regex pattern', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('session-123-synopsis-1234567890', 'synopsis output');

			expect(mockWebServer.broadcastToSessionClients).not.toHaveBeenCalled();
		});

		it('should NOT skip sessions with "batch" in UUID (false positive prevention)', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			// Session ID with "batch" in the UUID but not matching the pattern -batch-{digits}
			handler?.('session-batch-uuid-ai-a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'output');

			// Should broadcast because it doesn't match the -batch-\d+$ pattern
			expect(mockWebServer.broadcastToSessionClients).toHaveBeenCalled();
		});

		it('should broadcast when no web server is available', () => {
			mockGetWebServer = vi.fn().mockReturnValue(null);
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('session-123-ai-a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'test output');

			// Should still forward to renderer
			expect(mockSafeSend).toHaveBeenCalledWith(
				'process:data',
				'session-123-ai-a1b2c3d4-e5f6-7890-abcd-ef1234567890',
				'test output'
			);
			// But not broadcast (no web server)
			expect(mockWebServer.broadcastToSessionClients).not.toHaveBeenCalled();
		});
	});

	describe('Message ID Generation', () => {
		it('should generate unique message IDs for broadcasts', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('session-123-ai-a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'output 1');
			handler?.('session-123-ai-a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'output 2');

			const calls = mockWebServer.broadcastToSessionClients.mock.calls;
			const msgId1 = calls[0][1].msgId;
			const msgId2 = calls[1][1].msgId;

			expect(msgId1).toBeDefined();
			expect(msgId2).toBeDefined();
			expect(msgId1).not.toBe(msgId2);
		});

		it('should include timestamp in message ID', () => {
			const beforeTime = Date.now();
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('session-123-ai-a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'test output');

			const msgId = mockWebServer.broadcastToSessionClients.mock.calls[0][1].msgId;
			const timestamp = parseInt(msgId.split('-')[0], 10);

			expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
			expect(timestamp).toBeLessThanOrEqual(Date.now());
		});
	});

	describe('Source Detection', () => {
		it('should identify AI source from session ID', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('session-123-ai-a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'ai output');

			expect(mockWebServer.broadcastToSessionClients).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ source: 'ai' })
			);
		});

		it('should identify terminal source for non-AI sessions', () => {
			setupListener();
			const handler = eventHandlers.get('data');

			handler?.('session-123', 'terminal output');

			expect(mockWebServer.broadcastToSessionClients).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ source: 'terminal' })
			);
		});
	});
});
