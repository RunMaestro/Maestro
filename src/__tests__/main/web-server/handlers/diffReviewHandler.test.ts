// Covers the diff_review_command WebSocket message behind `maestro-cli
// diff-review`. The comments are renderer state, so this hop validates, refuses
// an unknown agent, and ALWAYS answers with the request id: the CLI blocks on it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));

import { WebSocket } from 'ws';
import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';

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
