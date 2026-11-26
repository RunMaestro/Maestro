import { memo } from 'react';
import type { Session, Theme } from '../../types';
import { useAgentFederationStatus } from '../../hooks/federation/useAgentLift';
import { useSshRemoteNames } from '../../hooks/remote/useSshRemoteNames';
import { FederationBadge } from './FederationBadge';
import { useAutoFederationAgent } from '../../stores/federationAutoStore';

/**
 * The one mark of an agent's mode, drawn by every surface that shows one (the Left Bar row, the
 * Main Window header, the collapsed Left Bar's hover card): `LOCAL`, `REMOTE` for an SSH agent
 * (with the hover card that says how a hosted agent differs and what to do next), or `HOSTED` for
 * an agent its host runs (moved from here, or added from the host's roster), tinted by the host's
 * connection. Nothing else on screen differs between the three modes.
 */
export const AgentModePill = memo(function AgentModePill({
	theme,
	session,
}: {
	theme: Theme;
	session: Pick<Session, 'id' | 'liftedTo' | 'sessionSshRemoteConfig' | 'sshConnectionFailed'>;
}) {
	const status = useAgentFederationStatus(session);
	const auto = useAutoFederationAgent(session.id);
	const remoteNames = useSshRemoteNames();
	if (status.kind === 'moved') {
		return (
			<FederationBadge
				theme={theme}
				mode={{
					kind: 'hosted',
					peerName: status.peer?.name ?? status.peerId,
					...(status.peer ? { connection: status.peer.connection } : {}),
					...(status.peer?.error ? { error: status.peer.error } : {}),
				}}
			/>
		);
	}
	if (status.kind !== 'ssh') return <FederationBadge theme={theme} mode={{ kind: 'local' }} />;
	const remoteId = session.sessionSshRemoteConfig?.remoteId;
	const remoteName = status.peer?.name ?? (remoteId ? remoteNames.get(remoteId) : undefined);
	return (
		<FederationBadge
			theme={theme}
			mode={{
				kind: 'ssh',
				...(remoteName ? { remoteName } : {}),
				...(session.sshConnectionFailed ? { connectionFailed: true } : {}),
				hostReady: status.hostReady,
				canFederate: status.peer !== undefined,
				...(auto && auto.state !== 'moved' && auto.state !== 'manual'
					? { auto: { state: auto.state, reason: auto.reason, fix: auto.fix } }
					: {}),
			}}
		/>
	);
});
