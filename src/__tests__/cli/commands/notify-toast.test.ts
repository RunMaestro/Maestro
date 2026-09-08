/**
 * @file notify-toast.test.ts
 * @description Tests for the notify-toast CLI command's click-action flags.
 *
 * `maestro-cli notify toast` is the only producer of a toast that cannot pass a
 * callback, so the `--open-*` flags are the whole click contract. They are
 * mutually exclusive and all but `--open-url` need an agent, and getting either
 * rule wrong ships a toast whose click silently does nothing. These tests pin
 * the flag -> `clickAction` mapping that crosses the WebSocket bridge.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((ref: string) => (ref === 'missing' ? undefined : 'session-123')),
}));

import { notifyToast } from '../../../cli/commands/notify-toast';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { ToastClickAction } from '../../../shared/toastClickAction';

interface CapturedToast {
	type?: string;
	sessionId?: string;
	tabId?: string;
	clickAction?: ToastClickAction;
}

describe('notify-toast command click actions', () => {
	let captured: CapturedToast;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		captured = {};
		vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// Mocked so an error path keeps running and we can assert on BOTH the
		// message and the non-zero exit, the way the other CLI tests do.
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					captured = msg;
					return Promise.resolve({ type: 'notify_toast_result', success: true });
				}),
			};
			return action(mockClient as never);
		});
	});

	const errors = (): string => consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');

	it('sends no clickAction when no agent and no --open-* flag are given', async () => {
		await notifyToast('Title', 'Message', {});

		expect(captured.type).toBe('notify_toast');
		expect(captured.clickAction).toBeUndefined();
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('maps --open-file to an open-file action scoped to the agent', async () => {
		await notifyToast('Title', 'Message', { agent: 'Test Agent', openFile: '/tmp/report.md' });

		expect(captured.clickAction).toEqual({
			kind: 'open-file',
			sessionId: 'session-123',
			path: '/tmp/report.md',
		});
	});

	it('maps a bare --open-terminal to an open-terminal action with no tabRef', async () => {
		// Commander gives `true` for a bare `[tab]` option. Bare means "the
		// agent's active terminal tab", which the renderer expresses as an
		// absent tabRef rather than an empty string.
		await notifyToast('Title', 'Message', { agent: 'Test Agent', openTerminal: true });

		expect(captured.clickAction).toEqual({
			kind: 'open-terminal',
			sessionId: 'session-123',
			tabRef: undefined,
		});
	});

	it('maps --open-terminal with a value to that tab ref', async () => {
		await notifyToast('Title', 'Message', { agent: 'Test Agent', openTerminal: 'Dev server' });

		expect(captured.clickAction).toEqual({
			kind: 'open-terminal',
			sessionId: 'session-123',
			tabRef: 'Dev server',
		});
	});

	it('maps --open-browser to a url-carrying open-browser action', async () => {
		await notifyToast('Title', 'Message', {
			agent: 'Test Agent',
			openBrowser: 'https://example.com',
		});

		expect(captured.clickAction).toEqual({
			kind: 'open-browser',
			sessionId: 'session-123',
			url: 'https://example.com',
			tabId: undefined,
		});
	});

	it('maps --open-browser-tab to a tabId-carrying open-browser action', async () => {
		await notifyToast('Title', 'Message', { agent: 'Test Agent', openBrowserTab: 'tab-9' });

		expect(captured.clickAction).toEqual({
			kind: 'open-browser',
			sessionId: 'session-123',
			url: undefined,
			tabId: 'tab-9',
		});
	});

	it('maps --open-url to a system-browser action needing no agent', async () => {
		await notifyToast('Title', 'Message', { openUrl: 'https://example.com/docs' });

		expect(captured.clickAction).toEqual({ kind: 'open-url', url: 'https://example.com/docs' });
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('leaves the agent jump to the legacy fields when no --open-* flag is given', async () => {
		// A plain `--agent` jump predates click actions and still rides the flat
		// `sessionId` / `tabId` fields, so no clickAction is synthesized for it.
		await notifyToast('Title', 'Message', { agent: 'Test Agent', tab: 'tab-1' });

		expect(captured.clickAction).toBeUndefined();
		expect(captured.sessionId).toBe('session-123');
		expect(captured.tabId).toBe('tab-1');
	});

	it.each([
		['--open-file', { openFile: '/tmp/a.md' }],
		['--open-terminal', { openTerminal: true as const }],
		['--open-browser', { openBrowser: 'https://example.com' }],
		['--open-browser-tab', { openBrowserTab: 'tab-9' }],
	])('rejects %s without --agent', async (flag, options) => {
		await notifyToast('Title', 'Message', options);

		expect(errors()).toContain(`Error: ${flag} requires --agent`);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('rejects two --open-* flags as mutually exclusive', async () => {
		await notifyToast('Title', 'Message', {
			agent: 'Test Agent',
			openFile: '/tmp/a.md',
			openUrl: 'https://example.com',
		});

		expect(errors()).toContain('--open-file, --open-url are mutually exclusive');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('names every offending flag when more than two collide', async () => {
		await notifyToast('Title', 'Message', {
			agent: 'Test Agent',
			openFile: '/tmp/a.md',
			openTerminal: true,
			openBrowser: 'https://example.com',
		});

		const message = errors();
		expect(message).toContain('--open-file');
		expect(message).toContain('--open-terminal');
		expect(message).toContain('--open-browser');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('treats empty --open-* values as absent rather than as a collision', async () => {
		// Commander hands back '' for a flag given with an empty value; that must
		// not count toward the mutual-exclusion tally or the toast loses its
		// legitimate jump-session fallback.
		await notifyToast('Title', 'Message', { agent: 'Test Agent', openFile: '', openUrl: '' });

		expect(processExitSpy).not.toHaveBeenCalled();
		expect(captured.clickAction).toBeUndefined();
		expect(captured.sessionId).toBe('session-123');
	});
});
