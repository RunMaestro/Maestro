/**
 * Handing a file or folder to an operating system: "Open in Default App",
 * "Reveal in Finder", "Open in Finder".
 *
 * On the desktop that is the host computer's OS, which is where the person is.
 * In a browser on the web interface it is not: `shell:openPath` and
 * `shell:showItemInFolder` would act on a computer in another room, and the
 * bridge refuses them for that reason. So every surface asks here instead of
 * calling `window.maestro.shell` itself:
 *
 *   - **Open a file** works everywhere. In a browser the file is downloaded to
 *     this device, which is how a browser hands a file to its own default app.
 *   - **Reveal or open a folder** has no browser equivalent, so the control is
 *     not drawn ({@link canRevealOnHost}, {@link hostShellAvailable}).
 *
 * Before this, each surface decided on its own: one hid the control, one
 * disabled it, and most showed it and failed with a "Submission rejected"
 * banner when pressed.
 */

import { getBasename } from '../../shared/formatters';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import { downloadHostFile } from '../utils/clientDownload';
import { isWebDesktop } from '../utils/runtimeContext';

/** Whether this client can hand a path to the host computer's OS at all. */
export function hostShellAvailable(): boolean {
	return !isWebDesktop();
}

/**
 * Whether a "Reveal in Finder" or "Open in Finder" control can act: only on
 * the desktop, and only for a local agent (an SSH agent's files are on the
 * remote host, not this computer).
 */
export function canRevealOnHost(sshRemote?: unknown): boolean {
	return hostShellAvailable() && !sshRemote;
}

/** The label of the control {@link openFileForUser} sits behind. */
export function openFileForUserLabel(): string {
	return isWebDesktop() ? 'Download to This Client' : 'Open in Default App';
}

/**
 * Open a host file the way this person's computer would: in its default app on
 * the desktop, or downloaded to this device from a browser. A failed download
 * says why; the desktop path is unchanged.
 */
export async function openFileForUser(
	path: string,
	options: { sshRemoteId?: string | null } = {}
): Promise<void> {
	if (hostShellAvailable()) {
		await window.maestro.shell.openPath(path);
		return;
	}
	const name = getBasename(path);
	try {
		await downloadHostFile(path, name, options.sshRemoteId ?? undefined);
		notifyCenterFlash({ message: `Downloaded "${name}" to this client`, color: 'theme' });
	} catch (error) {
		notifyToast({
			color: 'red',
			title: 'Download failed',
			message: error instanceof Error ? error.message : String(error),
		});
	}
}
