// Covers the throughput_gauge_command WebSocket message that backs
// `maestro-cli throughput-gauge`. The gauge's state lives in the primary
// window's renderer, so this hop owes the caller two things: refuse a bad
// request (unknown action, empty or invalid `set` patch) before it reaches the
// renderer, and ALWAYS answer with the request id attached, because the CLI on
// the far end blocks on that reply.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import { captureException } from '../../../../main/utils/sentry';

function createMockClient(): WebClient {
	return {
		socket: { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
	};
}

function lastResponse(client: WebClient): Record<string, unknown> {
	const calls = (client.socket.send as ReturnType<typeof vi.fn>).mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

/** Flush the promise chain the handler's `.then(...)` reply rides on. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const STATUS = { enabled: true, visible: false };

describe('throughput_gauge_command handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let throughputGaugeCommand: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		throughputGaugeCommand = vi.fn().mockResolvedValue({ success: true, status: STATUS });
		handler.setCallbacks({ throughputGaugeCommand } as never);
	});

	it('forwards a valid verb and relays the result with the request id', async () => {
		handler.handleMessage(client, {
			type: 'throughput_gauge_command',
			requestId: 'req-1',
			action: 'hide',
		});
		await flush();

		expect(throughputGaugeCommand).toHaveBeenCalledWith({ action: 'hide' });
		expect(lastResponse(client)).toMatchObject({
			type: 'throughput_gauge_command_result',
			success: true,
			status: STATUS,
			requestId: 'req-1',
		});
	});

	it('forwards only the validated patch on set', async () => {
		handler.handleMessage(client, {
			type: 'throughput_gauge_command',
			requestId: 'req-2',
			action: 'set',
			patch: { style: 'lcd', windowMs: 30000 },
		});
		await flush();

		expect(throughputGaugeCommand).toHaveBeenCalledWith({
			action: 'set',
			patch: { style: 'lcd', windowMs: 30000 },
		});
	});

	it.each([
		['an unknown action', { action: 'explode' }],
		['a set with no patch', { action: 'set' }],
		['a set with an empty patch', { action: 'set', patch: {} }],
		['a set with an invalid value', { action: 'set', patch: { windowMs: 7000 } }],
		['a set with an unknown field', { action: 'set', patch: { color: 'red' } }],
	])('rejects %s without calling the callback', async (_label, fields) => {
		handler.handleMessage(client, {
			type: 'throughput_gauge_command',
			requestId: 'req-bad',
			...fields,
		});
		await flush();

		expect(throughputGaugeCommand).not.toHaveBeenCalled();
		const reply = lastResponse(client);
		expect(reply).toMatchObject({
			type: 'throughput_gauge_command_result',
			success: false,
			requestId: 'req-bad',
		});
		expect(typeof reply.error).toBe('string');
	});

	it('answers a failure when the callback rejects, and reports it to Sentry', async () => {
		const failure = new Error('window closed');
		throughputGaugeCommand.mockRejectedValue(failure);
		handler.handleMessage(client, {
			type: 'throughput_gauge_command',
			requestId: 'req-3',
			action: 'status',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			type: 'throughput_gauge_command_result',
			success: false,
			error: 'Throughput Gauge status failed: window closed',
			requestId: 'req-3',
		});
		// Every expected failure resolves to a result, so a rejection is a defect.
		expect(captureException).toHaveBeenCalledWith(
			failure,
			expect.objectContaining({ handler: 'throughput_gauge_command', action: 'status' })
		);
	});
});
