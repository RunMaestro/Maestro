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
		expect(result).toEqual({ success: false, error: 'Missing selector', screenshot: false });
	});
});
