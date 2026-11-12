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
import WebSocket from 'ws';
import {
	MAX_CONTINUITY_TEXT_CHARS,
	TAB_CONTEXT_OP_MESSAGES,
	TAB_CONTEXT_OP_REPLY_MS,
	buildTabContextOpMessage,
	normalizeTabContextOpResult,
	parseTabContextOpMessage,
} from '../../../../shared/tabContextOps';
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

	it('forwards continuity_preview as its own message and replies with the preview', async () => {
		const continuity = {
			text: 'Continuity preview of tab tab-1',
			entries: 4,
			synopses: { shown: 1, refused: { 'other-tab': 2 } },
			notices: ['a notice'],
			unknowns: ['objective: none'],
		};
		tabContextOp.mockResolvedValueOnce({
			success: true,
			sessionId: 'source-1',
			tabId: 'tab-1',
			continuity,
		});

		handler.handleMessage(client, {
			type: 'continuity_preview',
			requestId: 'req-c1',
			sessionId: 'source-1',
			tabId: 'tab-1',
		});
		await flush();

		expect(tabContextOp).toHaveBeenCalledWith({
			op: 'continuity',
			sessionId: 'source-1',
			tabId: 'tab-1',
		});
		expect(lastResponse(client)).toMatchObject({
			type: 'continuity_preview_result',
			requestId: 'req-c1',
			success: true,
			continuity,
		});
	});

	it('refuses a continuity_preview with no agent as a typed result', () => {
		handler.handleMessage(client, { type: 'continuity_preview', requestId: 'req-c2' });

		expect(tabContextOp).not.toHaveBeenCalled();
		expect(lastResponse(client)).toMatchObject({
			type: 'continuity_preview_result',
			requestId: 'req-c2',
			success: false,
			error: 'Missing sessionId',
		});
	});

	it('answers a thrown continuity callback with a typed failure', async () => {
		tabContextOp.mockRejectedValueOnce(new Error('renderer gone'));

		handler.handleMessage(client, {
			type: 'continuity_preview',
			requestId: 'req-c3',
			sessionId: 'source-1',
		});
		await flush();

		expect(lastResponse(client)).toMatchObject({
			type: 'continuity_preview_result',
			success: false,
			error: 'Context continuity failed: renderer gone',
		});
	});

	it('does not read a summarize_context as a preview: no flag can turn it into one', async () => {
		handler.handleMessage(client, {
			type: 'summarize_context',
			requestId: 'req-c4',
			sessionId: 'source-1',
			preview: true,
			continuity: true,
		});
		await flush();

		// A flag a desktop does not know is ignored, so this stays a real compaction request.
		expect(tabContextOp).toHaveBeenCalledWith({ op: 'compact', sessionId: 'source-1' });
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

	it('builds the continuity preview as its own message, in the compact fields', () => {
		expect(buildTabContextOpMessage({ op: 'continuity', sessionId: 'a', tabId: 't' })).toEqual({
			type: 'continuity_preview',
			sessionId: 'a',
			tabId: 't',
		});
		expect(
			buildTabContextOpMessage({ op: 'continuity', sessionId: 'a', targetSessionId: 'b' })
		).toEqual({ type: 'continuity_preview', sessionId: 'a' });
		// The reason it is its own message: an older desktop ignores a flag it does not know.
		expect(TAB_CONTEXT_OP_MESSAGES.continuity.type).not.toBe(TAB_CONTEXT_OP_MESSAGES.compact.type);
	});

	it('parses a continuity message like a compact one, and round-trips it', () => {
		const request = { op: 'continuity' as const, sessionId: 'a', tabId: 't' };
		expect(parseTabContextOpMessage('continuity', buildTabContextOpMessage(request))).toEqual({
			ok: true,
			request,
		});
		expect(parseTabContextOpMessage('continuity', {})).toEqual({
			ok: false,
			error: 'Missing sessionId',
		});
		expect(parseTabContextOpMessage('continuity', { sessionId: 'a', tabId: ' ' })).toEqual({
			ok: false,
			error: 'tabId must be a non-empty string when provided',
		});
	});

	it('waits seconds for a preview, not the minutes a compaction runs', () => {
		expect(TAB_CONTEXT_OP_REPLY_MS.continuity).toBeLessThan(TAB_CONTEXT_OP_REPLY_MS.compact);
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

	describe('a continuity preview in a reply', () => {
		const wire = (overrides: Record<string, unknown> = {}) => ({
			text: 'Continuity preview of tab tab-1\n- a notice',
			entries: 3,
			synopses: { shown: 1, refused: { 'other-tab': 2 } },
			notices: ['one notice'],
			unknowns: ['objective: no goal'],
			...overrides,
		});
		const received = (continuity: unknown) =>
			normalizeTabContextOpResult({ success: true, continuity }).continuity;

		it('keeps a well-formed preview as it is', () => {
			expect(received(wire())).toEqual(wire());
		});

		it('removes control characters from everything it will print', () => {
			const hostile = received(
				wire({
					text: 'Done\u001b[2J\r\nnext‮ line\u0007',
					notices: ['n\u001b]0;title\u0007ote'],
					unknowns: ['f\u0000: r'],
					synopses: { shown: 0, refused: { 'bad\u001bkey': 1 } },
				})
			);
			expect(hostile?.text).toBe('Done[2J\nnext line');
			expect(hostile?.notices).toEqual(['n]0;title' + 'ote']);
			expect(hostile?.unknowns).toEqual(['f: r']);
			expect(Object.keys(hostile?.synopses.refused ?? {})).toEqual(['badkey']);
		});

		it('cuts a text longer than the limit and says so, instead of passing it on whole', () => {
			const long = received(wire({ text: 'x'.repeat(MAX_CONTINUITY_TEXT_CHARS + 500) }));
			expect(long?.text.startsWith('x'.repeat(MAX_CONTINUITY_TEXT_CHARS))).toBe(true);
			expect(long?.text).toContain('[cut: the preview is longer than');
			expect(long?.text.length).toBeLessThan(MAX_CONTINUITY_TEXT_CHARS + 120);
		});

		it('bounds the lists and each line in them, and keeps only strings', () => {
			const many = received(
				wire({
					notices: Array.from({ length: 80 }, (_, i) => `notice ${i}`),
					unknowns: ['x'.repeat(5_000), 7, null, { a: 1 }, 'kept'],
				})
			);
			expect(many?.notices).toHaveLength(50);
			expect(many?.unknowns).toHaveLength(2);
			expect(many?.unknowns[0]).toHaveLength(1_000);
			expect(many?.unknowns[1]).toBe('kept');
		});

		it('keeps only whole, non-negative counts', () => {
			const counted = received(
				wire({ synopses: { shown: 2, refused: { a: 1, b: -1, c: 1.5, d: '3', e: 0 } } })
			);
			expect(counted?.synopses.refused).toEqual({ a: 1, e: 0 });
		});

		it.each([
			['not an object', 'text'],
			['no text', wire({ text: undefined })],
			['an empty text', wire({ text: '' })],
			['a text that is not a string', wire({ text: 42 })],
			['no entry count', wire({ entries: undefined })],
			['a negative entry count', wire({ entries: -1 })],
			['a fractional entry count', wire({ entries: 1.5 })],
			['no synopsis block', wire({ synopses: undefined })],
			['a shown count that is not a number', wire({ synopses: { shown: 'one', refused: {} } })],
		])('drops a preview with %s, so the caller reports a desktop that sent none', (_label, bad) => {
			expect(received(bad)).toBeUndefined();
		});

		it('tolerates missing lists and a missing refusal map', () => {
			const lean = received({ text: 't', entries: 0, synopses: { shown: 0 } });
			expect(lean).toEqual({
				text: 't',
				entries: 0,
				synopses: { shown: 0, refused: {} },
				notices: [],
				unknowns: [],
			});
		});

		it('keeps a refusal and a preview apart: a failed result may still carry neither', () => {
			expect(
				normalizeTabContextOpResult({ success: false, error: 'Tab x is not an AI tab of agent a' })
			).toEqual({ success: false, error: 'Tab x is not an AI tab of agent a' });
		});
	});
});
