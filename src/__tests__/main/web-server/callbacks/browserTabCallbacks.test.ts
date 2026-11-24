import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	ipcMain: { once: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => true),
}));

import { pickBrowserElement } from '../../../../main/web-server/callbacks/browserTabCallbacks';
import { CoworkingRegistry } from '../../../../main/coworking/coworking-registry';
import type { BrowserOp, BrowserOpResult } from '../../../../shared/coworkingBrowser';

function tabInput(tabUuid: string, hiddenFromAgent = false) {
	return {
		tabUuid,
		url: 'https://example.com',
		title: 'Example',
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
		hiddenFromAgent,
	};
}

describe('pickBrowserElement (browser-pick)', () => {
	let registry: CoworkingRegistry;
	let run: ReturnType<
		typeof vi.fn<(s: string, t: string, op: BrowserOp) => Promise<BrowserOpResult>>
	>;

	beforeEach(() => {
		registry = new CoworkingRegistry();
		registry.syncSessionBrowsers('s1', [tabInput('uuid-a'), tabInput('uuid-b', true)], false);
		run = vi.fn(async () => ({
			ok: true,
			content: 'Element `h1` ...',
			dataUrl: 'data:image/png;base64,AAAA',
			aiTabId: 'ai-1',
			pickId: 'pick-1',
		}));
	});

	it('resolves a Coworking id and runs the host-only pick op through the resolver', async () => {
		const result = await pickBrowserElement(
			{ sessionId: 's1', tab: 'browser:1', selector: ' h1 ', note: 'bigger', background: true },
			{ registry, run }
		);
		expect(run).toHaveBeenCalledWith('s1', 'uuid-a', {
			kind: 'pick',
			selector: 'h1',
			note: 'bigger',
			background: true,
		});
		expect(result).toEqual({
			success: true,
			tabId: 'uuid-a',
			browserId: 'browser:1',
			text: 'Element `h1` ...',
			screenshot: true,
			aiTabId: 'ai-1',
			pickId: 'pick-1',
		});
	});

	it('names no chip when the renderer reports none, or the pick failed', async () => {
		run.mockResolvedValueOnce({ ok: true, content: 'Element `h1` ...', aiTabId: 'ai-1' });
		const staged = await pickBrowserElement(
			{ sessionId: 's1', tab: 'uuid-a', selector: 'h1' },
			{ registry, run }
		);
		expect(staged).not.toHaveProperty('pickId');

		run.mockResolvedValueOnce({ ok: false, content: 'No element matches', pickId: 'stale' });
		const failed = await pickBrowserElement(
			{ sessionId: 's1', tab: 'uuid-a', selector: 'h1' },
			{ registry, run }
		);
		expect(failed).toMatchObject({ success: false, error: 'No element matches' });
		expect(failed).not.toHaveProperty('pickId');
	});

	it('passes a renderer tab id straight through and omits an empty note', async () => {
		const result = await pickBrowserElement(
			{ sessionId: 's1', tab: 'uuid-a', selector: 'h1' },
			{ registry, run }
		);
		expect(run).toHaveBeenCalledWith('s1', 'uuid-a', {
			kind: 'pick',
			selector: 'h1',
			background: false,
		});
		expect(result.browserId).toBe('browser:1');
	});

	describe('queue', () => {
		it('asks the renderer to queue the pick and names the queued message, not a chip', async () => {
			run.mockResolvedValueOnce({
				ok: true,
				content: 'Element `h1` ...',
				dataUrl: 'data:image/png;base64,AAAA',
				aiTabId: 'ai-1',
				queueItemId: 'queue-1',
			});
			const result = await pickBrowserElement(
				{ sessionId: 's1', tab: 'browser:1', selector: 'h1', note: 'bigger', queue: true },
				{ registry, run }
			);
			expect(run).toHaveBeenCalledWith('s1', 'uuid-a', {
				kind: 'pick',
				selector: 'h1',
				note: 'bigger',
				background: false,
				queue: true,
			});
			expect(result).toEqual({
				success: true,
				tabId: 'uuid-a',
				browserId: 'browser:1',
				text: 'Element `h1` ...',
				screenshot: true,
				aiTabId: 'ai-1',
				queueItemId: 'queue-1',
			});
		});

		it('leaves queue off the op unless the request says exactly true', async () => {
			await pickBrowserElement(
				{ sessionId: 's1', tab: 'uuid-a', selector: 'h1', queue: false },
				{ registry, run }
			);
			const unset = await pickBrowserElement(
				{ sessionId: 's1', tab: 'uuid-a', selector: 'h1' },
				{ registry, run }
			);
			for (const call of run.mock.calls) expect(call[2]).not.toHaveProperty('queue');
			// And a chip pick names a chip, never a queue item.
			expect(unset).toMatchObject({ pickId: 'pick-1' });
			expect(unset).not.toHaveProperty('queueItemId');
		});

		it('names no queue item when the renderer reports none, or the pick failed', async () => {
			run.mockResolvedValueOnce({ ok: true, content: 'Element `h1` ...', aiTabId: 'ai-1' });
			const queued = await pickBrowserElement(
				{ sessionId: 's1', tab: 'uuid-a', selector: 'h1', queue: true },
				{ registry, run }
			);
			expect(queued).not.toHaveProperty('queueItemId');

			run.mockResolvedValueOnce({ ok: false, content: 'No AI tab', queueItemId: 'stale' });
			const failed = await pickBrowserElement(
				{ sessionId: 's1', tab: 'uuid-a', selector: 'h1', queue: true },
				{ registry, run }
			);
			expect(failed).toMatchObject({ success: false, error: 'No AI tab' });
			expect(failed).not.toHaveProperty('queueItemId');
		});
	});

	it('refuses a Coworking id for a hidden tab without reaching the renderer', async () => {
		const result = await pickBrowserElement(
			{ sessionId: 's1', tab: 'browser:2', selector: 'h1' },
			{ registry, run }
		);
		expect(run).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.error).toContain('No browser tab browser:2 in this agent');
	});

	it('does not name a Coworking id for a hidden tab addressed by its tab id', async () => {
		const result = await pickBrowserElement(
			{ sessionId: 's1', tab: 'uuid-b', selector: 'h1' },
			{ registry, run }
		);
		expect(result.success).toBe(true);
		expect(result).not.toHaveProperty('browserId');
	});

	it('reports the renderer error when the pick fails', async () => {
		run.mockRejectedValueOnce(new Error('No element matches selector: .nope'));
		const result = await pickBrowserElement(
			{ sessionId: 's1', tab: 'uuid-a', selector: '.nope' },
			{ registry, run }
		);
		expect(result).toEqual({
			success: false,
			error: 'No element matches selector: .nope',
			tabId: 'uuid-a',
			screenshot: false,
		});
	});

	it('refuses an empty selector', async () => {
		const result = await pickBrowserElement(
			{ sessionId: 's1', tab: 'uuid-a', selector: '  ' },
			{ registry, run }
		);
		expect(run).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: false,
			error: 'Missing selector or rect',
			screenshot: false,
		});
	});

	describe('region (browser-pick --rect)', () => {
		const rect = { x: 0, y: 120, width: 1280, height: 400 };

		it('runs the pick op with the rect in place of a selector', async () => {
			run.mockResolvedValueOnce({
				ok: true,
				content: 'Design Mode region ...',
				dataUrl: 'data:image/png;base64,AAAA',
				aiTabId: 'ai-1',
				queueItemId: 'queue-2',
			});
			const result = await pickBrowserElement(
				{ sessionId: 's1', tab: 'browser:1', rect, note: 'tighten', queue: true },
				{ registry, run }
			);
			expect(run).toHaveBeenCalledTimes(1);
			// No selector key at all: the renderer tells the two apart by which is set.
			expect(run.mock.calls[0][2]).toStrictEqual({
				kind: 'pick',
				rect,
				note: 'tighten',
				background: false,
				queue: true,
			});
			expect(result).toEqual({
				success: true,
				tabId: 'uuid-a',
				browserId: 'browser:1',
				text: 'Design Mode region ...',
				screenshot: true,
				aiTabId: 'ai-1',
				queueItemId: 'queue-2',
			});
		});

		it('refuses a malformed rect, or a rect beside a selector, without reaching the renderer', async () => {
			const malformed = await pickBrowserElement(
				{ sessionId: 's1', tab: 'uuid-a', rect: { ...rect, width: 0 } },
				{ registry, run }
			);
			expect(malformed).toMatchObject({ success: false, screenshot: false });
			expect(malformed.error).toContain('Invalid rect');

			const both = await pickBrowserElement(
				// The type forbids it; a caller that is not type-checked can still send it.
				{ sessionId: 's1', tab: 'uuid-a', selector: 'h1', rect } as never,
				{ registry, run }
			);
			expect(both).toEqual({
				success: false,
				error: 'Send a selector or a rect, not both',
				screenshot: false,
			});
			expect(run).not.toHaveBeenCalled();
		});

		it('reports the renderer error for a region off the page', async () => {
			run.mockRejectedValueOnce(
				new Error("No part of the region 0,120,1280,400 is in the page's viewport")
			);
			const result = await pickBrowserElement(
				{ sessionId: 's1', tab: 'uuid-a', rect },
				{ registry, run }
			);
			expect(result).toEqual({
				success: false,
				error: "No part of the region 0,120,1280,400 is in the page's viewport",
				tabId: 'uuid-a',
				screenshot: false,
			});
		});
	});
});
