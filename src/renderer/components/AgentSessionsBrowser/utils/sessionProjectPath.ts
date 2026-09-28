import type { Session } from '../../../types';
import { getSessionSshRemoteId } from '../../../utils/sessionHelpers';

export interface SessionProjectPath {
	projectPathForSessions: string | undefined;
	sshRemoteId: string | undefined;
	isRemoteSession: boolean;
}

export function resolveSessionProjectPath(activeSession: Session | undefined): SessionProjectPath {
	// Never read `sshRemoteId` alone: it is runtime-only, cleared on restart and
	// set again only when the agent next spawns.
	const sshRemoteId = getSessionSshRemoteId(activeSession);
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
