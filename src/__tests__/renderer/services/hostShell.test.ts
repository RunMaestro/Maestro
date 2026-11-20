/**
 * @file hostShell.test.ts
 *
 * Handing a path to an operating system from either client. Pinned here:
 *
 *   - **The desktop is unchanged**: the host's OS opens the file.
 *   - **A browser downloads the file to its own device** and never asks the
 *     host to open or reveal anything, since the host is not where that
 *     person is.
 *   - **A failed download says why.**
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ web: false }));
vi.mock('../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => runtime.web,
}));
const download = vi.hoisted(() => ({ downloadHostFile: vi.fn() }));
vi.mock('../../../renderer/utils/clientDownload', () => download);
vi.mock('../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../renderer/stores/centerFlashStore', () => ({ notifyCenterFlash: vi.fn() }));

import {
	canRevealOnHost,
	hostShellAvailable,
	openFileForUser,
	openFileForUserLabel,
} from '../../../renderer/services/hostShell';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';

const openPath = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	runtime.web = false;
	(window.maestro as unknown as { shell: unknown }).shell = {
		...window.maestro.shell,
		openPath,
	};
	download.downloadHostFile.mockResolvedValue(undefined);
});

describe('on the desktop', () => {
	it("opens a file with the host's OS and names the control for that", async () => {
		await openFileForUser('/repo/report.pdf');
		expect(openPath).toHaveBeenCalledWith('/repo/report.pdf');
		expect(download.downloadHostFile).not.toHaveBeenCalled();
		expect(openFileForUserLabel()).toBe('Open in Default App');
	});

	it('reveals only for a local agent', () => {
		expect(hostShellAvailable()).toBe(true);
		expect(canRevealOnHost()).toBe(true);
		expect(canRevealOnHost('remote-1')).toBe(false);
	});
});

describe('in a browser on the web interface', () => {
	beforeEach(() => {
		runtime.web = true;
	});

	it('downloads the file to this device instead of opening it on the host', async () => {
		await openFileForUser('/repo/out/report.pdf', { sshRemoteId: 'remote-1' });
		expect(download.downloadHostFile).toHaveBeenCalledWith(
			'/repo/out/report.pdf',
			'report.pdf',
			'remote-1'
		);
		expect(openPath).not.toHaveBeenCalled();
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Downloaded "report.pdf" to this client' })
		);
		expect(openFileForUserLabel()).toBe('Download to This Client');
	});

	it('never offers to reveal a path in the host file manager', () => {
		expect(hostShellAvailable()).toBe(false);
		expect(canRevealOnHost()).toBe(false);
	});

	it('says why a download failed', async () => {
		download.downloadHostFile.mockRejectedValue(new Error('Host download failed (404)'));
		await openFileForUser('/repo/gone.pdf');
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: 'Host download failed (404)' })
		);
	});
});
