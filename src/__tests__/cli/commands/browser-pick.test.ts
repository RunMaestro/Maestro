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
			pickId: 'pick-9',
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
		// The summary, the chip id, then the block the chip adds at send, in that order.
		expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
			'Added .hero h1 from browser:2 to the composer of tab ai-1 (background)',
			'  Chip: pick-9',
			'  Coworking id: browser:2',
			'  Screenshot: attached',
			'\nElement ...',
		]);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('defaults to the active agent and to focusing, like a click', async () => {
		const sent = stubDesktop({ success: true, tabId: 'tab-uuid', aiTabId: 'ai-1' });

		await browserPick('tab-uuid', { selector: 'button' });

		expect(sent[0].message.sessionId).toBe('active-session');
		expect(sent[0].message.background).toBe(false);
		expect(sent[0].message).not.toHaveProperty('note');
		// A chip is the default: nothing on the wire asks for a queued message.
		expect(sent[0].message).not.toHaveProperty('queue');
		// No chip id and no block in the reply: no line for either.
		expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
			'Added button from tab-uuid to the composer of tab ai-1',
			'  Screenshot: none',
		]);
	});

	it('prints the result fields as JSON, the chip id included', async () => {
		stubDesktop({
			success: true,
			tabId: 'tab-uuid',
			aiTabId: 'ai-1',
			pickId: 'pick-9',
			screenshot: false,
			text: 'the element block',
		});

		await browserPick('tab-uuid', { selector: 'button', json: true });

		expect(logSpy).toHaveBeenCalledTimes(1);
		const out = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(out).toMatchObject({
			success: true,
			sessionId: 'active-session',
			tabId: 'tab-uuid',
			browserId: null,
			aiTabId: 'ai-1',
			pickId: 'pick-9',
			selector: 'button',
			screenshot: false,
			text: 'the element block',
		});
	});

	it('reports a null chip id in JSON when the desktop sends none', async () => {
		stubDesktop({ success: true, tabId: 'tab-uuid', aiTabId: 'ai-1', screenshot: false });

		await browserPick('tab-uuid', { selector: 'button', json: true });

		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			pickId: null,
			queueItemId: null,
			text: '',
		});
	});

	describe('--queue', () => {
		it('asks for a queued message and prints the queue item, not a chip', async () => {
			const sent = stubDesktop({
				success: true,
				tabId: 'tab-uuid',
				browserId: 'browser:2',
				aiTabId: 'ai-1',
				queueItemId: 'queue-9',
				screenshot: true,
				text: 'Element ...',
			});

			await browserPick('browser:2', {
				selector: '.hero h1',
				note: 'make it bigger',
				agent: 'agent-7',
				queue: true,
			});

			expect(sent).toHaveLength(1);
			expect(sent[0].responseType).toBe('pick_browser_element_result');
			expect(sent[0].message).toEqual({
				type: 'pick_browser_element',
				sessionId: 'resolved-agent-7',
				tab: 'browser:2',
				selector: '.hero h1',
				note: 'make it bigger',
				background: false,
				queue: true,
			});
			// The summary, the queue item id, then the same block a chip would carry.
			expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
				'Queued .hero h1 from browser:2 for tab ai-1 as its own message',
				'  Queue item: queue-9',
				'  Coworking id: browser:2',
				'  Screenshot: attached',
				'\nElement ...',
			]);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('says nothing about background: a queued pick never moves the view', async () => {
			const sent = stubDesktop({
				success: true,
				aiTabId: 'ai-1',
				queueItemId: 'queue-9',
				screenshot: false,
			});

			await browserPick('tab-uuid', { selector: 'button', queue: true, background: true });

			// The flag still travels (the desktop echoes it), but the summary does not
			// promise a "(background)" the queue path has no use for.
			expect(sent[0].message).toMatchObject({ background: true, queue: true });
			expect(logSpy.mock.calls[0][0]).toBe(
				'Queued button from tab-uuid for tab ai-1 as its own message'
			);
		});

		it('prints no queue item line when the desktop sends none', async () => {
			stubDesktop({ success: true, aiTabId: 'ai-1', screenshot: false });

			await browserPick('tab-uuid', { selector: 'button', queue: true });

			expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
				'Queued button from tab-uuid for tab ai-1 as its own message',
				'  Screenshot: none',
			]);
		});

		it('returns the queue item id in JSON and no chip id', async () => {
			stubDesktop({
				success: true,
				tabId: 'tab-uuid',
				aiTabId: 'ai-1',
				queueItemId: 'queue-9',
				screenshot: false,
				text: 'the element block',
			});

			await browserPick('tab-uuid', { selector: 'button', queue: true, json: true });

			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
				success: true,
				sessionId: 'active-session',
				aiTabId: 'ai-1',
				pickId: null,
				queueItemId: 'queue-9',
				selector: 'button',
				text: 'the element block',
			});
		});

		it('reports the desktop error and exits 1, as a chip pick does', async () => {
			stubDesktop({
				success: false,
				error: 'This agent has no AI tab to queue the element into.',
			});

			await browserPick('tab-uuid', { selector: 'button', queue: true, json: true });

			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
				success: false,
				error: 'This agent has no AI tab to queue the element into.',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});

	it('refuses a missing selector without calling the desktop', async () => {
		stubDesktop({ success: true });

		await browserPick('tab-uuid', { selector: '  ' });
		await browserPick('tab-uuid', {});

		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(errorSpy.mock.calls.map((call) => call[0])).toEqual([
			'Error: --selector or --rect is required',
			'Error: --selector or --rect is required',
		]);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	describe('--rect', () => {
		it('sends the region in place of a selector and names it in the summary', async () => {
			const sent = stubDesktop({
				success: true,
				tabId: 'tab-uuid',
				browserId: 'browser:2',
				aiTabId: 'ai-1',
				pickId: 'pick-9',
				screenshot: true,
				text: 'Design Mode region ...',
			});

			await browserPick('browser:2', {
				rect: ' 0, 120.5 ,1280,400 ',
				note: 'tighten this',
				agent: 'agent-7',
				background: true,
			});

			expect(sent).toHaveLength(1);
			expect(sent[0].responseType).toBe('pick_browser_element_result');
			expect(sent[0].timeoutMs).toBeGreaterThan(10_000);
			// Numbers on the wire, not the text typed, and no selector.
			expect(sent[0].message).toEqual({
				type: 'pick_browser_element',
				sessionId: 'resolved-agent-7',
				tab: 'browser:2',
				rect: { x: 0, y: 120.5, width: 1280, height: 400 },
				note: 'tighten this',
				background: true,
			});
			expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
				'Added region 0,120.5,1280,400 from browser:2 to the composer of tab ai-1 (background)',
				'  Chip: pick-9',
				'  Coworking id: browser:2',
				'  Screenshot: attached',
				'\nDesign Mode region ...',
			]);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('takes a negative origin: the page clips the box to its viewport', async () => {
			const sent = stubDesktop({ success: true, aiTabId: 'ai-1', screenshot: false });

			await browserPick('tab-uuid', { rect: '-20,-10,300,200' });

			expect(sent[0].message.rect).toEqual({ x: -20, y: -10, width: 300, height: 200 });
		});

		it('prints the region and a null selector in JSON', async () => {
			stubDesktop({
				success: true,
				tabId: 'tab-uuid',
				aiTabId: 'ai-1',
				pickId: 'pick-9',
				screenshot: true,
				text: 'the region block',
			});

			await browserPick('tab-uuid', { rect: '10,20,640,220', json: true });

			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
				success: true,
				sessionId: 'active-session',
				tabId: 'tab-uuid',
				aiTabId: 'ai-1',
				pickId: 'pick-9',
				queueItemId: null,
				selector: null,
				rect: { x: 10, y: 20, width: 640, height: 220 },
				screenshot: true,
				text: 'the region block',
			});
		});

		it('reports a null rect in JSON for a selector pick', async () => {
			stubDesktop({ success: true, aiTabId: 'ai-1', screenshot: false });

			await browserPick('tab-uuid', { selector: 'button', json: true });

			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
				selector: 'button',
				rect: null,
			});
		});

		it('queues a region as its own message with --queue', async () => {
			const sent = stubDesktop({
				success: true,
				aiTabId: 'ai-1',
				queueItemId: 'queue-9',
				screenshot: true,
				text: 'Design Mode region ...',
			});

			await browserPick('browser:2', { rect: '0,0,800,600', queue: true });

			expect(sent[0].message).toEqual({
				type: 'pick_browser_element',
				sessionId: 'active-session',
				tab: 'browser:2',
				rect: { x: 0, y: 0, width: 800, height: 600 },
				background: false,
				queue: true,
			});
			expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
				'Queued region 0,0,800,600 from browser:2 for tab ai-1 as its own message',
				'  Queue item: queue-9',
				'  Screenshot: attached',
				'\nDesign Mode region ...',
			]);
		});

		it('refuses a rect that is not four numbers with a width and height of at least 1', async () => {
			stubDesktop({ success: true });

			for (const rect of [
				'',
				'10,20,640',
				'10,20,640,220,5',
				'a,b,c,d',
				'0,0,0,100',
				'1e3,0,9,9',
			]) {
				errorSpy.mockClear();
				await browserPick('tab-uuid', { rect });
				expect(errorSpy, rect).toHaveBeenCalledWith(
					`Error: --rect must be x,y,width,height in CSS px, with width and height at least 1 (got "${rect}")`
				);
			}
			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('refuses --selector and --rect together, even with one of them blank', async () => {
			stubDesktop({ success: true });

			await browserPick('tab-uuid', { selector: 'h1', rect: '0,0,10,10', json: true });
			await browserPick('tab-uuid', { selector: '', rect: '0,0,10,10', json: true });

			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(logSpy.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
				{ success: false, error: 'Pass --selector or --rect, not both' },
				{ success: false, error: 'Pass --selector or --rect, not both' },
			]);
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('reports the desktop error for a region off the page and exits 1', async () => {
			const miss =
				"No part of the region 5000,5000,100,100 is in the page's viewport (--rect is CSS px from the viewport's top-left corner).";
			stubDesktop({ success: false, error: miss });

			await browserPick('tab-uuid', { rect: '5000,5000,100,100' });

			expect(errorSpy).toHaveBeenCalledWith(`Error: ${miss}`);
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
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
