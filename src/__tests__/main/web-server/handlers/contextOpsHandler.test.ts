// Covers summarize_context, merge_context and transfer_context - the AI tab
// overlay menu's Context: Compact, Merge Into and Send to Agent, reached from
// `maestro-cli tab compact|merge|transfer`. This hop validates, forwards, and
// ALWAYS answers with the typed `*_result` and the request id, because the CLI
// blocks on it. Which tab is meant is the renderer's call.

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
import {
	buildTabContextOpMessage,
	normalizeTabContextOpResult,
	parseTabContextOpMessage,
} from '../../../../shared/tabContextOps';

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

describe('context operation handlers', () => {
	let handler: WebSocketMessageHandler;
	let client: WebClient;
	let tabContextOp: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handler = new WebSocketMessageHandler();
		client = createMockClient();
		tabContextOp = vi.fn().mockResolvedValue({
			success: true,
			sessionId: 'source-1',
			tabId: 'tab-1',
			newTabId: 'tab-new',
		});
		handler.setCallbacks({ tabContextOp } as never);
	});

	it('forwards summarize_context with the source tab and replies with the new tab', async () => {
		handler.handleMessage(client, {
			type: 'summarize_context',
			requestId: 'req-1',
			sessionId: 'source-1',
			tabId: 'tab-1',
			background: true,
		});
		await flush();

		expect(tabContextOp).toHaveBeenCalledWith({
			op: 'compact',
			sessionId: 'source-1',
			tabId: 'tab-1',
			background: true,
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'summarize_context_result',
			requestId: 'req-1',
			success: true,
			newTabId: 'tab-new',
		});
	});

	it('forwards merge_context with both tab ids', async () => {
		handler.handleMessage(client, {
			type: 'merge_context',
			requestId: 'req-2',
			sourceSessionId: 'source-1',
			targetSessionId: 'target-1',
			tabId: 'tab-1',
			targetTabId: 'tab-9',
		});
		await flush();

		expect(tabContextOp).toHaveBeenCalledWith({
			op: 'merge',
			sessionId: 'source-1',
			targetSessionId: 'target-1',
			tabId: 'tab-1',
			targetTabId: 'tab-9',
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'merge_context_result',
			requestId: 'req-2',
		});
	});

	it('still accepts the old agent-only shape', async () => {
		handler.handleMessage(client, {
			type: 'transfer_context',
			requestId: 'req-3',
			sourceSessionId: 'source-1',
			targetSessionId: 'target-1',
		});
		await flush();

		expect(tabContextOp).toHaveBeenCalledWith({
			op: 'transfer',
			sessionId: 'source-1',
			targetSessionId: 'target-1',
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'transfer_context_result',
			success: true,
		});
	});

	it('lets a merge target another tab of the same agent', async () => {
		handler.handleMessage(client, {
			type: 'merge_context',
			requestId: 'req-4',
			sourceSessionId: 'agent-1',
			targetSessionId: 'agent-1',
			tabId: 'tab-1',
			targetTabId: 'tab-2',
		});
		await flush();

		expect(tabContextOp).toHaveBeenCalledTimes(1);
	});

	it('refuses a transfer to the same agent with a typed result, not an error frame', () => {
		handler.handleMessage(client, {
			type: 'transfer_context',
			requestId: 'req-5',
			sourceSessionId: 'agent-1',
			targetSessionId: 'agent-1',
		});

		expect(tabContextOp).not.toHaveBeenCalled();
		expect(lastResponse(client)).toEqual(
			expect.objectContaining({
				type: 'transfer_context_result',
				requestId: 'req-5',
				success: false,
				error: 'Source and target agents must be different',
			})
		);
	});

	it('refuses a missing agent id with a typed result', () => {
		handler.handleMessage(client, { type: 'summarize_context', requestId: 'req-6' });

		expect(lastResponse(client)).toMatchObject({
			type: 'summarize_context_result',
			requestId: 'req-6',
			success: false,
			error: 'Missing sessionId',
		});
	});

	it('answers a thrown callback with a typed failure', async () => {
		tabContextOp.mockRejectedValueOnce(new Error('renderer gone'));

		handler.handleMessage(client, {
			type: 'summarize_context',
			requestId: 'req-7',
			sessionId: 'source-1',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			type: 'summarize_context_result',
			requestId: 'req-7',
			success: false,
			error: 'Context compact failed: renderer gone',
		});
	});

	it('answers when no callback is configured', () => {
		handler = new WebSocketMessageHandler();
		handler.setCallbacks({ tabContextOp: undefined } as never);
		handler.handleMessage(client, {
			type: 'merge_context',
			requestId: 'req-8',
			sourceSessionId: 'a',
			targetSessionId: 'b',
		});

		expect(lastResponse(client)).toMatchObject({
			type: 'merge_context_result',
			success: false,
			error: 'Context operations not configured',
		});
	});
});

describe('tabContextOps wire helpers', () => {
	it('builds each message in the fields it has always used', () => {
		expect(
			buildTabContextOpMessage({ op: 'compact', sessionId: 'a', tabId: 't', background: true })
		).toEqual({ type: 'summarize_context', sessionId: 'a', tabId: 't', background: true });
		expect(
			buildTabContextOpMessage({
				op: 'merge',
				sessionId: 'a',
				targetSessionId: 'b',
				targetTabId: 'u',
			})
		).toEqual({
			type: 'merge_context',
			sourceSessionId: 'a',
			targetSessionId: 'b',
			targetTabId: 'u',
		});
		expect(
			buildTabContextOpMessage({
				op: 'transfer',
				sessionId: 'a',
				targetSessionId: 'b',
				targetTabId: 'ignored',
				background: false,
			})
		).toEqual({ type: 'transfer_context', sourceSessionId: 'a', targetSessionId: 'b' });
	});

	it('round-trips through the parser', () => {
		const request = {
			op: 'merge' as const,
			sessionId: 'a',
			tabId: 't',
			targetSessionId: 'b',
			targetTabId: 'u',
			background: true,
		};
		const parsed = parseTabContextOpMessage('merge', buildTabContextOpMessage(request));
		expect(parsed).toEqual({ ok: true, request });
	});

	it('refuses a blank tab id instead of falling back to the active tab', () => {
		expect(parseTabContextOpMessage('compact', { sessionId: 'a', tabId: '  ' })).toEqual({
			ok: false,
			error: 'tabId must be a non-empty string when provided',
		});
	});

	it('only reads a literal true as background', () => {
		const parsed = parseTabContextOpMessage('compact', { sessionId: 'a', background: 'yes' });
		expect(parsed).toEqual({ ok: true, request: { op: 'compact', sessionId: 'a' } });
	});

	it('normalizes a reply that crossed the IPC boundary', () => {
		expect(normalizeTabContextOpResult(null)).toEqual({
			success: false,
			error: 'Invalid context operation response',
		});
		expect(normalizeTabContextOpResult({ success: 'true' })).toEqual({
			success: false,
			error: 'Context operation failed',
		});
		expect(
			normalizeTabContextOpResult({
				success: true,
				newTabId: 'n',
				queued: true,
				staged: 'yes',
				reductionPercent: 42,
				extra: 'dropped',
			})
		).toEqual({ success: true, newTabId: 'n', queued: true, reductionPercent: 42 });
		expect(normalizeTabContextOpResult({ success: false, timedOut: true, error: 'slow' })).toEqual({
			success: false,
			timedOut: true,
			error: 'slow',
		});
	});
});
