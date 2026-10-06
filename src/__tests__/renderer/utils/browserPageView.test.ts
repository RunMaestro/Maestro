import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createHostBrowserPageView,
	type HostBrowserPageElement,
} from '../../../renderer/utils/browserPageView';
import type { BrowserPageState } from '../../../shared/browserPage';
import type { BrowserRelayFrame, BrowserRelayInput } from '../../../shared/browserRelay';

const target = { sessionId: 'session-1', tabId: 'browser-1' };
const state: BrowserPageState = {
	url: 'https://example.test',
	title: 'Example',
	width: 1024,
	height: 768,
	canGoBack: false,
	canGoForward: false,
	isLoading: false,
	webContentsId: 1,
	ready: true,
};
const frame: BrowserRelayFrame = { ...state, dataUrl: 'data:image/png;base64,dGVzdA==' };

describe('host browser page presentation', () => {
	let view: HostBrowserPageElement;
	let originalApi: typeof window.maestro.browserSession;
	const pageFrame = vi.fn<() => Promise<BrowserRelayFrame>>();
	const pageInput = vi.fn<(target: unknown, input: BrowserRelayInput) => Promise<void>>();
	const pageOpen = vi.fn<() => Promise<BrowserPageState>>();
	const decode = vi.fn<() => Promise<void>>();

	beforeEach(() => {
		vi.useFakeTimers();
		pageFrame.mockReset().mockResolvedValue(frame);
		pageInput.mockReset().mockResolvedValue(undefined);
		pageOpen.mockReset().mockResolvedValue(state);
		decode.mockReset().mockResolvedValue(undefined);
		vi.stubGlobal(
			'Image',
			class {
				src = '';
				decode = decode;
			}
		);
		originalApi = window.maestro.browserSession;
		window.maestro.browserSession = {
			...originalApi,
			pageOpen,
			pageFrame,
			pageInput,
			pageSuspend: vi.fn().mockResolvedValue(undefined),
			pageRelease: vi.fn().mockResolvedValue(undefined),
		};
		view = createHostBrowserPageView(target, state.url, '#fff');
	});

	afterEach(() => {
		view.dispose();
		window.maestro.browserSession = originalApi;
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it.each(['frame', 'decode'])(
		'retries a transient %s failure and restores the presentation',
		async (kind) => {
			const failed = vi.fn();
			const recovered = vi.fn();
			view.addEventListener('did-fail-load', failed);
			view.addEventListener('did-finish-load', recovered);
			if (kind === 'frame') pageFrame.mockRejectedValueOnce(new Error('Frame unavailable'));
			else decode.mockRejectedValueOnce(new Error('Decode unavailable'));
			view.setActive(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(failed).toHaveBeenCalledTimes(1);
			expect(pageFrame).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(999);
			expect(pageFrame).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(pageFrame).toHaveBeenCalledTimes(2);
			expect(view.querySelector('img')?.src).toBe(frame.dataUrl);
			expect(recovered).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(125);
			expect(pageFrame).toHaveBeenCalledTimes(3);
		}
	);

	it('backs off repeated failures and cancels pending retries while inactive', async () => {
		pageFrame.mockRejectedValue(new Error('Frame unavailable'));
		view.setActive(true);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1000);
		expect(pageFrame).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1999);
		expect(pageFrame).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(pageFrame).toHaveBeenCalledTimes(3);
		view.setActive(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(pageFrame).toHaveBeenCalledTimes(3);
	});

	it.each(['inactive', 'disposed'])(
		'ignores a rejected in-flight frame after becoming %s',
		async (mode) => {
			let rejectFrame!: (error: Error) => void;
			pageFrame.mockReturnValueOnce(
				new Promise((_, reject) => {
					rejectFrame = reject;
				})
			);
			const failed = vi.fn();
			view.addEventListener('did-fail-load', failed);
			view.setActive(true);
			await vi.advanceTimersByTimeAsync(0);
			if (mode === 'disposed') view.dispose();
			else view.setActive(false);
			rejectFrame(new Error('Stale failure'));
			await vi.advanceTimersByTimeAsync(10_000);
			expect(failed).not.toHaveBeenCalled();
			expect(pageFrame).toHaveBeenCalledTimes(1);
		}
	);

	it('starts only one pump when activation changes while the page is opening', async () => {
		view.dispose();
		let finishOpening!: (value: BrowserPageState) => void;
		pageOpen.mockReturnValueOnce(
			new Promise((resolve) => {
				finishOpening = resolve;
			})
		);
		view = createHostBrowserPageView(target, state.url, '#fff');
		view.setActive(true);
		view.setActive(false);
		view.setActive(true);
		finishOpening(state);
		await vi.advanceTimersByTimeAsync(0);
		expect(pageFrame).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(125);
		expect(pageFrame).toHaveBeenCalledTimes(2);
	});

	it('does not publish an old frame failure after a new activation starts', async () => {
		let rejectFrame!: (error: Error) => void;
		pageFrame.mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectFrame = reject;
			})
		);
		const failed = vi.fn();
		view.addEventListener('did-fail-load', failed);
		view.setActive(true);
		await vi.advanceTimersByTimeAsync(0);
		view.setActive(false);
		view.setActive(true);
		rejectFrame(new Error('Stale failure'));
		await vi.advanceTimersByTimeAsync(0);
		expect(failed).not.toHaveBeenCalled();
		expect(pageFrame).toHaveBeenCalledTimes(2);
		expect(view.querySelector('img')?.src).toBe(frame.dataUrl);
		await vi.advanceTimersByTimeAsync(125);
		expect(pageFrame).toHaveBeenCalledTimes(3);
	});

	it('keeps a long paste intact and ahead of subsequent typing while awaiting each chunk', async () => {
		let finishFirst!: () => void;
		pageInput.mockReturnValueOnce(
			new Promise((resolve) => {
				finishFirst = resolve;
			})
		);
		const text = 'a'.repeat(16_383) + '\u{1f600}' + 'b'.repeat(16_384);
		const keyboard = view.querySelector('textarea')!;
		const paste = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(paste, 'clipboardData', { value: { getData: () => text } });
		keyboard.dispatchEvent(paste);
		keyboard.value = 'next';
		keyboard.dispatchEvent(new InputEvent('input'));
		await vi.advanceTimersByTimeAsync(0);
		expect(pageInput).toHaveBeenCalledTimes(1);
		const first = pageInput.mock.calls[0][1];
		expect(first.type === 'text' && first.text.length).toBe(16_383);
		finishFirst();
		await vi.advanceTimersByTimeAsync(0);
		const inputs = pageInput.mock.calls.map(([, input]) => input);
		expect(inputs).toEqual([
			{ type: 'text', text: 'a'.repeat(16_383) },
			{ type: 'text', text: '\u{1f600}' + 'b'.repeat(16_382) },
			{ type: 'text', text: 'bb' },
			{ type: 'text', text: 'next' },
		]);
	});

	it('stops sending remaining text chunks when the presentation is disposed', async () => {
		let finishFirst!: () => void;
		pageInput.mockReturnValueOnce(
			new Promise((resolve) => {
				finishFirst = resolve;
			})
		);
		const keyboard = view.querySelector('textarea')!;
		keyboard.value = 'a'.repeat(32_768);
		keyboard.dispatchEvent(new InputEvent('input'));
		await vi.advanceTimersByTimeAsync(0);
		expect(pageInput).toHaveBeenCalledTimes(1);
		view.dispose();
		finishFirst();
		await vi.advanceTimersByTimeAsync(0);
		expect(pageInput).toHaveBeenCalledTimes(1);
	});
});
