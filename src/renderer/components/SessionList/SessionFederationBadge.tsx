import { memo } from 'react';
import type { Session, Theme } from '../../types';
import { useAgentFederationStatus } from '../../hooks/federation/useAgentLift';
import { FederationBadge } from './FederationBadge';

/**
 * A local Left Bar row's Federation badge: `SSH` for an SSH agent, with the hover card that says
 * how a federated agent differs and what to do next. Nothing for a local agent, and nothing for one
 * that moved already (its `LiftedPointerChip` says where).
 */
export const SessionFederationBadge = memo(function SessionFederationBadge({
	theme,
	session,
}: {
	theme: Theme;
	session: Pick<Session, 'liftedTo' | 'sessionSshRemoteConfig'>;
}) {
	const status = useAgentFederationStatus(session);
	if (status.kind !== 'ssh') return null;
	return (
		<FederationBadge
			theme={theme}
			mode={{
				kind: 'ssh',
				...(status.peer ? { remoteName: status.peer.name } : {}),
				hostReady: status.hostReady,
				canFederate: status.peer !== undefined,
			}}
		/>
	);
});
