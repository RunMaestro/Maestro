import type { Session } from '../../../types';

export interface SessionProjectPath {
	projectPathForSessions: string | undefined;
	sshRemoteId: string | undefined;
	isRemoteSession: boolean;
}

export function resolveSessionProjectPath(activeSession: Session | undefined): SessionProjectPath {
	const sshRemoteId =
		activeSession?.sshRemoteId || activeSession?.sessionSshRemoteConfig?.remoteId || undefined;
	const isRemoteSession = !!sshRemoteId;

	// For SSH sessions, Claude Code stores sessions based on the REMOTE path, not the local
	// projectRoot. Use remoteCwd or workingDirOverride as the remote path.
	const projectPathForSessions = isRemoteSession
		? activeSession?.remoteCwd ||
			activeSession?.sessionSshRemoteConfig?.workingDirOverride ||
			activeSession?.projectRoot
		: activeSession?.projectRoot;

	return { projectPathForSessions, sshRemoteId, isRemoteSession };
}
