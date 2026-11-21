// Source: src/__tests__/main/web-server/handlers/diffReviewHandler.test.ts
// Source: src/__tests__/main/web-server/handlers/snoozeHandler.test.ts
// Source: src/__tests__/main/web-server/handlers/autoRunSteeringHandler.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import type { SnoozeCommandRequest } from '../../../../shared/snoozeCommands';
import { logger } from '../../../../main/utils/logger';
import { MAX_STEERING_NOTE_LENGTH } from '../../../../shared/autorunSteering';
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));
describeSourceSuite('diffReviewHandler', () => {
	function createMockClient(): WebClient {
		return {
			// sendBounded only writes to an OPEN socket.
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

	describe('diff_review_command handler', () => {
		let handler: WebSocketMessageHandler;
		let client: WebClient;
		let diffReviewCommand: ReturnType<typeof vi.fn>;
		let getSessionDetail: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			vi.clearAllMocks();
			handler = new WebSocketMessageHandler();
			client = createMockClient();
			diffReviewCommand = vi.fn().mockResolvedValue({ success: true, cwd: '/repo', comments: [] });
			getSessionDetail = vi.fn((id: string) => (id === 'session-1' ? { id } : null));
			handler.setCallbacks({ diffReviewCommand, getSessionDetail } as never);
		});

		it('forwards a valid add, normalized, and echoes the request id', async () => {
			handler.handleMessage(client, {
				type: 'diff_review_command',
				requestId: 'req-1',
				action: 'add',
				sessionId: 'session-1',
				path: ' src/app.ts ',
				startLine: 14,
				endLine: 12,
				body: '  Merge these.  ',
			});
			await flush();

			expect(diffReviewCommand).toHaveBeenCalledWith({
				action: 'add',
				sessionId: 'session-1',
				path: 'src/app.ts',
				startLine: 12,
				endLine: 14,
				side: 'new',
				body: 'Merge these.',
			});
			expect(lastResponse(client)).toMatchObject({
				type: 'diff_review_command_result',
				requestId: 'req-1',
				success: true,
			});
		});

		it('refuses a malformed request before it reaches the renderer', async () => {
			handler.handleMessage(client, {
				type: 'diff_review_command',
				requestId: 'req-2',
				action: 'add',
				sessionId: 'session-1',
				path: 'src/app.ts',
				startLine: 0,
				body: 'x',
			});
			await flush();
			expect(diffReviewCommand).not.toHaveBeenCalled();
			expect(lastResponse(client)).toMatchObject({ requestId: 'req-2', success: false });
		});

		it('refuses an unknown agent', async () => {
			handler.handleMessage(client, {
				type: 'diff_review_command',
				requestId: 'req-3',
				action: 'list',
				sessionId: 'nope',
			});
			await flush();
			expect(diffReviewCommand).not.toHaveBeenCalled();
			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-3',
				success: false,
				error: 'Session not found: nope',
			});
		});

		it('answers a renderer failure instead of hanging', async () => {
			diffReviewCommand.mockRejectedValueOnce(new Error('boom'));
			handler.handleMessage(client, {
				type: 'diff_review_command',
				requestId: 'req-4',
				action: 'send',
				sessionId: 'session-1',
			});
			await flush();
			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-4',
				success: false,
				error: 'Diff review send failed: boom',
			});
		});
	});
});
describeSourceSuite('snoozeHandler', () => {
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

	describe('snooze_command handler', () => {
		let handler: WebSocketMessageHandler;
		let client: WebClient;
		let snoozeCommand: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			handler = new WebSocketMessageHandler();
			client = createMockClient();
			snoozeCommand = vi.fn().mockResolvedValue({ success: true, snoozes: [] });
			handler.setCallbacks({
				snoozeCommand: snoozeCommand as unknown as (
					request: SnoozeCommandRequest
				) => Promise<{ success: boolean }>,
				getSessionDetail: vi.fn(() => ({ id: 'session-1' })),
			} as never);
		});

		it('forwards a valid request and echoes the request id', async () => {
			handler.handleMessage(client, {
				type: 'snooze_command',
				requestId: 'req-1',
				action: 'snooze',
				sessionId: 'session-1',
				targetId: 'tab-1',
				wakeAt: 1893456000000,
			});
			await flush();

			expect(snoozeCommand).toHaveBeenCalledWith(
				expect.objectContaining({
					action: 'snooze',
					sessionId: 'session-1',
					targetId: 'tab-1',
					wakeAt: 1893456000000,
				})
			);
			expect(lastResponse(client)).toMatchObject({
				type: 'snooze_command_result',
				requestId: 'req-1',
				success: true,
			});
		});

		it('rejects a malformed request without reaching the renderer', () => {
			// `snooze` with no wakeAt: parking a tab with no wake instant would hide
			// it with nothing scheduled to bring it back.
			handler.handleMessage(client, {
				type: 'snooze_command',
				requestId: 'req-2',
				action: 'snooze',
				sessionId: 'session-1',
				targetId: 'tab-1',
			});

			expect(snoozeCommand).not.toHaveBeenCalled();
			const response = lastResponse(client);
			expect(response).toMatchObject({
				type: 'snooze_command_result',
				requestId: 'req-2',
				success: false,
			});
			expect(response.error).toBeTruthy();
		});

		it('refuses an unknown agent by name', () => {
			handler.setCallbacks({ getSessionDetail: vi.fn(() => undefined) } as never);

			handler.handleMessage(client, {
				type: 'snooze_command',
				requestId: 'req-3',
				action: 'list',
				sessionId: 'ghost-agent',
			});

			expect(snoozeCommand).not.toHaveBeenCalled();
			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-3',
				success: false,
				error: 'Session not found: ghost-agent',
			});
		});

		it('allows an agent-less read through (list and history are app-wide)', async () => {
			handler.handleMessage(client, {
				type: 'snooze_command',
				requestId: 'req-4',
				action: 'list',
			});
			await flush();

			expect(snoozeCommand).toHaveBeenCalledWith(expect.objectContaining({ action: 'list' }));
			expect(lastResponse(client)).toMatchObject({ requestId: 'req-4', success: true });
		});

		it('answers rather than hanging when the renderer round trip rejects', async () => {
			snoozeCommand.mockRejectedValue(new Error('window closed'));

			handler.handleMessage(client, {
				type: 'snooze_command',
				requestId: 'req-5',
				action: 'list',
			});
			await flush();

			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-5',
				success: false,
				error: 'Snooze list failed: window closed',
			});
		});
	});
});
describeSourceSuite('autoRunSteeringHandler', () => {
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
});
