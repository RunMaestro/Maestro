/**
 * Tests for safeClipboardWrite clipboard routing.
 *
 * Regression: in web-desktop mode (renderer running in a browser via the
 * Electron shim), `window.maestro.shell.copyTextToClipboard` is always defined
 * and routes over IPC to the HOST machine's clipboard, not the browser the
 * user is actually on. The copy must instead use the browser Clipboard API so
 * the text lands on the user's own machine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the runtime-context detector so each test can flip web-desktop on/off.
const mockIsWebDesktop = vi.fn();
vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => mockIsWebDesktop(),
}));

import {
	safeClipboardWrite,
	safeClipboardWriteImage,
	safeClipboardReadImage,
} from '../../../renderer/utils/clipboard';

describe('safeClipboardWrite', () => {
	const copyTextToClipboard = vi.fn().mockResolvedValue(undefined);
	const writeText = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		mockIsWebDesktop.mockReset();
		copyTextToClipboard.mockClear();
		writeText.mockClear();

		(window as unknown as { maestro?: unknown }).maestro = {
			shell: { copyTextToClipboard },
		};
		Object.assign(navigator, { clipboard: { writeText } });
	});

	it('uses the Electron IPC clipboard in the desktop app', async () => {
		mockIsWebDesktop.mockReturnValue(false);

		const ok = await safeClipboardWrite('hello');

		expect(ok).toBe(true);
		expect(copyTextToClipboard).toHaveBeenCalledWith('hello');
		expect(writeText).not.toHaveBeenCalled();
	});

	it('uses the browser Clipboard API in web-desktop, not the host IPC clipboard', async () => {
		mockIsWebDesktop.mockReturnValue(true);

		const ok = await safeClipboardWrite('hello');

		expect(ok).toBe(true);
		expect(writeText).toHaveBeenCalledWith('hello');
		expect(copyTextToClipboard).not.toHaveBeenCalled();
	});

	it('falls back to execCommand copy in an insecure context (no navigator.clipboard)', async () => {
		// Plain-HTTP context (e.g. Tailscale/LAN IP): the secure-context async
		// Clipboard API is undefined, so the legacy execCommand path must run.
		mockIsWebDesktop.mockReturnValue(true);
		Object.assign(navigator, { clipboard: undefined });
		const execCommand = vi.fn().mockReturnValue(true);
		Object.assign(document, { execCommand });

		const ok = await safeClipboardWrite('hello');

		expect(ok).toBe(true);
		expect(execCommand).toHaveBeenCalledWith('copy');
	});

	it('falls back to execCommand copy when the async write throws', async () => {
		mockIsWebDesktop.mockReturnValue(true);
		writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
		const execCommand = vi.fn().mockReturnValue(true);
		Object.assign(document, { execCommand });

		const ok = await safeClipboardWrite('hello');

		expect(ok).toBe(true);
		expect(execCommand).toHaveBeenCalledWith('copy');
	});

	it('returns false when even the legacy copy fails', async () => {
		mockIsWebDesktop.mockReturnValue(true);
		writeText.mockRejectedValueOnce(new Error('NotAllowedError'));
		const execCommand = vi.fn().mockReturnValue(false);
		Object.assign(document, { execCommand });

		const ok = await safeClipboardWrite('hello');

		expect(ok).toBe(false);
	});
});

describe('safeClipboardWriteImage', () => {
	const copyImageToClipboard = vi.fn().mockResolvedValue(undefined);
	const write = vi.fn().mockResolvedValue(undefined);

	beforeEach(() => {
		mockIsWebDesktop.mockReset();
		copyImageToClipboard.mockClear();
		write.mockClear();

		(window as unknown as { maestro?: unknown }).maestro = {
			shell: { copyImageToClipboard },
		};
		Object.assign(navigator, { clipboard: { write } });
		// Browser path: fetch the data URL into a blob, then clipboard.write it.
		(globalThis as unknown as { fetch: unknown }).fetch = vi
			.fn()
			.mockResolvedValue({ blob: () => Promise.resolve(new Blob([], { type: 'image/png' })) });
		(globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = class {
			constructor(public items: Record<string, Blob>) {}
		};
	});

	it('uses the Electron IPC clipboard in the desktop app', async () => {
		mockIsWebDesktop.mockReturnValue(false);

		const ok = await safeClipboardWriteImage('data:image/png;base64,AAAA');

		expect(ok).toBe(true);
		expect(copyImageToClipboard).toHaveBeenCalledWith('data:image/png;base64,AAAA');
		expect(write).not.toHaveBeenCalled();
	});

	it('uses the browser Clipboard API in web-desktop, not the host IPC clipboard', async () => {
		mockIsWebDesktop.mockReturnValue(true);

		const ok = await safeClipboardWriteImage('data:image/png;base64,AAAA');

		expect(ok).toBe(true);
		expect(write).toHaveBeenCalled();
		expect(copyImageToClipboard).not.toHaveBeenCalled();
	});
});

describe('safeClipboardReadImage', () => {
	const readImageFromClipboard = vi.fn().mockResolvedValue('data:image/png;base64,HOST');
	const read = vi.fn().mockResolvedValue([]);

	beforeEach(() => {
		mockIsWebDesktop.mockReset();
		readImageFromClipboard.mockClear();
		read.mockClear();

		(window as unknown as { maestro?: unknown }).maestro = {
			shell: { readImageFromClipboard },
		};
		Object.assign(navigator, { clipboard: { read } });
	});

	it('uses the Electron IPC clipboard in the desktop app', async () => {
		mockIsWebDesktop.mockReturnValue(false);

		const result = await safeClipboardReadImage();

		expect(result).toBe('data:image/png;base64,HOST');
		expect(readImageFromClipboard).toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
	});

	it('uses the browser Clipboard API in web-desktop, not the host IPC clipboard', async () => {
		mockIsWebDesktop.mockReturnValue(true);

		const result = await safeClipboardReadImage();

		// Empty browser clipboard yields null, but the host IPC must not be hit.
		expect(result).toBeNull();
		expect(read).toHaveBeenCalled();
		expect(readImageFromClipboard).not.toHaveBeenCalled();
	});
});
