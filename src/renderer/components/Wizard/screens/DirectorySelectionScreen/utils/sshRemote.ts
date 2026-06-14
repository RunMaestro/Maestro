import type { WizardSessionSshRemoteConfig } from '../../../WizardContext';

export function getWizardSshRemoteId(
	sessionSshRemoteConfig: WizardSessionSshRemoteConfig | undefined
): string | undefined {
	if (sessionSshRemoteConfig?.enabled && sessionSshRemoteConfig.remoteId) {
		return sessionSshRemoteConfig.remoteId;
	}
	return undefined;
}
