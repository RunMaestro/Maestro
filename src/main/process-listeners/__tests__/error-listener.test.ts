/**
 * Tests for error listener.
 * Handles agent errors (auth expired, token exhaustion, rate limits, etc.).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupErrorListener } from '../error-listener';
import type { ProcessManager } from '../../process-manager';
import type { SafeSendFn } from '../../utils/safe-send';
import type { AgentError } from '../../../shared/types';
import type { ProcessListenerDependencies } from '../types';

describe('Error Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockSafeSend: SafeSendFn;
	let mockLogger: ProcessListenerDependencies['logger'];
	let mockFlushPendingData: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockSafeSend = vi.fn();
		mockFlushPendingData = vi.fn();
		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	it('should register the agent-error event listener', () => {
		setupErrorListener(
			mockProcessManager,
			{ safeSend: mockSafeSend, logger: mockLogger },
			mockFlushPendingData
		);

		expect(mockProcessManager.on).toHaveBeenCalledWith('agent-error', expect.any(Function));
	});

	it('should log agent error and forward to renderer', () => {
		setupErrorListener(
			mockProcessManager,
			{ safeSend: mockSafeSend, logger: mockLogger },
			mockFlushPendingData
		);

		const handler = eventHandlers.get('agent-error');
		const testSessionId = 'test-session-123';
		const testAgentError: AgentError = {
			type: 'auth_expired',
			agentId: 'claude-code',
			message: 'Authentication token has expired',
			recoverable: true,
			timestamp: Date.now(),
		};

		handler?.(testSessionId, testAgentError);

		expect(mockLogger.info).toHaveBeenCalledWith(
			'Agent error detected: auth_expired',
			'AgentError',
			expect.objectContaining({
				sessionId: testSessionId,
				agentId: 'claude-code',
				errorType: 'auth_expired',
				message: 'Authentication token has expired',
				recoverable: true,
			})
		);

		expect(mockSafeSend).toHaveBeenCalledWith('agent:error', testSessionId, testAgentError);
	});

	// The renderer reads output that lands after an error as the agent having
	// recovered and erases the error, so the output the turn produced has to be
	// released before the error is sent.
	it("releases the session's buffered output before forwarding the error", () => {
		setupErrorListener(
			mockProcessManager,
			{ safeSend: mockSafeSend, logger: mockLogger },
			mockFlushPendingData
		);

		const testAgentError: AgentError = {
			type: 'auth_expired',
			agentId: 'claude-code',
			message: 'Authentication failed',
			recoverable: true,
			timestamp: Date.now(),
		};

		eventHandlers.get('agent-error')?.('session-1-ai-tab-1', testAgentError);

		expect(mockFlushPendingData).toHaveBeenCalledTimes(1);
		expect(mockFlushPendingData).toHaveBeenCalledWith('session-1-ai-tab-1');
		expect(mockFlushPendingData.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(mockSafeSend).mock.invocationCallOrder[0]
		);
	});

	it('should handle token exhaustion errors', () => {
		setupErrorListener(
			mockProcessManager,
			{ safeSend: mockSafeSend, logger: mockLogger },
			mockFlushPendingData
		);

		const handler = eventHandlers.get('agent-error');
		const testSessionId = 'session-456';
		const testAgentError: AgentError = {
			type: 'token_exhaustion',
			agentId: 'codex',
			message: 'Token limit exceeded',
			recoverable: false,
			timestamp: Date.now(),
		};

		handler?.(testSessionId, testAgentError);

		expect(mockSafeSend).toHaveBeenCalledWith('agent:error', testSessionId, testAgentError);
	});

	it('should handle rate limit errors', () => {
		setupErrorListener(
			mockProcessManager,
			{ safeSend: mockSafeSend, logger: mockLogger },
			mockFlushPendingData
		);

		const handler = eventHandlers.get('agent-error');
		const testSessionId = 'session-789';
		const testAgentError: AgentError = {
			type: 'rate_limited',
			agentId: 'opencode',
			message: 'Rate limit exceeded, retry after 60 seconds',
			recoverable: true,
			timestamp: Date.now(),
		};

		handler?.(testSessionId, testAgentError);

		expect(mockLogger.info).toHaveBeenCalledWith(
			'Agent error detected: rate_limited',
			'AgentError',
			expect.objectContaining({
				sessionId: testSessionId,
				errorType: 'rate_limited',
			})
		);

		expect(mockSafeSend).toHaveBeenCalledWith('agent:error', testSessionId, testAgentError);
	});
});
