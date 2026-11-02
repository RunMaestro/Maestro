// Covers the live_command WebSocket message that backs `maestro-cli live
// status|on|off` and `maestro-cli live tunnel on|off`. The handler routes to the same LiveModeController the LIVE
// pill's `live:set` calls, answers CLI clients only, and replies BEFORE it
// switches, because the switch replaces the server the CLI socket is on.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

const controller = {
	getStatus: vi.fn(),
	set: vi.fn(),
	startRemoteControl: vi.fn(),
	stopRemoteControl: vi.fn(),
};
let activeController: typeof controller | null = controller;

vi.mock('../../../../main/web-server/live-mode', () => ({
	getLiveModeController: () => activeController,
}));

import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import { logger } from '../../../../main/utils/logger';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import WebSocket from 'ws';
import type { LiveModeStatus } from '../../../../shared/liveMode';

const OFF: LiveModeStatus = {
	live: false,
	url: null,
	remoteControl: false,
	remoteControlUrl: null,
	revision: 4,
};
const ON: LiveModeStatus = {
	live: true,
	url: 'http://192.168.1.5:9000/token',
	remoteControl: false,
	remoteControlUrl: null,
	revision: 5,
};
const REMOTE: LiveModeStatus = {
	...ON,
	remoteControl: true,
	remoteControlUrl: 'https://abc.trycloudflare.com/token',
	revision: 6,
};

