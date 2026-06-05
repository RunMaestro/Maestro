import { useCallback, useEffect, useState } from 'react';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../../../../../shared/types';
import { logger } from '../../../../../utils/logger';
import { captureException } from '../../../../../utils/sentry';
import {
	getInitialSshRemoteConfig,
	getSyncedSshRemoteConfig,
	selectSshRemoteConfig,
	type WizardSessionSshRemoteConfig,
} from '../utils/sshConfig';

interface UseSshRemotesArgs {
	sessionSshRemoteConfig: WizardSessionSshRemoteConfig | undefined;
	setWizardSessionSshRemoteConfig: (config: WizardSessionSshRemoteConfig | undefined) => void;
}

export function useSshRemotes({
	sessionSshRemoteConfig,
	setWizardSessionSshRemoteConfig,
}: UseSshRemotesArgs) {
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const [sshRemoteConfig, setSshRemoteConfig] = useState<AgentSshRemoteConfig | undefined>(() =>
		getInitialSshRemoteConfig(sessionSshRemoteConfig)
	);

	useEffect(() => {
		const syncedConfig = getSyncedSshRemoteConfig(sessionSshRemoteConfig);
		if (syncedConfig !== null) {
			setSshRemoteConfig(syncedConfig);
		}
	}, [
		sessionSshRemoteConfig?.enabled,
		sessionSshRemoteConfig?.remoteId,
		sessionSshRemoteConfig?.workingDirOverride,
	]);

	useEffect(() => {
		let mounted = true;

		async function loadSshRemotes() {
			try {
				const configsResult = await window.maestro.sshRemote.getConfigs();
				if (mounted && configsResult.success && configsResult.configs) {
					setSshRemotes(configsResult.configs);
				}
			} catch (error) {
				logger.error('Failed to load SSH remotes:', undefined, error);
				captureException(error, {
					extra: {
						operation: 'agentSelection:loadSshRemotes',
						sessionRemoteEnabled: Boolean(sessionSshRemoteConfig?.enabled),
						sessionRemoteId: sessionSshRemoteConfig?.remoteId ?? null,
						hasWorkingDirOverride: Boolean(sessionSshRemoteConfig?.workingDirOverride),
					},
				});
			}
		}

		loadSshRemotes();

		return () => {
			mounted = false;
		};
	}, [
		sessionSshRemoteConfig?.enabled,
		sessionSshRemoteConfig?.remoteId,
		sessionSshRemoteConfig?.workingDirOverride,
	]);

	const handleSshRemoteChange = useCallback(
		(remoteId: string) => {
			const nextConfig = selectSshRemoteConfig(remoteId);
			setSshRemoteConfig(nextConfig);
			if (nextConfig) {
				setWizardSessionSshRemoteConfig({
					enabled: true,
					remoteId: nextConfig.remoteId,
					workingDirOverride: nextConfig.workingDirOverride,
				});
			} else {
				setWizardSessionSshRemoteConfig({ enabled: false, remoteId: null });
			}
		},
		[setWizardSessionSshRemoteConfig]
	);

	return {
		sshRemotes,
		sshRemoteConfig,
		setSshRemoteConfig,
		handleSshRemoteChange,
	};
}
