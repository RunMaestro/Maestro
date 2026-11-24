import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetLogs = vi.fn();
const mockClearLogs = vi.fn();
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		getLogs: (...args: unknown[]) => mockGetLogs(...args),
		clearLogs: () => mockClearLogs(),
		warn: vi.fn(),
	},
}));

import {
	handleSystemLogsClear,
	handleSystemLogsRead,
} from '../../../../main/web-server/handlers/messageHandlers/systemLogs';
import type {
	MessageHandlerContext,
	WebClient,
} from '../../../../main/web-server/handlers/messageHandlers/types';

const entries = [
	{ timestamp: 1_000, level: 'error', message: 'old failure', context: 'Startup' },
	{ timestamp: 2_000, level: 'warn', message: 'slow read', context: 'Stats' },
	{ timestamp: 3_000, level: 'error', message: 'new failure', context: 'Startup' },
];

describe('system log WS handlers', () => {
	let send: ReturnType<typeof vi.fn>;
	let ctx: MessageHandlerContext;
	const cli = { id: 'c1', cli: true } as unknown as WebClient;
	const browser = { id: 'b1' } as unknown as WebClient;

	beforeEach(() => {
		vi.clearAllMocks();
		send = vi.fn();
		ctx = { send } as unknown as MessageHandlerContext;
		mockGetLogs.mockReturnValue(entries);
	});

	it('reads the buffer through the logger with the level and context filters', () => {
		handleSystemLogsRead(ctx, cli, {
			type: 'system_logs_read',
			level: 'error',
			context: 'Startup',
			requestId: 'q1',
		});
		expect(mockGetLogs).toHaveBeenCalledWith({ level: 'error', context: 'Startup' });
		expect(send).toHaveBeenCalledWith(cli, {
			type: 'system_logs_read_result',
			success: true,
			entries,
			requestId: 'q1',
		});
	});

	it('drops entries before since, then keeps the newest limit', () => {
		handleSystemLogsRead(ctx, cli, {
			type: 'system_logs_read',
			since: 1_500,
			limit: 1,
			requestId: 'q2',
		});
		expect(send.mock.calls[0][1].entries).toEqual([entries[2]]);
	});

	it('refuses an unknown level by name', () => {
		handleSystemLogsRead(ctx, cli, { type: 'system_logs_read', level: 'loud', requestId: 'q3' });
		expect(mockGetLogs).not.toHaveBeenCalled();
		const reply = send.mock.calls[0][1];
		expect(reply.success).toBe(false);
		expect(reply.error).toContain('Unknown log level: loud');
	});

	it('answers maestro-cli only', () => {
		handleSystemLogsRead(ctx, browser, { type: 'system_logs_read', requestId: 'q4' });
		handleSystemLogsClear(ctx, browser, { type: 'system_logs_clear', requestId: 'q5' });
		expect(mockGetLogs).not.toHaveBeenCalled();
		expect(mockClearLogs).not.toHaveBeenCalled();
		expect(send.mock.calls.map((call) => call[1].success)).toEqual([false, false]);
	});

	it('clear empties the buffer the viewer reads', () => {
		handleSystemLogsClear(ctx, cli, { type: 'system_logs_clear', requestId: 'q6' });
		expect(mockClearLogs).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(cli, {
			type: 'system_logs_clear_result',
			success: true,
			requestId: 'q6',
		});
	});
});
