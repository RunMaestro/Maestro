/**
 * Tests for forwarding listeners.
 * These listeners simply forward process events to the renderer via IPC.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupForwardingListeners } from '../../main/process-listeners/forwarding-listeners';
import type { ProcessManager } from '../../main/process-manager';
import type { SafeSendFn } from '../../main/utils/safe-send';

describe('Forwarding Listeners', () => {
	let mockProcessManager: ProcessManager;
	let mockSafeSend: SafeSendFn;
	let eventHandlers: Map<string, (...args: unknown[]) => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockSafeSend = vi.fn();

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	it('should register all forwarding event listeners', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		expect(mockProcessManager.on).toHaveBeenCalledWith('slash-commands', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('thinking-chunk', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('tool-execution', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('stderr', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('command-exit', expect.any(Function));
	});

	it('should forward slash-commands events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('slash-commands');
		const testSessionId = 'test-session-123';
		const testCommands = ['/help', '/clear'];

		handler?.(testSessionId, testCommands);

		expect(mockSafeSend).toHaveBeenCalledWith(
			'process:slash-commands',
			testSessionId,
			testCommands
		);
	});

	it('should forward thinking-chunk events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('thinking-chunk');
		const testSessionId = 'test-session-123';
		const testChunk = { content: 'thinking...' };

		handler?.(testSessionId, testChunk);

		expect(mockSafeSend).toHaveBeenCalledWith('process:thinking-chunk', testSessionId, testChunk);
	});

	it('should forward tool-execution events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('tool-execution');
		const testSessionId = 'test-session-123';
		const testToolExecution = { tool: 'read_file', status: 'completed' };

		handler?.(testSessionId, testToolExecution);

		expect(mockSafeSend).toHaveBeenCalledWith(
			'process:tool-execution',
			testSessionId,
			testToolExecution
		);
	});

	it('should forward stderr events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('stderr');
		const testSessionId = 'test-session-123';
		const testStderr = 'Error: something went wrong';

		handler?.(testSessionId, testStderr);

		expect(mockSafeSend).toHaveBeenCalledWith('process:stderr', testSessionId, testStderr);
	});

	it('should forward command-exit events to renderer', () => {
		setupForwardingListeners(mockProcessManager, { safeSend: mockSafeSend });

		const handler = eventHandlers.get('command-exit');
		const testSessionId = 'test-session-123';
		const testExitCode = 0;

		handler?.(testSessionId, testExitCode);

		expect(mockSafeSend).toHaveBeenCalledWith('process:command-exit', testSessionId, testExitCode);
	});
});
