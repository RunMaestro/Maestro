/** Resolve both persisted SSH identities without guessing when they disagree. */
export function resolveBoardLocation(session: {
	sshRemoteId?: unknown;
	sessionSshRemoteConfig?: { enabled?: boolean; remoteId?: unknown } | null;
}): { kind: 'local' } | { kind: 'ssh'; remoteId: string } | { kind: 'invalid' } {
	const configured = session.sessionSshRemoteConfig?.enabled
		? session.sessionSshRemoteConfig.remoteId
		: undefined;
	const runtime = session.sshRemoteId;
	if (
		session.sessionSshRemoteConfig?.enabled &&
		(typeof configured !== 'string' || !configured.trim())
	)
		return { kind: 'invalid' };
	if (runtime != null && runtime !== '' && (typeof runtime !== 'string' || !runtime.trim()))
		return { kind: 'invalid' };
	if (configured && runtime && configured !== runtime) return { kind: 'invalid' };
	const remoteId = configured || runtime;
	return typeof remoteId === 'string' && remoteId ? { kind: 'ssh', remoteId } : { kind: 'local' };
}
