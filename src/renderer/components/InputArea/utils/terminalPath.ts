import type { Session } from '../../../types';
import { isSessionRemote } from '../../../utils/sessionHelpers';

/**
 * The directory the terminal composer shows. A remote agent shows its remote path; the remote's
 * name is not drawn, because the mode pill is the one mark of where an agent runs
 * (docs/parity/agent-ux-parity.md).
 */
export function formatTerminalCwd(session: Session): string {
	const path = isSessionRemote(session)
		? session.remoteCwd || session.sessionSshRemoteConfig?.workingDirOverride || session.cwd
		: session.shellCwd || session.cwd;
	return path ? path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~') : '~';
}
