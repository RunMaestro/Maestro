import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	safeClipboardWrite,
	safeClipboardWriteBlob,
	safeClipboardWriteImage,
} from '../../../renderer/utils/clipboard';

type MaestroClipboardWindow = typeof window & {
	maestro?: {
		shell?: {
			copyImageToClipboard?: (dataUrl: string) => Promise<void>;
		};
	};
};

class MockClipboardItem {
	constructor(readonly items: Record<string, Blob>) {}
}

describe('clipboard utilities', () => {
	let originalClipboard: PropertyDescriptor | undefined;
	let originalClipboardItem: PropertyDescriptor | undefined;
	let originalFetch: PropertyDescriptor | undefined;
	let originalMaestro: MaestroClipboardWindow['maestro'];
	let writeText: ReturnType<typeof vi.fn>;
	let write: ReturnType<typeof vi.fn>;
	let fetchMock: ReturnType<typeof vi.fn>;

	const restoreProperty = (
		target: object,
		key: PropertyKey,
		descriptor: PropertyDescriptor | undefined
	): void => {
		if (descriptor) {
			Object.defineProperty(target, key, descriptor);
		} else {
			Reflect.deleteProperty(target, key);
		}
	};

	beforeEach(() => {
		originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
		originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
		originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
		originalMaestro = (window as MaestroClipboardWindow).maestro;
		writeText = vi.fn().mockResolvedValue(undefined);
		write = vi.fn().mockResolvedValue(undefined);
		fetchMock = vi.fn();

		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText, write },
		});
		Object.defineProperty(globalThis, 'ClipboardItem', {
			configurable: true,
			value: MockClipboardItem,
		});
		Object.defineProperty(globalThis, 'fetch', {
			configurable: true,
			value: fetchMock,
		});
		(window as MaestroClipboardWindow).maestro = undefined;
	});

	afterEach(() => {
		restoreProperty(navigator, 'clipboard', originalClipboard);
		restoreProperty(globalThis, 'ClipboardItem', originalClipboardItem);
		restoreProperty(globalThis, 'fetch', originalFetch);
		(window as MaestroClipboardWindow).maestro = originalMaestro;
		vi.restoreAllMocks();
	});

	describe('safeClipboardWrite', () => {
		it('returns true after writing text to the clipboard', async () => {
			await expect(safeClipboardWrite('hello')).resolves.toBe(true);

			expect(writeText).toHaveBeenCalledWith('hello');
		});

		it('returns false when writing text fails', async () => {
			writeText.mockRejectedValue(new Error('not focused'));

			await expect(safeClipboardWrite('hello')).resolves.toBe(false);
		});
	});

	describe('safeClipboardWriteBlob', () => {
		it('returns true after writing clipboard items', async () => {
			const item = new MockClipboardItem({ 'image/png': new Blob(['image']) }) as ClipboardItem;

			await expect(safeClipboardWriteBlob([item])).resolves.toBe(true);

			expect(write).toHaveBeenCalledWith([item]);
		});

		it('returns false when writing clipboard items fails', async () => {
			write.mockRejectedValue(new Error('not focused'));
			const item = new MockClipboardItem({ 'image/png': new Blob(['image']) }) as ClipboardItem;

			await expect(safeClipboardWriteBlob([item])).resolves.toBe(false);
		});
	});

	describe('safeClipboardWriteImage', () => {
		it('uses the Maestro shell bridge when available', async () => {
			const copyImageToClipboard = vi.fn().mockResolvedValue(undefined);
			(window as MaestroClipboardWindow).maestro = {
				shell: { copyImageToClipboard },
			};

			await expect(safeClipboardWriteImage('data:image/png;base64,abc')).resolves.toBe(true);

			expect(copyImageToClipboard).toHaveBeenCalledWith('data:image/png;base64,abc');
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('falls back to the browser Clipboard API when the shell bridge is unavailable', async () => {
			const blob = new Blob(['image'], { type: 'image/png' });
			fetchMock.mockResolvedValue({ blob: vi.fn().mockResolvedValue(blob) });

			await expect(safeClipboardWriteImage('data:image/png;base64,abc')).resolves.toBe(true);

			expect(fetchMock).toHaveBeenCalledWith('data:image/png;base64,abc');
			const clipboardItem = write.mock.calls[0][0][0] as MockClipboardItem;
			expect(clipboardItem.items['image/png']).toBe(blob);
		});

		it('returns false when image clipboard writing fails', async () => {
			const copyImageToClipboard = vi.fn().mockRejectedValue(new Error('native failure'));
			(window as MaestroClipboardWindow).maestro = {
				shell: { copyImageToClipboard },
			};

			await expect(safeClipboardWriteImage('data:image/png;base64,abc')).resolves.toBe(false);
		});
	});
});
