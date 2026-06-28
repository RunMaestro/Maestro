import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	safeClipboardWrite,
	safeClipboardWriteImage,
	safeClipboardReadImage,
} from '../../../renderer/utils/clipboard';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';

// The web-desktop branch is selected purely by isWebDesktop(); mock it so we can
// exercise both the Electron (host bridge) and browser (navigator) paths.
vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

const clipboardMock = {
	writeText: vi.fn<(text: string) => Promise<void>>(),
	write: vi.fn<(items: ClipboardItem[]) => Promise<void>>(),
	read: vi.fn<() => Promise<ClipboardItem[]>>(),
};

// Host clipboard bridge (window.maestro.shell.*). The shared setup mock does not
// define these three methods, so we install/reset them here.
const shellMock = {
	copyTextToClipboard: vi.fn<(text: string) => Promise<void>>(),
	copyImageToClipboard: vi.fn<(dataUrl: string) => Promise<void>>(),
	readImageFromClipboard: vi.fn<() => Promise<string | null>>(),
};

const originalFetch = globalThis.fetch;
const originalClipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

// jsdom does not implement ClipboardItem; a real (constructable) class is
// required because the source uses `new ClipboardItem(...)` - an arrow-function
// mock cannot be called with `new`.
class MockClipboardItem {
	constructor(public items: Record<string, Blob>) {}
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isWebDesktop).mockReturnValue(false);

	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		writable: true,
		value: clipboardMock,
	});
	clipboardMock.writeText.mockResolvedValue(undefined);
	clipboardMock.write.mockResolvedValue(undefined);
	clipboardMock.read.mockResolvedValue([]);

	// Attach the clipboard bridge to the shared window.maestro.shell mock.
	Object.assign((window as unknown as { maestro: { shell: object } }).maestro.shell, shellMock);
	shellMock.copyTextToClipboard.mockResolvedValue(undefined);
	shellMock.copyImageToClipboard.mockResolvedValue(undefined);
	shellMock.readImageFromClipboard.mockResolvedValue(null);

	// Image helpers rely on fetch + ClipboardItem, neither of which jsdom provides.
	globalThis.fetch = vi.fn(async () => ({
		blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
	})) as unknown as typeof fetch;
	(globalThis as { ClipboardItem: unknown }).ClipboardItem = MockClipboardItem;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	(globalThis as { ClipboardItem?: unknown }).ClipboardItem = originalClipboardItem;
	// Remove the bridge methods so they do not leak to other suites in this file.
	const shell = (window as unknown as { maestro: { shell: Record<string, unknown> } }).maestro
		.shell;
	delete shell.copyTextToClipboard;
	delete shell.copyImageToClipboard;
	delete shell.readImageFromClipboard;
});

describe('safeClipboardWrite', () => {
	describe('desktop (isWebDesktop false)', () => {
		it('prefers the host bridge and does not touch the navigator API', async () => {
			expect(await safeClipboardWrite('hello')).toBe(true);
			expect(shellMock.copyTextToClipboard).toHaveBeenCalledWith('hello');
			expect(clipboardMock.writeText).not.toHaveBeenCalled();
		});

		it('falls back to navigator.clipboard when the bridge is absent', async () => {
			const shell = (window as unknown as { maestro: { shell: Record<string, unknown> } }).maestro
				.shell;
			delete shell.copyTextToClipboard;
			expect(await safeClipboardWrite('hello')).toBe(true);
			expect(clipboardMock.writeText).toHaveBeenCalledWith('hello');
		});

		it('returns false when both paths fail', async () => {
			shellMock.copyTextToClipboard.mockRejectedValue(new Error('bridge down'));
			expect(await safeClipboardWrite('hello')).toBe(false);
		});
	});

	describe('web-desktop (isWebDesktop true)', () => {
		beforeEach(() => vi.mocked(isWebDesktop).mockReturnValue(true));

		it('uses the browser clipboard first even when the bridge exists', async () => {
			expect(await safeClipboardWrite('hello')).toBe(true);
			expect(clipboardMock.writeText).toHaveBeenCalledWith('hello');
			expect(shellMock.copyTextToClipboard).not.toHaveBeenCalled();
		});

		it('falls back to the legacy copy (not the host bridge) when the navigator API throws', async () => {
			// The host bridge would write to the HOST machine, not the browser the
			// user is on, so in web-desktop we keep the copy local via execCommand.
			clipboardMock.writeText.mockRejectedValue(new Error('not focused'));
			const execCommand = vi.fn().mockReturnValue(true);
			Object.assign(document, { execCommand });

			expect(await safeClipboardWrite('hello')).toBe(true);
			expect(execCommand).toHaveBeenCalledWith('copy');
			expect(shellMock.copyTextToClipboard).not.toHaveBeenCalled();
		});

		it('falls back to execCommand copy in an insecure context (no navigator.clipboard)', async () => {
			// Plain-HTTP context (e.g. Tailscale/LAN IP): the secure-context async
			// Clipboard API is undefined, so the legacy execCommand path must run.
			// No host bridge should be reached - the copy stays on the user's machine.
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				writable: true,
				value: undefined,
			});
			const execCommand = vi.fn().mockReturnValue(true);
			Object.assign(document, { execCommand });

			expect(await safeClipboardWrite('hello')).toBe(true);
			expect(execCommand).toHaveBeenCalledWith('copy');
			expect(shellMock.copyTextToClipboard).not.toHaveBeenCalled();
		});

		it('returns false when even the legacy copy fails', async () => {
			clipboardMock.writeText.mockRejectedValue(new Error('NotAllowedError'));
			const execCommand = vi.fn().mockReturnValue(false);
			Object.assign(document, { execCommand });

			expect(await safeClipboardWrite('hello')).toBe(false);
		});
	});
});

