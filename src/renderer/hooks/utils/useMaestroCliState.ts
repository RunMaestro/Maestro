/**
 * useMaestroCliState - whether `maestro-cli` is installed on this machine, and the action that installs it.
 *
 * Settings > General, the Updates dialog and the Playbook Launch dialog all read the same install
 * state and run the same install action, so the state lives here and not in any one of them.
 */

import { useCallback, useEffect, useState } from 'react';
import type { MaestroCliStatus } from '../../../shared/maestro-cli';
import { captureException } from '../../utils/sentry';

export interface MaestroCliState {
	status: MaestroCliStatus | null;
	statusError: string | null;
	checking: boolean;
	installing: boolean;
	installMessage: { text: string; ok: boolean } | null;
	/**
	 * The last install changed the user's PATH. Only terminals opened afterwards see the change;
	 * agents Maestro starts already get the updated PATH. Reset by the next install or check.
	 */
	restartRequired: boolean;
	checkStatus: () => Promise<void>;
	installOrUpdate: () => Promise<void>;
}

/**
 * The path the filesystem refused to let the installer write, when that is
 * why the install failed. The error crosses IPC as text (`Error invoking
 * remote method ...: Error: EACCES: permission denied, mkdir '<path>'`), so the
 * errno code survives only inside the message.
 */
export function permissionDeniedPath(err: unknown): string | null {
	const message = err instanceof Error ? err.message : String(err);
	const match = message.match(/\b(?:EACCES|EPERM|EROFS): [^,]*, \w+ '([^']+)'/);
	return match ? match[1] : null;
}

interface UseMaestroCliStateArgs {
	isOpen: boolean;
}

export function useMaestroCliState({ isOpen }: UseMaestroCliStateArgs): MaestroCliState {
	const [status, setStatus] = useState<MaestroCliStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [installMessage, setInstallMessage] = useState<{ text: string; ok: boolean } | null>(null);
	const [restartRequired, setRestartRequired] = useState(false);

	const checkStatus = useCallback(async () => {
		setChecking(true);
		setStatusError(null);
		// Clear the previous result up front: leaving the last-known status in
		// place while a re-check is in flight means a check that then FAILS
		// still shows the prior "Installed" badge instead of reading as unknown.
		setStatus(null);
		try {
			const nextStatus = await window.maestro.maestroCli.checkStatus();
			setStatus(nextStatus);
		} catch (err) {
			setStatusError('Failed to check Maestro CLI status');
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { context: 'GeneralTab: Maestro CLI status check' },
			});
		} finally {
			setChecking(false);
		}
	}, []);

	const installOrUpdate = useCallback(async () => {
		setInstalling(true);
		setInstallMessage(null);
		setRestartRequired(false);
		setStatusError(null);
		try {
			const result = await window.maestro.maestroCli.installOrUpdate();
			setStatus(result.status);
			setRestartRequired(result.restartRequired);
			if (result.pathUpdateError) {
				setStatusError(result.pathUpdateError);
			}
			if (result.restartRequired) {
				setInstallMessage({
					text: 'CLI installed. Open a new terminal for PATH changes to apply.',
					ok: true,
				});
			} else if (result.success && result.status.versionMatch) {
				setInstallMessage({
					text: 'CLI is installed and matches this Maestro version.',
					ok: true,
				});
			} else {
				setInstallMessage({
					text: 'CLI was installed but version/path check still needs attention.',
					ok: false,
				});
			}
		} catch (err) {
			// A folder or shell rc file the app is not allowed to write is the
			// user's environment, not a Maestro bug: tell them which path, and
			// keep it out of Sentry (MAESTRO-15R, MAESTRO-15Z, MAESTRO-177).
			const deniedPath = permissionDeniedPath(err);
			if (deniedPath) {
				setStatusError(
					`Failed to install/update Maestro CLI: no permission to write ${deniedPath}. Fix its permissions and try again.`
				);
				return;
			}
			setStatusError('Failed to install/update Maestro CLI');
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { context: 'GeneralTab: Maestro CLI install/update' },
			});
		} finally {
			setInstalling(false);
		}
	}, []);

	useEffect(() => {
		if (!isOpen) return;
		setInstallMessage(null);
		setRestartRequired(false);
		void checkStatus();
	}, [checkStatus, isOpen]);

	return {
		status,
		statusError,
		checking,
		installing,
		installMessage,
		restartRequired,
		checkStatus,
		installOrUpdate,
	};
}
