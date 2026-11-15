/**
 * @file browser-pick.test.ts
 * @description Tests for `maestro-cli browser-pick` (Design Mode by selector).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveSessionId: vi.fn(() => 'active-session'),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => `resolved-${id}`),
	readActiveAgentId: vi.fn((): string | null => 'active-session'),
}));

import { browserPick } from '../../../cli/commands/open-browser';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readActiveAgentId } from '../../../cli/services/storage';

type SentMessage = Record<string, unknown>;

/** Stub the desktop: record what the CLI sent and answer with `reply`. */
function stubDesktop(reply: Record<string, unknown>) {
	const sent: Array<{ message: SentMessage; responseType: string; timeoutMs?: number }> = [];
	vi.mocked(withMaestroClient).mockImplementation(async (fn) => {
		const client = {
			sendCommand: vi.fn(async (message: SentMessage, responseType: string, timeoutMs?: number) => {
				sent.push({ message, responseType, timeoutMs });
				return { type: responseType, ...reply };
			}),
		};
		return fn(client as never);
	});
	return sent;
}

describe('browser-pick command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
	});

	it('sends pick_browser_element with the selector, note, and placement', async () => {
		const sent = stubDesktop({
			success: true,
			tabId: 'tab-uuid',
			browserId: 'browser:2',
			aiTabId: 'ai-1',
			screenshot: true,
			text: 'Element ...',
		});

		await browserPick('browser:2', {
			selector: ' .hero h1 ',
			note: 'make it bigger',
			agent: 'agent-7',
			background: true,
		});

		expect(sent).toHaveLength(1);
		expect(sent[0].responseType).toBe('pick_browser_element_result');
		expect(sent[0].timeoutMs).toBeGreaterThan(10_000);
		expect(sent[0].message).toEqual({
			type: 'pick_browser_element',
			sessionId: 'resolved-agent-7',
			tab: 'browser:2',
			selector: '.hero h1',
			note: 'make it bigger',
			background: true,
		});
		expect(logSpy).toHaveBeenCalledWith(
			'Added .hero h1 from browser:2 to the composer of tab ai-1 (background)'
		);
		expect(logSpy).toHaveBeenCalledWith('  Coworking id: browser:2');
		expect(logSpy).toHaveBeenCalledWith('  Screenshot: attached');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('defaults to the active agent and to focusing, like a click', async () => {
		const sent = stubDesktop({ success: true, tabId: 'tab-uuid', aiTabId: 'ai-1' });

		await browserPick('tab-uuid', { selector: 'button' });

		expect(sent[0].message.sessionId).toBe('active-session');
		expect(sent[0].message.background).toBe(false);
		expect(sent[0].message).not.toHaveProperty('note');
		expect(logSpy).toHaveBeenCalledWith('  Screenshot: none');
	});

	it('prints the result fields as JSON', async () => {
		stubDesktop({
			success: true,
			tabId: 'tab-uuid',
			aiTabId: 'ai-1',
			screenshot: false,
			text: 'the draft text',
		});

		await browserPick('tab-uuid', { selector: 'button', json: true });

		const out = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(out).toMatchObject({
			success: true,
			sessionId: 'active-session',
			tabId: 'tab-uuid',
			browserId: null,
			aiTabId: 'ai-1',
			selector: 'button',
			screenshot: false,
			text: 'the draft text',
		});
	});

	it('refuses a missing selector without calling the desktop', async () => {
		stubDesktop({ success: true });

		await browserPick('tab-uuid', { selector: '  ' });

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith('Error: --selector is required');
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('reports the desktop error and exits 1', async () => {
		stubDesktop({ success: false, error: 'No element matches selector: .nope' });

		await browserPick('tab-uuid', { selector: '.nope', json: true });

		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: false,
			error: 'No element matches selector: .nope',
		});
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it('defaults to the active agent, and refuses when none is recorded', async () => {
		const sent = stubDesktop({ success: true, aiTabId: 'ai-1', screenshot: false });
		await browserPick('browser:2', { selector: 'h1' });
		expect(sent[0].message.sessionId).toBe('active-session');

		vi.mocked(readActiveAgentId).mockReturnValueOnce(null);
		const before = sent.length;
		await browserPick('browser:2', { selector: 'h1' });
		expect(sent.length).toBe(before);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No active agent recorded'));
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
