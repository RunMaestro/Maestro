/**
 * Where an agent's project root can be read from the desktop host.
 *
 * Cue reads `<projectRoot>/.maestro/cue.yaml` with the host filesystem, so an
 * agent that runs over SSH has, by default, no Cue at all: its POSIX root does
 * not exist here. When the remote is also mounted on the host (a WSL distro as
 * `\\wsl.localhost\<distro>`, an SMB share, an sshfs mount) the remote can say
 * so with `hostMountRoot`, and the agent's root is read through that mount.
 * Nothing is guessed: no `hostMountRoot`, no translation.
 */

export interface HostMountedRemote {
	id: string;
	/** Host path at which the remote's `/` is visible, e.g. `\\wsl.localhost\Ubuntu`. */
	hostMountRoot?: string;
}

export interface RemoteBoundSession {
	cwd?: string;
	projectRoot?: string;
	fullPath?: string;
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * The session's project root as a path the host can open, or `null` when the
 * session runs on a remote that is not mounted on the host.
 */
export function hostVisibleProjectRoot(
	session: RemoteBoundSession,
	remotes: readonly HostMountedRemote[],
	fallback: string
): string | null {
	const local = session.projectRoot || session.cwd || session.fullPath || fallback;
	const ssh = session.sessionSshRemoteConfig;
	if (!ssh?.enabled || !ssh.remoteId) return local;
	const remote = remotes.find((candidate) => candidate.id === ssh.remoteId);
	const mount = remote?.hostMountRoot?.replace(/[\\/]+$/, '');
	if (!mount) return null;
	const remoteRoot = ssh.workingDirOverride || local;
	if (!remoteRoot.startsWith('/')) return null;
	// `\\wsl.localhost\Ubuntu` + `/home/dev/app` -> `\\wsl.localhost\Ubuntu\home\dev\app`
	const separator = mount.includes('\\') ? '\\' : '/';
	return mount + remoteRoot.replace(/\//g, separator);
}
