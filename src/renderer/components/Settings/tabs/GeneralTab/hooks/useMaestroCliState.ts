import { useCallback, useEffect, useState } from 'react';
import type { MaestroCliStatus } from '../../../../../../shared/maestro-cli';
import { captureException } from '../../../../../utils/sentry';
import type { MaestroCliState } from '../types';

interface UseMaestroCliStateArgs {
	isOpen: boolean;
}

export function useMaestroCliState({ isOpen }: UseMaestroCliStateArgs): MaestroCliState {
	const [status, setStatus] = useState<MaestroCliStatus | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [installMessage, setInstallMessage] = useState<string | null>(null);

	const checkStatus = useCallback(async () => {
		setChecking(true);
		setStatusError(null);
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
				setInstallMessage('CLI installed. Open a new terminal for PATH changes to apply.');
			} else if (result.success && result.status.versionMatch) {
				setInstallMessage('CLI is installed and matches this Maestro version.');
			} else {
				setInstallMessage('CLI was installed but version/path check still needs attention.');
			}
		} catch (err) {
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
