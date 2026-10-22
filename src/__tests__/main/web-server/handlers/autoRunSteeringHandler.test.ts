// Covers the auto_run_steering_command WebSocket message that backs
// `maestro-cli steer-auto-run`. Nothing about a note is DECIDED here - the notes
// are renderer state - so what this hop owes the caller is: validate the request
// before it reaches a run loop, refuse an agent that does not exist, and ALWAYS
// answer with the request id attached. The CLI process on the far end blocks on
// that reply, so a dropped or unlabeled answer is a command that hangs.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import { logger } from '../../../../main/utils/logger';
import { MAX_STEERING_NOTE_LENGTH } from '../../../../shared/autorunSteering';

function createMockClient(): WebClient {
	return {
		socket: { send: vi.fn() } as unknown as WebClient['socket'],
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

describe('auto_run_steering_command handler', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let autoRunSteeringCommand: ReturnType<typeof vi.fn>;
	let getSessionDetail: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		autoRunSteeringCommand = vi.fn().mockResolvedValue({
			success: true,
			note: { id: 'n1', text: 'use the v3 endpoint', timestamp: 1 },
		});
		getSessionDetail = vi.fn(() => ({ id: 'session-1' }));
		handler.setCallbacks({ autoRunSteeringCommand, getSessionDetail } as never);
	});

	it('forwards a valid send and echoes the request id', async () => {
		handler.handleMessage(client, {
			type: 'auto_run_steering_command',
			requestId: 'req-1',
			action: 'send',
			sessionId: 'session-1',
			text: '  use the v3 endpoint  ',
		});
		await flush();

		expect(autoRunSteeringCommand).toHaveBeenCalledWith({
			action: 'send',
			sessionId: 'session-1',
			text: 'use the v3 endpoint',
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'auto_run_steering_command_result',
			requestId: 'req-1',
			success: true,
			note: { id: 'n1' },
		});
	});

	// The note is the operator's instruction to an agent. The log names what
	// was asked for, never what was said.
	it('keeps the note text out of the log', async () => {
		handler.handleMessage(client, {
			type: 'auto_run_steering_command',
			requestId: 'req-1',
			action: 'send',
			sessionId: 'session-1',
			text: 'the launch codes are 1234',
		});
		await flush();

		const logged = vi.mocked(logger.info).mock.calls.map((call) => String(call[0]));
		expect(logged.some((line) => line.includes('auto_run_steering_command'))).toBe(true);
		expect(logged.some((line) => line.includes('launch codes'))).toBe(false);
	});

	it('refuses an invalid request without reaching the renderer', async () => {
		handler.handleMessage(client, {
			type: 'auto_run_steering_command',
			requestId: 'req-2',
			action: 'send',
			sessionId: 'session-1',
			text: 'x'.repeat(MAX_STEERING_NOTE_LENGTH + 1),
		});
		await flush();

		expect(autoRunSteeringCommand).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'auto_run_steering_command_result',
			requestId: 'req-2',
			success: false,
		});
	});

	it('refuses an agent that does not exist', async () => {
		getSessionDetail.mockReturnValue(null);
		handler.handleMessage(client, {
			type: 'auto_run_steering_command',
			requestId: 'req-3',
			action: 'list',
			sessionId: 'ghost',
		});
		await flush();

		expect(autoRunSteeringCommand).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-3',
			success: false,
			error: 'Session not found: ghost',
		});
	});

	it('answers when steering was never wired up', async () => {
		// `setCallbacks` merges, so an unwired handler has to be a fresh one.
		handler = new WebSocketMessageHandler();
		handler.setCallbacks({ getSessionDetail } as never);
		handler.handleMessage(client, {
			type: 'auto_run_steering_command',
			requestId: 'req-4',
			action: 'list',
			sessionId: 'session-1',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({ requestId: 'req-4', success: false });
	});

	it('passes the renderer refusal back verbatim', async () => {
		autoRunSteeringCommand.mockResolvedValue({
			success: false,
			error: 'No Auto Run is active on this agent',
		});
		handler.handleMessage(client, {
			type: 'auto_run_steering_command',
			requestId: 'req-5',
			action: 'send',
			sessionId: 'session-1',
			text: 'steer left',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-5',
			success: false,
			error: 'No Auto Run is active on this agent',
		});
	});

	it('still answers when the callback rejects', async () => {
		autoRunSteeringCommand.mockRejectedValue(new Error('window closed'));
		handler.handleMessage(client, {
			type: 'auto_run_steering_command',
			requestId: 'req-6',
			action: 'cancel',
			sessionId: 'session-1',
			noteId: 'n1',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			requestId: 'req-6',
			success: false,
			error: 'Steering cancel failed: window closed',
		});
	});
});