/** Socket whose send callbacks are held until the test releases them. */
function createMockClient(cli = true) {
	const pending: Array<(error?: Error) => void> = [];
	const send = vi.fn((_frame: string, cb?: (error?: Error) => void) => {
		if (cb) pending.push(cb);
	});
	const client = {
		socket: { readyState: WebSocket.OPEN, send } as unknown as WebClient['socket'],
		id: 'client-1',
		connectedAt: 0,
		cli,
	} as WebClient;
	return { client, send, pending };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('live_command handler', () => {
	let handler: WebSocketMessageHandler;

	const reply = (send: ReturnType<typeof vi.fn>) =>
		JSON.parse(send.mock.calls.at(-1)![0] as string) as Record<string, unknown>;

	beforeEach(() => {
		vi.clearAllMocks();
		activeController = controller;
		controller.getStatus.mockReturnValue(OFF);
		controller.set.mockResolvedValue({ success: true, changed: true, status: ON });
		handler = new WebSocketMessageHandler();
	});

	it('status answers with the controller status and the request id', () => {
		const { client, send } = createMockClient();
		handler.handleMessage(client, { type: 'live_command', action: 'status', requestId: 'r1' });

		expect(reply(send)).toMatchObject({
			type: 'live_command_result',
			success: true,
			status: OFF,
			requestId: 'r1',
		});
		expect(controller.set).not.toHaveBeenCalled();
	});

	it('refuses a client that is not the CLI', () => {
		const { client, send } = createMockClient(false);
		handler.handleMessage(client, { type: 'live_command', action: 'on', requestId: 'r1' });

		const answer = reply(send);
		expect(answer).toMatchObject({ success: false, requestId: 'r1' });
		expect(answer.error).toContain('cannot be switched over the web interface');
		expect(controller.getStatus).not.toHaveBeenCalled();
		expect(controller.set).not.toHaveBeenCalled();
	});

	it('rejects an unknown action, including toggle', () => {
		const { client, send } = createMockClient();
		handler.handleMessage(client, { type: 'live_command', action: 'toggle', requestId: 'r1' });

		const answer = reply(send);
		expect(answer).toMatchObject({ success: false, requestId: 'r1' });
		expect(answer.error).toContain('Unknown live action: toggle');
		expect(controller.set).not.toHaveBeenCalled();
	});

	it('answers when the controller is not registered yet', () => {
		activeController = null;
		const { client, send } = createMockClient();
		handler.handleMessage(client, { type: 'live_command', action: 'status', requestId: 'r1' });

		expect(reply(send)).toMatchObject({
			success: false,
			error: 'Live mode is not available yet. Try again in a moment.',
		});
	});

	it.each([
		['on', ON],
		['off', OFF],
	] as const)(
		'%s while already in that state answers changed: false and switches nothing',
		async (action, state) => {
			controller.getStatus.mockReturnValue(state);
			const { client, send } = createMockClient();
			handler.handleMessage(client, { type: 'live_command', action, requestId: 'r1' });
			await flush();

			expect(reply(send)).toMatchObject({ success: true, changed: false, status: state });
			expect(controller.set).not.toHaveBeenCalled();
		}
	);

	it.each([
		['on', OFF, true],
		['off', ON, false],
	] as const)(
		'%s replies first with the revision to await, then switches',
		async (action, before, target) => {
			controller.getStatus.mockReturnValue(before);
			const { client, send, pending } = createMockClient();
			handler.handleMessage(client, { type: 'live_command', action, requestId: 'r1' });

			expect(reply(send)).toMatchObject({
				type: 'live_command_result',
				success: true,
				changed: true,
				awaitRevision: before.revision + 1,
				status: before,
				requestId: 'r1',
			});

			// Nothing switches until the reply is on the wire.
			await flush();
			expect(controller.set).not.toHaveBeenCalled();

			pending.forEach((cb) => cb());
			await flush();
			expect(controller.set).toHaveBeenCalledTimes(1);
			expect(controller.set).toHaveBeenCalledWith(target);
		}
	);

	it('does not switch when the reply could not be sent', async () => {
		const { client, pending } = createMockClient();
		handler.handleMessage(client, { type: 'live_command', action: 'on', requestId: 'r1' });

		pending.forEach((cb) => cb(new Error('socket closed')));
		await flush();
		expect(controller.set).not.toHaveBeenCalled();
	});

	it('logs a switch that rejects instead of throwing', async () => {
		controller.set.mockRejectedValue(new Error('boom'));
		const { client, pending } = createMockClient();
		handler.handleMessage(client, { type: 'live_command', action: 'on', requestId: 'r1' });

		pending.forEach((cb) => cb());
		await flush();
		await flush();
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('live_command on failed: boom'),
			expect.any(String)
		);
	});

	describe('Remote Control', () => {
		it('remote-on starts the tunnel and answers once it is up, without a server swap', async () => {
			controller.getStatus.mockReturnValue(ON);
			controller.startRemoteControl.mockResolvedValue({
				success: true,
				url: REMOTE.remoteControlUrl,
				status: REMOTE,
			});
			const { client, send, pending } = createMockClient();
			handler.handleMessage(client, { type: 'live_command', action: 'remote-on', requestId: 'r1' });
			await flush();

			expect(controller.startRemoteControl).toHaveBeenCalledTimes(1);
			expect(controller.set).not.toHaveBeenCalled();
			expect(reply(send)).toMatchObject({
				type: 'live_command_result',
				success: true,
				changed: true,
				status: REMOTE,
				requestId: 'r1',
			});
			// Nothing is deferred to after the send: the server stays as it is.
			expect(pending).toHaveLength(0);
		});

		it('remote-on relays the refusal while Live is off', async () => {
			controller.startRemoteControl.mockResolvedValue({
				success: false,
				error: 'Live mode is off. Turn it on before starting Remote Control.',
				status: OFF,
			});
			const { client, send } = createMockClient();
			handler.handleMessage(client, { type: 'live_command', action: 'remote-on', requestId: 'r1' });
			await flush();

			expect(reply(send)).toMatchObject({
				success: false,
				error: 'Live mode is off. Turn it on before starting Remote Control.',
				status: OFF,
			});
		});

		it('remote-off stops the tunnel', async () => {
			controller.stopRemoteControl.mockResolvedValue({ success: true, status: ON });
			const { client, send } = createMockClient();
			handler.handleMessage(client, {
				type: 'live_command',
				action: 'remote-off',
				requestId: 'r1',
			});
			await flush();

			expect(controller.stopRemoteControl).toHaveBeenCalledTimes(1);
			expect(reply(send)).toMatchObject({ success: true, status: ON });
		});

		it('refuses Remote Control from a client that is not the CLI', () => {
			const { client, send } = createMockClient(false);
			handler.handleMessage(client, { type: 'live_command', action: 'remote-on', requestId: 'r1' });

			expect(reply(send)).toMatchObject({ success: false });
			expect(controller.startRemoteControl).not.toHaveBeenCalled();
		});
	});
});
