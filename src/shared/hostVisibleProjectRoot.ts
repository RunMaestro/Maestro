/**
 * Where an agent's project root can be read from the desktop host.
 *
 * Cue reads `<projectRoot>/.maestro/cue.yaml` with the host filesystem. Without
 * a host mount, it preserves the session's existing root unchanged. When the
 * remote is also mounted on the host (a WSL distro as
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
 * The session's existing project root, translated only for an explicitly
 * host-mounted remote. Returns null if that translation would escape the mount.
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
	const mount = remote?.hostMountRoot;
	if (!mount) return local;
	const remoteRoot = ssh.workingDirOverride || local;
	if (!remoteRoot.startsWith('/')) return null;
	// Treat both separators as path boundaries before joining onto the host.
	// A raw concatenation would let /../x traverse outside the declared mount.
	const parts: string[] = [];
	for (const part of remoteRoot.split(/[\\/]+/)) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (parts.length === 0) return null;
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	const separator = mount.includes('\\') ? '\\' : '/';
	return mount.replace(/[\\/]+$/, '') + separator + parts.join(separator);
}
