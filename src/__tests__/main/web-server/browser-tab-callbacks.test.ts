// Source: src/__tests__/main/web-server/browser-tab-admission.test.ts
// Source: src/__tests__/main/web-server/callbacks/browserTabCallbacks.test.ts
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { ipcMain } from 'electron';
import { registerBrowserTabCallbacks } from '../../../main/web-server/callbacks/browserTabCallbacks';
import type { NewAITabWithPromptCallback } from '../../../shared/pianola/pianola-dispatch';
import { pickBrowserElement } from '../../../main/web-server/callbacks/browserTabCallbacks';
import { CoworkingRegistry } from '../../../main/coworking/coworking-registry';
import type { BrowserOp } from '../../../shared/coworkingBrowser';
import type { BrowserOpResult } from '../../../shared/coworkingBrowser';
vi.mock('electron', () => ({
	ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => true),
}));
describe('browser-tab-admission', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	function fixture() {
		let callback!: NewAITabWithPromptCallback;
		const server = new Proxy(
			{},
			{
				get: (_target, key) =>
					key === 'setNewAITabWithPromptCallback'
						? (cb: NewAITabWithPromptCallback) => {
								callback = cb;
							}
						: () => {},
			}
		);
		const window = { webContents: { send: vi.fn() } };
		registerBrowserTabCallbacks(server as never, { getMainWindow: () => window as never });
		const control = { phase: 'prepare' as const, dispatchId: 'dispatch-1', tabId: 'tab-1' };
		return { callback, window, control };
	}
	describe('new-tab admission IPC boundary', () => {
		it('threads the exact phase and accepts synchronous replies only from the owning window', async () => {
			const f = fixture();
			f.window.webContents.send.mockImplementation((_channel, _agent, _prompt, channel) => {
				const reply = vi.mocked(ipcMain.on).mock.calls.find(([key]) => key === channel)![1];
				reply({ sender: {} } as never, { success: true, tabId: 'foreign' });
				reply({ sender: f.window.webContents } as never, { success: true, tabId: 'tab-1' });
			});
			await expect(f.callback('worker', '', true, false, undefined, f.control)).resolves.toEqual({
				success: true,
				tabId: 'tab-1',
			});
			expect(f.window.webContents.send.mock.calls[0][7]).toEqual(f.control);
			expect(vi.getTimerCount()).toBe(0);
		});
		it('reports a lost release acknowledgment as unknown without resending', async () => {
			const f = fixture();
			const pending = f.callback('worker', 'Prompt', true, false, undefined, {
				...f.control,
				phase: 'release',
			});
			await vi.advanceTimersByTimeAsync(5000);
			await expect(pending).resolves.toMatchObject({ success: false, unknown: true });
			expect(f.window.webContents.send).toHaveBeenCalledOnce();
			expect(ipcMain.removeListener).toHaveBeenCalledOnce();
		});
		it('cleans up and keeps uncertainty when sending to the renderer throws', async () => {
			const f = fixture();
			f.window.webContents.send.mockImplementation(() => {
				throw new Error('window destroyed');
			});
			await expect(
				f.callback('worker', 'Prompt', true, false, undefined, f.control)
			).resolves.toMatchObject({ success: false, unknown: true });
			expect(vi.getTimerCount()).toBe(0);
			expect(ipcMain.removeListener).toHaveBeenCalledOnce();
		});
	});
});
describe('browserTabCallbacks', () => {
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
			});
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
});
