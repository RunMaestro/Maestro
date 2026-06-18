import { useEffect, useState } from 'react';
import type { SshRemoteConfig } from '../../../../../../shared/types';
import type { WizardSessionSshRemoteConfig } from '../../../WizardContext';
import { logger } from '../../../../../utils/logger';
import { captureException, captureMessage } from '../../../../../utils/sentry';

export function useDirectorySshRemoteHost(
	sessionSshRemoteConfig: WizardSessionSshRemoteConfig | undefined
): string | null {
	const [sshRemoteHost, setSshRemoteHost] = useState<string | null>(null);

	useEffect(() => {
		if (!sessionSshRemoteConfig?.enabled || !sessionSshRemoteConfig.remoteId) {
			setSshRemoteHost(null);
			return;
		}

		const remoteId = sessionSshRemoteConfig.remoteId;
		let mounted = true;

		async function loadSshRemoteHost() {
			try {
				const configsResult = await window.maestro.sshRemote.getConfigs();
				if (configsResult.success && configsResult.configs) {
					const remote = configsResult.configs.find((r: SshRemoteConfig) => r.id === remoteId);
					if (remote) {
						if (mounted) {
							setSshRemoteHost(remote.name || remote.host);
						}
						return;
					}
				}

				if (mounted) {
					setSshRemoteHost('');
				}
				captureMessage('Wizard SSH remote host lookup missed', {
					level: 'warning',
					extra: {
						context: 'useDirectorySshRemoteHost.loadSshRemoteHost',
						remoteId,
						success: configsResult.success,
						error: configsResult.error,
					},
				});
			} catch (error) {
				if (mounted) {
					setSshRemoteHost('');
				}
				logger.error('Failed to load SSH remote config:', undefined, error);
				captureException(error, {
					extra: {
						context: 'useDirectorySshRemoteHost.loadSshRemoteHost',
						remoteId,
					},
				});
			}
		}

		loadSshRemoteHost();
		return () => {
			mounted = false;
		};
	}, [sessionSshRemoteConfig?.enabled, sessionSshRemoteConfig?.remoteId]);

	return sshRemoteHost;
}
