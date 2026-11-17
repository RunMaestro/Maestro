// Covers the claude_canary_status / claude_canary_run WebSocket messages that
// back `maestro-cli claude-canary`. The CLI blocks on the reply, so each
// message must ALWAYS answer with its request id, including when the app's
// canary is not running.

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
	captureMessage: vi.fn(),
}));

const getClaudeTuiCanary = vi.fn();
vi.mock('../../../../main/agents/claude-tui-canary', () => ({
	getClaudeTuiCanary: () => getClaudeTuiCanary(),
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

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

const flush = () => new Promise((resolve) => setImmediate(resolve));

const LAST = {
	ok: false,
	claudeVersion: '2.1.326',
	maestroVersion: '1.1.1',
	configDir: '/Users/me/.claude',
	checkedAt: 1_700_000_000_000,
	error: 'startup_dialog_blocked',
	exitCode: 11,
};

describe('claude canary handlers', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;

	beforeEach(() => {
		getClaudeTuiCanary.mockReset();
		handler = new WebSocketMessageHandler();
		client = createMockClient();
	});

	it('status relays the last result with the request id', () => {
		getClaudeTuiCanary.mockReturnValue({ getLastResult: () => LAST });
		handler.handleMessage(client, { type: 'claude_canary_status', requestId: 'r1' });
		expect(lastResponse(client)).toMatchObject({
			type: 'claude_canary_status_result',
			success: true,
			last: LAST,
			requestId: 'r1',
		});
	});

	it('status reports a null result when the canary has never run', () => {
		getClaudeTuiCanary.mockReturnValue({ getLastResult: () => undefined });
		handler.handleMessage(client, { type: 'claude_canary_status', requestId: 'r2' });
		expect(lastResponse(client)).toMatchObject({ success: true, last: null, requestId: 'r2' });
	});

	it('status fails with the request id when the canary is not running', () => {
		getClaudeTuiCanary.mockReturnValue(null);
		handler.handleMessage(client, { type: 'claude_canary_status', requestId: 'r3' });
		expect(lastResponse(client)).toMatchObject({
			type: 'claude_canary_status_result',
			success: false,
			error: 'The canary is not running',
			requestId: 'r3',
		});
	});

	it('run forces a check and relays its outcome', async () => {
		const outcome = { ran: true, result: LAST };
		const check = vi.fn().mockResolvedValue(outcome);
		getClaudeTuiCanary.mockReturnValue({ check });
		handler.handleMessage(client, { type: 'claude_canary_run', requestId: 'r4' });
		await flush();
		expect(check).toHaveBeenCalledWith({ force: true });
		expect(lastResponse(client)).toMatchObject({
			type: 'claude_canary_run_result',
			success: true,
			outcome,
			requestId: 'r4',
		});
	});

	it('run fails with the request id when the canary is not running', async () => {
		getClaudeTuiCanary.mockReturnValue(null);
		handler.handleMessage(client, { type: 'claude_canary_run', requestId: 'r5' });
		await flush();
		expect(lastResponse(client)).toMatchObject({
			type: 'claude_canary_run_result',
			success: false,
			error: 'The canary is not running',
			requestId: 'r5',
		});
	});
});
