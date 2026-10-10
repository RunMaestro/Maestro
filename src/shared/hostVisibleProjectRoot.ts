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
	id?: string;
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
	fallback = ''
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

/** Translate a host-mounted file back to the SSH filesystem namespace. */
export function remoteVisiblePath(hostPath: string, remote: HostMountedRemote): string {
	const mount = remote.hostMountRoot;
	if (!mount) return hostPath;
	const windows = mount.includes('\\') || /^[a-z]:/i.test(mount);
	const root = mount.replace(/\\/g, '/').replace(/\/+$/, '');
	const normalized = hostPath.replace(/\\/g, '/');
	const comparableRoot = windows ? root.toLowerCase() : root;
	const comparablePath = windows ? normalized.toLowerCase() : normalized;
	if (comparablePath !== comparableRoot && !comparablePath.startsWith(comparableRoot + '/')) {
		return hostPath;
	}
	const relative = normalized.slice(root.length).replace(/^\/+/, '');
	const parts: string[] = [];
	for (const part of relative.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') {
			if (parts.length === 0) return hostPath;
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return '/' + parts.join('/');
}

/** Resolve a Cue filesystem request; equal remote roots require session identity. */
export function resolveHostProjectRoot(
	projectRoot: string,
	sessions: readonly RemoteBoundSession[],
	remotes: readonly HostMountedRemote[],
	sessionId?: string
): string {
	if (sessionId) {
		const session = sessions.find((entry) => entry.id === sessionId);
		if (!session) throw new Error('Cue session not found: ' + sessionId);
		const root = hostVisibleProjectRoot(session, remotes, projectRoot);
		if (!root) throw new Error('Cue project root escapes the remote mount');
		return root;
	}
	const hostMatches = sessions.filter(
		(session) => hostVisibleProjectRoot(session, remotes) === projectRoot
	);
	const matches =
		hostMatches.length > 0
			? hostMatches
			: sessions.filter(
					(session) =>
						session.projectRoot === projectRoot ||
						session.cwd === projectRoot ||
						session.fullPath === projectRoot ||
						session.sessionSshRemoteConfig?.workingDirOverride === projectRoot
				);
	const roots = new Set(matches.map((session) => hostVisibleProjectRoot(session, remotes)));
	if (roots.has(null)) throw new Error('Cue project root escapes the remote mount');
	if (roots.size > 1) throw new Error('Ambiguous Cue project root; specify a session id');
	return roots.size === 1 ? roots.values().next().value! : projectRoot;
}
