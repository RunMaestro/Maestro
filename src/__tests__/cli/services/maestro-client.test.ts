/**
 * @file maestro-client.test.ts
 * @description Tests for the CLI WebSocket client service
 *
 * The connection itself moved into maestro-lib as `BridgeConnection` (its own
 * tests live in src/shared/maestro-lib/client/__tests__/bridge-connection.test.ts).
 * This service keeps the CLI's names for it, so these tests cover:
 * - The aliases resolve to the library's connection and error classes
 * - withMaestroClient helper lifecycle, through the alias
 * - resolveSessionId helper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Track WebSocket instances created
let mockWsInstance: EventEmitter & {
	close: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
	readyState: number;
};

vi.mock('ws', async () => {
	const { EventEmitter: EE } = await import('events');
	const WS_OPEN = 1;
	class MockWebSocket extends EE {
		close = vi.fn();
		send = vi.fn();
		readyState = WS_OPEN;
		static OPEN = WS_OPEN;
		constructor() {
			super();
			mockWsInstance = this as unknown as typeof mockWsInstance;
		}
	}
	return { default: MockWebSocket };
});

// The connection reads discovery from inside the library, so the mock goes on
// the library module rather than on the src/shared/cli-server-discovery shim.
vi.mock('../../../shared/maestro-lib/client/discovery', () => ({
	readCliServerInfo: vi.fn(),
	isCliServerRunning: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	readSessions: vi.fn(),
}));

import {
	MaestroClient,
	withMaestroClient,
	resolveSessionId,
	UnsupportedCommandError,
	CommandTimeoutError,
} from '../../../cli/services/maestro-client';
import {
	BridgeConnection,
	withBridgeConnection,
	UnsupportedCommandError as LibraryUnsupportedCommandError,
	CommandTimeoutError as LibraryCommandTimeoutError,
} from '../../../shared/maestro-lib/client/bridge-connection';
import {
	readCliServerInfo,
	isCliServerRunning,
} from '../../../shared/maestro-lib/client/discovery';
import { readSessions } from '../../../cli/services/storage';

describe('CLI names for the library bridge connection', () => {
	it('MaestroClient and withMaestroClient are the library connection and helper', () => {
		expect(MaestroClient).toBe(BridgeConnection);
		expect(withMaestroClient).toBe(withBridgeConnection);
	});

	it('re-exports the library error classes, so instanceof checks keep matching', () => {
		expect(UnsupportedCommandError).toBe(LibraryUnsupportedCommandError);
		expect(CommandTimeoutError).toBe(LibraryCommandTimeoutError);
	});
});

describe('withMaestroClient()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should connect, run action, and disconnect', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue({
			port: 3000,
			token: 'test-token',
			pid: 12345,
			startedAt: Date.now(),
		});
		vi.mocked(isCliServerRunning).mockReturnValue(true);

		const actionResult = 'action-result';
		const actionFn = vi.fn().mockResolvedValue(actionResult);

		const resultPromise = withMaestroClient(actionFn);

		// Wait for connect
		mockWsInstance.emit('open');

		const result = await resultPromise;

		expect(result).toBe(actionResult);
		expect(actionFn).toHaveBeenCalledTimes(1);
		expect(actionFn.mock.calls[0][0]).toBeInstanceOf(MaestroClient);
		// Should disconnect after action
		expect(mockWsInstance.close).toHaveBeenCalled();
	});

	it('should disconnect even when action throws', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue({
			port: 3000,
			token: 'test-token',
			pid: 12345,
			startedAt: Date.now(),
		});
		vi.mocked(isCliServerRunning).mockReturnValue(true);

		const actionFn = vi.fn().mockRejectedValue(new Error('Action failed'));

		const resultPromise = withMaestroClient(actionFn);
		mockWsInstance.emit('open');

		await expect(resultPromise).rejects.toThrow('Action failed');
		expect(mockWsInstance.close).toHaveBeenCalled();
	});

	it('should propagate connection errors', async () => {
		vi.mocked(readCliServerInfo).mockReturnValue(null);

		await expect(withMaestroClient(async () => 'should not reach')).rejects.toThrow(
			'Maestro desktop app is not running'
		);
	});
});

describe('resolveSessionId()', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should return provided session option directly', () => {
		const result = resolveSessionId({ session: 'my-session-id' });
		expect(result).toBe('my-session-id');
		expect(readSessions).not.toHaveBeenCalled();
	});

	it('should return first session ID when no option provided', () => {
		vi.mocked(readSessions).mockReturnValue([
			{
				id: 'first-session',
				name: 'First',
				toolType: 'claude-code',
				cwd: '/path',
				projectRoot: '/path',
			},
			{
				id: 'second-session',
				name: 'Second',
				toolType: 'claude-code',
				cwd: '/path',
				projectRoot: '/path',
			},
		]);

		const result = resolveSessionId({});
		expect(result).toBe('first-session');
	});

	it('should exit when no sessions exist and no option provided', () => {
		vi.mocked(readSessions).mockReturnValue([]);
		const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit called');
		});
		const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect(() => resolveSessionId({})).toThrow('process.exit called');

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No agents found'));

		processExitSpy.mockRestore();
		consoleErrorSpy.mockRestore();
	});
});
