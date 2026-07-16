import { beforeEach, describe, expect, it, vi } from 'vitest';

type ResponseListener = (event: { sender: { id: number } }, ...args: unknown[]) => void;
type DestroyListener = () => void;

const { listeners, mockOn, mockRemoveListener } = vi.hoisted(() => {
	const listeners = new Map<string, ResponseListener>();
	const mockOn = vi.fn((channel: string, listener: ResponseListener) => {
		listeners.set(channel, listener);
	});
	const mockRemoveListener = vi.fn((channel: string, listener: ResponseListener) => {
		if (listeners.get(channel) === listener) {
			listeners.delete(channel);
		}
	});
	return { listeners, mockOn, mockRemoveListener };
});

vi.mock('electron', () => ({
	ipcMain: {
		on: mockOn,
		removeListener: mockRemoveListener,
	},
}));

import {
	createCoworkingRendererRoundTrip,
	parseBrowserOpResponse,
	parseTerminalBufferResponse,
} from '../../../main/coworking/coworking-response-channel';

interface FakeWebContents {
	id: number;
	send: (...args: unknown[]) => void;
	isDestroyed: () => boolean;
	once: (event: string, listener: DestroyListener) => void;
	removeListener: (event: string, listener: DestroyListener) => void;
	destroy: () => void;
}

function createWebContents(id: number): FakeWebContents {
	let destroyedListener: DestroyListener | undefined;
	return {
		id,
		send: vi.fn(),
		isDestroyed: vi.fn(() => false),
		once: vi.fn((event: string, listener: DestroyListener) => {
			if (event === 'destroyed') destroyedListener = listener;
		}),
		removeListener: vi.fn(),
		destroy: () => destroyedListener?.(),
	};
}

function requestBuffer(webContents: FakeWebContents, timeoutMs = 1_000): Promise<string> {
	return createCoworkingRendererRoundTrip({
		webContents: webContents as unknown as Electron.WebContents,
		requestChannel: 'coworking:requestBuffer',
		requestArgs: ['tab', 'session'],
		responseKind: 'buffer',
		timeoutMs,
		timeoutError: () => new Error('timed out'),
		destroyedError: () => new Error('renderer destroyed'),
		parseResponse: parseTerminalBufferResponse,
	});
}

function responseChannelAt(index: number): string {
	return [...listeners.keys()][index] as string;
}

function emit(channel: string, senderId: number, ...args: unknown[]): void {
	listeners.get(channel)?.({ sender: { id: senderId } }, ...args);
}

describe('coworking renderer response channels', () => {
	beforeEach(() => {
		listeners.clear();
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('keeps concurrent requests isolated when responses arrive out of order', async () => {
		const webContents = createWebContents(17);
		const first = requestBuffer(webContents);
		const second = requestBuffer(webContents);
		const firstChannel = responseChannelAt(0);
		const secondChannel = responseChannelAt(1);

		expect(firstChannel).not.toBe(secondChannel);
		expect(firstChannel).toMatch(/^coworking:response:buffer:[0-9a-f-]{36}$/);
		emit(secondChannel, 17, 'second');
		emit(firstChannel, 17, 'first');

		await expect(first).resolves.toBe('first');
		await expect(second).resolves.toBe('second');
	});

	it('removes only its exact listener after a timeout and ignores its late response', async () => {
		vi.useFakeTimers();
		const webContents = createWebContents(18);
		const request = requestBuffer(webContents, 50);
		const channel = responseChannelAt(0);
		const listener = listeners.get(channel);

		const rejected = expect(request).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(50);
		await rejected;
		expect(mockRemoveListener).toHaveBeenCalledWith(channel, listener);
		expect(webContents.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
		emit(channel, 18, 'late');
		expect(mockRemoveListener).toHaveBeenCalledTimes(1);
	});

	it('rejects and cleans up when the renderer is destroyed', async () => {
		const webContents = createWebContents(19);
		const request = requestBuffer(webContents);
		const channel = responseChannelAt(0);
		const listener = listeners.get(channel);

		webContents.destroy();

		await expect(request).rejects.toThrow('renderer destroyed');
		expect(mockRemoveListener).toHaveBeenCalledWith(channel, listener);
		expect(webContents.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
	});

	it('settles once, ignores duplicate responses, and preserves its first result', async () => {
		const webContents = createWebContents(20);
		const request = requestBuffer(webContents);
		const channel = responseChannelAt(0);
		const listener = listeners.get(channel);

		emit(channel, 20, 'first');
		listener?.({ sender: { id: 20 } }, 'second');

		await expect(request).resolves.toBe('first');
		expect(mockRemoveListener).toHaveBeenCalledTimes(1);
	});

	it('ignores spoofed and malformed responses until the matching valid response arrives', async () => {
		const webContents = createWebContents(21);
		const request = requestBuffer(webContents);
		const channel = responseChannelAt(0);

		emit(channel, 999, 'spoofed');
		emit(channel, 21, 42);
		emit(channel, 21, 'valid');

		await expect(request).resolves.toBe('valid');
	});

	it('accepts only a BrowserOpResult-shaped browser response', () => {
		expect(parseBrowserOpResponse([{ ok: true, content: 'ok' }])).toEqual({
			kind: 'resolve',
			value: { ok: true, content: 'ok' },
		});
		expect(parseTerminalBufferResponse(['ok', undefined])).toEqual({
			kind: 'resolve',
			value: 'ok',
		});
		expect(parseBrowserOpResponse([{ ok: true, content: 42 }])).toBeNull();
		expect(parseBrowserOpResponse([{ ok: true }, 'extra'])).toBeNull();
	});
});
