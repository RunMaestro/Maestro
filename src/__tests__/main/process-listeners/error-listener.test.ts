/**
 * Tests for error listener.
 * Handles agent errors (auth expired, token exhaustion, rate limits, etc.).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupErrorListener } from '../../../main/process-listeners/error-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { SafeSendFn } from '../../../main/utils/safe-send';
import type { AgentError } from '../../../shared/types';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';

describe('Error Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockSafeSend: SafeSendFn;
	let mockLogger: ProcessListenerDependencies['logger'];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockSafeSend = vi.fn();
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
		setupErrorListener(mockProcessManager, { safeSend: mockSafeSend, logger: mockLogger });

		expect(mockProcessManager.on).toHaveBeenCalledWith('agent-error', expect.any(Function));
	});

	it('should log agent error and forward to renderer', () => {
		setupErrorListener(mockProcessManager, { safeSend: mockSafeSend, logger: mockLogger });

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

	it('should handle token exhaustion errors', () => {
		setupErrorListener(mockProcessManager, { safeSend: mockSafeSend, logger: mockLogger });

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
		setupErrorListener(mockProcessManager, { safeSend: mockSafeSend, logger: mockLogger });

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
