import { useCallback, useEffect, useState } from 'react';
import type { MaestroCliStatus } from '../../../../../../shared/maestro-cli';
import { captureException } from '../../../../../utils/sentry';
import type { MaestroCliState } from '../types';

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
		setStatusError(null);
		try {
			const result = await window.maestro.maestroCli.installOrUpdate();
			setStatus(result.status);
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
		void checkStatus();
	}, [checkStatus, isOpen]);

	return {
		status,
		statusError,
		checking,
		installing,
		installMessage,
		checkStatus,
		installOrUpdate,
	};
}
