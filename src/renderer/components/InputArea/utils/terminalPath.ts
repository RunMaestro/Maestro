import type { Session } from '../../../types';

export function formatTerminalCwd(session: Session): string {
	const isRemote = !!(session.sshRemoteId || session.sessionSshRemoteConfig?.enabled);
	const path = isRemote
		? session.remoteCwd || session.sessionSshRemoteConfig?.workingDirOverride || session.cwd
		: session.shellCwd || session.cwd;
	const displayPath = path
		? path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
		: '~';

	if (isRemote && session.sshRemote?.name) {
		return `${session.sshRemote.name.toUpperCase()}:${displayPath}`;
	}

	return displayPath;
}
