// Source: src/__tests__/main/web-server/handlers/messagePinHandler.test.ts
// Source: src/__tests__/main/web-server/handlers/closedTabHandler.test.ts
// Source: src/__tests__/main/web-server/handlers/contextOpsHandler.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { WebSocketMessageHandler } from '../../../../main/web-server/handlers/messageHandlers';
import type { WebClient } from '../../../../main/web-server/handlers/messageHandlers';
import WebSocket from 'ws';
import { normalizeClosedTabCommandResult } from '../../../../shared/closedTabCommands';
import { parseClosedTabCommandRequest } from '../../../../shared/closedTabCommands';
import { buildTabContextOpMessage } from '../../../../shared/tabContextOps';
import { normalizeTabContextOpResult } from '../../../../shared/tabContextOps';
import { parseTabContextOpMessage } from '../../../../shared/tabContextOps';
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/plugins/plugin-manager-singleton', () => ({
	getPluginManager: () => null,
	getActivePluginManager: () => null,
	isPluginsFeatureEnabled: () => false,
}));
describeSourceSuite('messagePinHandler', () => {
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

	const PIN = {
		id: 'pin-1',
		label: 'Key decision',
		title: 'Key decision',
		renamed: false,
		source: 'stdout',
		timestamp: 1,
		pinnedAt: 2,
		messageId: 'log-1',
		loaded: true,
	};

	describe('message_pin_command handler', () => {
		let handler: WebSocketMessageHandler;
		let client: WebClient;
		let messagePinCommand: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			handler = new WebSocketMessageHandler();
			client = createMockClient();
			messagePinCommand = vi.fn().mockResolvedValue({ success: true, pin: PIN, pins: [PIN] });
			handler.setCallbacks({
				messagePinCommand,
				getSessionDetail: vi.fn(() => ({ id: 'agent-1' })),
			} as never);
		});

		it('forwards a validated add and replies with the pins and the request id', async () => {
			handler.handleMessage(client, {
				type: 'message_pin_command',
				requestId: 'req-1',
				action: 'add',
				sessionId: 'agent-1',
				tabId: 'tab-1',
				last: 'agent',
			});
			await flush();

			expect(messagePinCommand).toHaveBeenCalledWith({
				action: 'add',
				sessionId: 'agent-1',
				tabId: 'tab-1',
				last: 'agent',
			});
			expect(lastResponse(client)).toMatchObject({
				type: 'message_pin_command_result',
				requestId: 'req-1',
				success: true,
				pin: PIN,
				pins: [PIN],
			});
		});

		it('refuses an add that names both a message and --last without reaching the renderer', () => {
			handler.handleMessage(client, {
				type: 'message_pin_command',
				requestId: 'req-2',
				action: 'add',
				sessionId: 'agent-1',
				tabId: 'tab-1',
				messageId: 'log-1',
				last: 'user',
			});

			expect(messagePinCommand).not.toHaveBeenCalled();
			expect(lastResponse(client)).toMatchObject({
				type: 'message_pin_command_result',
				requestId: 'req-2',
				success: false,
				error: 'Name the message by id or by --last, not both',
			});
		});

		it('refuses an unknown agent by name', () => {
			handler.setCallbacks({
				messagePinCommand,
				getSessionDetail: vi.fn(() => undefined),
			} as never);
			handler.handleMessage(client, {
				type: 'message_pin_command',
				requestId: 'req-3',
				action: 'list',
				sessionId: 'ghost-agent',
				tabId: 'tab-1',
			});

			expect(messagePinCommand).not.toHaveBeenCalled();
			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-3',
				success: false,
				error: 'Session not found: ghost-agent',
			});
		});

		it('answers when no renderer callback is wired', () => {
			// setCallbacks merges, so start from a handler that never had one.
			handler = new WebSocketMessageHandler();
			handler.setCallbacks({ getSessionDetail: vi.fn(() => ({ id: 'agent-1' })) } as never);
			handler.handleMessage(client, {
				type: 'message_pin_command',
				requestId: 'req-4',
				action: 'list',
				sessionId: 'agent-1',
				tabId: 'tab-1',
			});

			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-4',
				success: false,
				error: 'Message pins are not configured',
			});
		});

		it('answers rather than hanging when the renderer round trip rejects', async () => {
			messagePinCommand.mockRejectedValue(new Error('window closed'));
			handler.handleMessage(client, {
				type: 'message_pin_command',
				requestId: 'req-5',
				action: 'remove',
				sessionId: 'agent-1',
				tabId: 'tab-1',
				pinId: 'pin-1',
			});
			await flush();

			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-5',
				success: false,
				error: 'Pin remove failed: window closed',
			});
		});
	});
});
describeSourceSuite('closedTabHandler', () => {
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

	describe('closed_tab_command handler', () => {
		let handler: WebSocketMessageHandler;
		let client: WebClient;
		let closedTabCommand: ReturnType<typeof vi.fn>;

		beforeEach(() => {
			handler = new WebSocketMessageHandler();
			client = createMockClient();
			closedTabCommand = vi.fn().mockResolvedValue({
				success: true,
				tabId: 'new-tab',
				tabType: 'ai',
				reopened: { index: 0, type: 'ai', label: 'Chat', tabId: 'old-tab', closedAt: 1 },
				content: 'loaded',
			});
			handler.setCallbacks({
				closedTabCommand,
				getSessionDetail: vi.fn(() => ({ id: 'session-1' })),
			} as never);
		});

		it('forwards a reopen and replies with the restored tab id and the request id', async () => {
			handler.handleMessage(client, {
				type: 'closed_tab_command',
				requestId: 'req-1',
				action: 'reopen',
				sessionId: 'session-1',
				index: 0,
				background: true,
			});
			await flush();

			expect(closedTabCommand).toHaveBeenCalledWith({
				action: 'reopen',
				sessionId: 'session-1',
				index: 0,
				background: true,
			});
			expect(lastResponse(client)).toMatchObject({
				type: 'closed_tab_command_result',
				requestId: 'req-1',
				success: true,
				tabId: 'new-tab',
				tabType: 'ai',
			});
		});

		it('forwards a list without reopen-only fields', async () => {
			closedTabCommand.mockResolvedValue({ success: true, closedTabs: [] });
			handler.handleMessage(client, {
				type: 'closed_tab_command',
				requestId: 'req-2',
				action: 'list',
				sessionId: 'session-1',
				index: 3,
			});
			await flush();

			expect(closedTabCommand).toHaveBeenCalledWith({ action: 'list', sessionId: 'session-1' });
			expect(lastResponse(client)).toMatchObject({ requestId: 'req-2', closedTabs: [] });
		});

		it('refuses an index together with a tab id without reaching the renderer', () => {
			handler.handleMessage(client, {
				type: 'closed_tab_command',
				requestId: 'req-3',
				action: 'reopen',
				sessionId: 'session-1',
				index: 1,
				tabId: 'abc',
			});

			expect(closedTabCommand).not.toHaveBeenCalled();
			expect(lastResponse(client)).toMatchObject({
				type: 'closed_tab_command_result',
				requestId: 'req-3',
				success: false,
				error: 'Name the closed tab by index or by tab id, not both',
			});
		});

		it('refuses an unknown agent by name', () => {
			handler.setCallbacks({ getSessionDetail: vi.fn(() => undefined) } as never);
			handler.handleMessage(client, {
				type: 'closed_tab_command',
				requestId: 'req-4',
				action: 'list',
				sessionId: 'ghost-agent',
			});

			expect(closedTabCommand).not.toHaveBeenCalled();
			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-4',
				success: false,
				error: 'Session not found: ghost-agent',
			});
		});

		it('answers rather than hanging when the renderer round trip rejects', async () => {
			closedTabCommand.mockRejectedValue(new Error('window closed'));
			handler.handleMessage(client, {
				type: 'closed_tab_command',
				requestId: 'req-5',
				action: 'reopen',
				sessionId: 'session-1',
			});
			await flush();

			expect(lastResponse(client)).toMatchObject({
				requestId: 'req-5',
				success: false,
				error: 'Closed-tab reopen failed: window closed',
			});
		});
	});

	describe('parseClosedTabCommandRequest', () => {
		it('requires a known action and a sessionId', () => {
			expect(parseClosedTabCommandRequest({ action: 'nope', sessionId: 's' }).ok).toBe(false);
			expect(parseClosedTabCommandRequest({ action: 'list' })).toEqual({
				ok: false,
				error: 'Closed-tab list requires a sessionId',
			});
		});

		it('refuses a negative or fractional index', () => {
			for (const index of [-1, 1.5, '2']) {
				expect(parseClosedTabCommandRequest({ action: 'reopen', sessionId: 's', index })).toEqual({
					ok: false,
					error: 'index must be a non-negative integer',
				});
			}
		});

		it('treats only a literal true as background', () => {
			const parsed = parseClosedTabCommandRequest({
				action: 'reopen',
				sessionId: 's',
				background: 'yes',
			});
			expect(parsed).toEqual({ ok: true, request: { action: 'reopen', sessionId: 's' } });
		});
	});

	describe('normalizeClosedTabCommandResult', () => {
		it('turns a malformed reply into a failure', () => {
			expect(normalizeClosedTabCommandResult(null)).toEqual({
				success: false,
				error: 'Invalid closed-tab response',
			});
			expect(normalizeClosedTabCommandResult({ success: 'yes' })).toEqual({
				success: false,
				error: 'Closed-tab command failed',
			});
		});

		it('keeps known fields and drops unknown values', () => {
			expect(
				normalizeClosedTabCommandResult({
					success: true,
					tabId: 't',
					tabType: 'spaceship',
					content: 'pending',
					wasDuplicate: false,
					extra: 1,
				})
			).toEqual({ success: true, tabId: 't', content: 'pending' });
		});
	});
});
describeSourceSuite('contextOpsHandler', () => {
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
			expect(
				normalizeTabContextOpResult({ success: false, timedOut: true, error: 'slow' })
			).toEqual({
				success: false,
				timedOut: true,
				error: 'slow',
			});
		});
	});
});