describe('safeClipboardWriteImage', () => {
	const dataUrl = 'data:image/png;base64,AAAA';

	describe('desktop (isWebDesktop false)', () => {
		it('prefers the host bridge and skips the navigator API', async () => {
			expect(await safeClipboardWriteImage(dataUrl)).toBe(true);
			expect(shellMock.copyImageToClipboard).toHaveBeenCalledWith(dataUrl);
			expect(clipboardMock.write).not.toHaveBeenCalled();
		});
	});

	describe('web-desktop (isWebDesktop true)', () => {
		beforeEach(() => vi.mocked(isWebDesktop).mockReturnValue(true));

		it('writes to the browser clipboard first even when the bridge exists', async () => {
			expect(await safeClipboardWriteImage(dataUrl)).toBe(true);
			expect(clipboardMock.write).toHaveBeenCalledTimes(1);
			expect(shellMock.copyImageToClipboard).not.toHaveBeenCalled();
		});

		it('falls back to the host bridge when the navigator write throws', async () => {
			clipboardMock.write.mockRejectedValue(new Error('denied'));
			expect(await safeClipboardWriteImage(dataUrl)).toBe(true);
			expect(shellMock.copyImageToClipboard).toHaveBeenCalledWith(dataUrl);
		});
	});
});

describe('safeClipboardReadImage', () => {
	function pngClipboardItem(): ClipboardItem {
		return {
			types: ['image/png'],
			getType: async () => new Blob(['png-bytes'], { type: 'image/png' }),
		} as unknown as ClipboardItem;
	}

	describe('desktop (isWebDesktop false)', () => {
		it('prefers the host bridge and skips the navigator API', async () => {
			shellMock.readImageFromClipboard.mockResolvedValue('data:image/png;base64,HOST');
			expect(await safeClipboardReadImage()).toBe('data:image/png;base64,HOST');
			expect(clipboardMock.read).not.toHaveBeenCalled();
		});
	});

	describe('web-desktop (isWebDesktop true)', () => {
		beforeEach(() => vi.mocked(isWebDesktop).mockReturnValue(true));

		it('reads an image from the browser clipboard', async () => {
			clipboardMock.read.mockResolvedValue([pngClipboardItem()]);
			const result = await safeClipboardReadImage();
			expect(result).toMatch(/^data:image\/png/);
			expect(shellMock.readImageFromClipboard).not.toHaveBeenCalled();
		});

		it('returns null without hitting the host bridge when the clipboard has no image', async () => {
			clipboardMock.read.mockResolvedValue([
				{ types: ['text/plain'], getType: async () => new Blob(['x']) } as unknown as ClipboardItem,
			]);
			expect(await safeClipboardReadImage()).toBeNull();
			expect(shellMock.readImageFromClipboard).not.toHaveBeenCalled();
		});

		it('falls back to the host bridge when the navigator read throws', async () => {
			clipboardMock.read.mockRejectedValue(new Error('denied'));
			shellMock.readImageFromClipboard.mockResolvedValue('data:image/png;base64,HOST');
			expect(await safeClipboardReadImage()).toBe('data:image/png;base64,HOST');
			expect(shellMock.readImageFromClipboard).toHaveBeenCalled();
		});
	});
});
