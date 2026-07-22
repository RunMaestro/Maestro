/**
 * Tests for forwarding listeners.
 * These listeners simply forward process events to the renderer via IPC.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupForwardingListeners } from '../forwarding-listeners';
import type { ProcessManager } from '../../process-manager';
import type { SafeSendFn } from '../../utils/safe-send';

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

	it('should buffer thinking-chunk events and flush after the coalesce window', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		const handler = eventHandlers.get('thinking-chunk');
		const testSessionId = 'test-session-123';

		handler?.(testSessionId, 'think');
		handler?.(testSessionId, 'ing...');

		// Nothing should have been sent yet - chunks are still buffered.
		expect(mockSafeSend).not.toHaveBeenCalled();

		// Advance past the flush interval; the buffered content should arrive
		// as a single coalesced send.
		vi.advanceTimersByTime(50);

		expect(mockSafeSend).toHaveBeenCalledTimes(1);
		expect(mockSafeSend).toHaveBeenCalledWith(
			'process:thinking-chunk',
			testSessionId,
			'thinking...'
		);
	});

	it('should flush thinking-chunk buffer immediately when the size cap is hit', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		const handler = eventHandlers.get('thinking-chunk');
		const testSessionId = 'test-session-123';

		// 8KB threshold - push a payload that exceeds it in a single chunk.
		const big = 'x'.repeat(9 * 1024);
		handler?.(testSessionId, big);

		expect(mockSafeSend).toHaveBeenCalledTimes(1);
		expect(mockSafeSend).toHaveBeenCalledWith('process:thinking-chunk', testSessionId, big);
	});

	it('should keep thinking-chunk buffers per session', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		const handler = eventHandlers.get('thinking-chunk');
		handler?.('session-a', 'a-content');
		handler?.('session-b', 'b-content');

		vi.advanceTimersByTime(50);

		expect(mockSafeSend).toHaveBeenCalledTimes(2);
		expect(mockSafeSend).toHaveBeenCalledWith('process:thinking-chunk', 'session-a', 'a-content');
		expect(mockSafeSend).toHaveBeenCalledWith('process:thinking-chunk', 'session-b', 'b-content');
	});

	it('should flush pending thinking-chunk content on query-complete', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		const thinking = eventHandlers.get('thinking-chunk');
		const queryComplete = eventHandlers.get('query-complete');
		const testSessionId = 'test-session-123';

		thinking?.(testSessionId, 'tail');
		expect(mockSafeSend).not.toHaveBeenCalled();

		queryComplete?.(testSessionId, {});

		expect(mockSafeSend).toHaveBeenCalledWith('process:thinking-chunk', testSessionId, 'tail');
	});

	it('should flush pending thinking-chunk content on exit', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		const thinking = eventHandlers.get('thinking-chunk');
		const exitHandler = eventHandlers.get('exit');
		const testSessionId = 'test-session-123';

		thinking?.(testSessionId, 'final-bit');
		exitHandler?.(testSessionId, 0);

		expect(mockSafeSend).toHaveBeenCalledWith('process:thinking-chunk', testSessionId, 'final-bit');
	});

	it('should ignore empty thinking-chunk content', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		const handler = eventHandlers.get('thinking-chunk');
		handler?.('test-session', '');
		vi.advanceTimersByTime(50);

		expect(mockSafeSend).not.toHaveBeenCalled();
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

	it('should emit a metadata-only tool.executed plugin event alongside the renderer forward', () => {
		const emitPluginEvent = vi.fn();
		setupForwardingListeners(mockProcessManager, { ...mockDeps, emitPluginEvent });

		const handler = eventHandlers.get('tool-execution');
		const testSessionId = 'test-session-123';
		const toolEvent = {
			toolName: 'read_file',
			toolCallId: 'call-7',
			timestamp: 1700000000000,
			state: { status: 'completed', input: { path: '/secret' }, output: 'file contents' },
		};

		handler?.(testSessionId, toolEvent);

		// (a) renderer forward is unchanged - still the full tool event.
		expect(mockSafeSend).toHaveBeenCalledWith('process:tool-execution', testSessionId, toolEvent);

		// (b) plugin event carries name + timing only, never the state blob.
		expect(emitPluginEvent).toHaveBeenCalledTimes(1);
		const event = emitPluginEvent.mock.calls[0][0];
		expect(event.topic).toBe('tool.executed');
		expect(event.payload).toEqual({
			sessionId: testSessionId,
			toolName: 'read_file',
			toolCallId: 'call-7',
			timestamp: 1700000000000,
			phase: 'completed',
		});
		expect(event.payload).not.toHaveProperty('state');
		expect(JSON.stringify(event.payload)).not.toContain('/secret');
	});

	it('should omit phase when the tool state carries no status string', () => {
		const emitPluginEvent = vi.fn();
		setupForwardingListeners(mockProcessManager, { ...mockDeps, emitPluginEvent });

		eventHandlers.get('tool-execution')?.('s1', {
			toolName: 'bash',
			timestamp: 5,
			state: 'raw-string-state',
		});

		expect(emitPluginEvent.mock.calls[0][0].payload).toEqual({
			sessionId: 's1',
			toolName: 'bash',
			timestamp: 5,
		});
	});

	it('should not throw when no plugin event emitter is injected', () => {
		setupForwardingListeners(mockProcessManager, mockDeps);

		const handler = eventHandlers.get('tool-execution');
		expect(() =>
			handler?.('s1', { toolName: 'read_file', timestamp: 1, state: { status: 'running' } })
		).not.toThrow();
		expect(mockSafeSend).toHaveBeenCalledWith(
			'process:tool-execution',
			's1',
			expect.objectContaining({ toolName: 'read_file' })
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
