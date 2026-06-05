import type { AgentSshRemoteConfig } from '../../../../../../shared/types';

export interface WizardSessionSshRemoteConfig {
	enabled: boolean;
	remoteId: string | null;
	workingDirOverride?: string;
}

export function getInitialSshRemoteConfig(
	sessionSshRemoteConfig: WizardSessionSshRemoteConfig | undefined
): AgentSshRemoteConfig | undefined {
	if (!sessionSshRemoteConfig?.enabled) return undefined;
	const remoteId = sessionSshRemoteConfig.remoteId || null;

	return {
		enabled: true,
		remoteId,
		workingDirOverride: sessionSshRemoteConfig.workingDirOverride,
	};
}

export function getSyncedSshRemoteConfig(
	sessionSshRemoteConfig: WizardSessionSshRemoteConfig | undefined
): AgentSshRemoteConfig | undefined | null {
	if (sessionSshRemoteConfig?.enabled && sessionSshRemoteConfig?.remoteId) {
		return {
			enabled: true,
			remoteId: sessionSshRemoteConfig.remoteId,
			workingDirOverride: sessionSshRemoteConfig.workingDirOverride,
		};
	}
	if (sessionSshRemoteConfig?.enabled === false) return undefined;
	return null;
}

export function selectSshRemoteConfig(remoteId: string): AgentSshRemoteConfig | undefined {
	if (remoteId === '') return undefined;
	return {
		enabled: true,
		remoteId,
	};
}

export function toWizardSshRemoteConfig(
	sshRemoteConfig: AgentSshRemoteConfig | undefined
): WizardSessionSshRemoteConfig {
	if (sshRemoteConfig?.enabled && sshRemoteConfig?.remoteId) {
		return {
			enabled: true,
			remoteId: sshRemoteConfig.remoteId,
			workingDirOverride: sshRemoteConfig.workingDirOverride,
		};
	}

	return { enabled: false, remoteId: null };
}

export function getSshRemoteIdForDetection(
	sshRemoteConfig: AgentSshRemoteConfig | undefined
): string | undefined {
	return sshRemoteConfig?.enabled ? (sshRemoteConfig.remoteId ?? undefined) : undefined;
}
