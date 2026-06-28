/**
 * Tests for safeClipboardWrite clipboard routing.
 *
 * Regression: in web-desktop mode (renderer running in a browser via the
 * Electron shim), `window.maestro.shell.copyTextToClipboard` is always defined
 * and routes over IPC to the HOST machine's clipboard — not the browser the
 * user is actually on. The copy must instead use the browser Clipboard API so
 * the text lands on the user's own machine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the runtime-context detector so each test can flip web-desktop on/off.
const mockIsWebDesktop = vi.fn();
vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => mockIsWebDesktop(),
}));

import { safeClipboardWrite } from '../../../renderer/utils/clipboard';

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
