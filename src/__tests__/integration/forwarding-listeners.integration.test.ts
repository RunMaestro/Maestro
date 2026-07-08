/**
 * Tests for forwarding listeners.
 * These listeners simply forward process events to the renderer via IPC.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupForwardingListeners } from '../../main/process-listeners/forwarding-listeners';
import type { ProcessManager } from '../../main/process-manager';
import type { SafeSendFn } from '../../main/utils/safe-send';

describe('Forwarding Listeners', () => {
	let mockProcessManager: ProcessManager;
	let mockSafeSend: SafeSendFn;
	let eventHandlers: Map<string, (...args: unknown[]) => void>;
	let mockDeps: any;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		eventHandlers = new Map();

		mockSafeSend = vi.fn();
		mockDeps = {
			safeSend: mockSafeSend,
			getWebServer: () => null,
			patterns: {
				REGEX_AI_SUFFIX: /-ai-.+$/,
				REGEX_AI_TAB_ID: /-ai-(.+?)(?:-fp-\d+)?$/,
			},
		};

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should register all forwarding event listeners', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		expect(mockProcessManager.on).toHaveBeenCalledWith('slash-commands', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('thinking-chunk', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('tool-execution', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('stderr', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('command-exit', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('query-complete', expect.any(Function));
		expect(mockProcessManager.on).toHaveBeenCalledWith('exit', expect.any(Function));
	});

	it('should forward slash-commands events to renderer', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

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
		setupForwardingListeners(mockProcessManager, mockDeps);

		const handler = eventHandlers.get('thinking-chunk');
		const testSessionId = 'test-session-123';
		const testChunk = 'thinking...';

		handler?.(testSessionId, testChunk);

		expect(mockSafeSend).not.toHaveBeenCalled();
		vi.advanceTimersByTime(50);
		expect(mockSafeSend).toHaveBeenCalledWith('process:thinking-chunk', testSessionId, testChunk);
	});

	it('should forward tool-execution events to renderer', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

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
		setupForwardingListeners(mockProcessManager, mockDeps);

		const handler = eventHandlers.get('stderr');
		const testSessionId = 'test-session-123';
		const testStderr = 'Error: something went wrong';

		handler?.(testSessionId, testStderr);

		expect(mockSafeSend).toHaveBeenCalledWith('process:stderr', testSessionId, testStderr);
	});

	it('should forward command-exit events to renderer', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		const handler = eventHandlers.get('command-exit');
		const testSessionId = 'test-session-123';
		const testExitCode = 0;

		handler?.(testSessionId, testExitCode);

		expect(mockSafeSend).toHaveBeenCalledWith('process:command-exit', testSessionId, testExitCode);
	});
});
