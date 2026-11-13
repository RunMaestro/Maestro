import { memo } from 'react';
import type { Session, Theme } from '../../types';
import { useAgentFederationStatus } from '../../hooks/federation/useAgentLift';
import { FederationBadge } from './FederationBadge';
import { useAutoFederationAgent } from '../../stores/federationAutoStore';
import { useSshOutageStore } from '../../stores/sshOutageStore';
import { getSessionSshRemoteId } from '../../utils/sessionHelpers';

/**
 * A local Left Bar row's Federation badge: `SSH` for an SSH agent, with the hover card that says
 * how a hosted agent differs and what to do next. Nothing for a local agent, and nothing for one
 * that moved already (its `LiftedPointerChip` says where).
 *
 * Reads the SSH outage store passively: a down remote turns the chip red and struck through, and
 * nothing else. It never surfaces the outage dialog (`surface()` belongs to the agent-error
 * listener), so many agents on down remotes add no noise beyond their own rows.
 */
export const SessionFederationBadge = memo(function SessionFederationBadge({
	theme,
	session,
}: {
	theme: Theme;
	session: Pick<Session, 'id' | 'liftedTo' | 'sessionSshRemoteConfig' | 'sshRemoteId'>;
}) {
	const status = useAgentFederationStatus(session);
	const auto = useAutoFederationAgent(session.id);
	// One stored entry (or undefined), never a derived object: a fresh value per call would loop
	// under useSyncExternalStore.
	const remoteId = getSessionSshRemoteId(session);
	const outage = useSshOutageStore((s) => (remoteId ? s.outages[remoteId] : undefined));
	if (status.kind !== 'ssh') return null;
	return (
		<FederationBadge
			theme={theme}
			mode={{
				kind: 'ssh',
				...(status.peer ? { remoteName: status.peer.name } : {}),
				hostReady: status.hostReady,
				canFederate: status.peer !== undefined,
				...(auto && auto.state !== 'moved' && auto.state !== 'manual'
					? { auto: { state: auto.state, reason: auto.reason, fix: auto.fix } }
					: {}),
				...(outage
					? {
							unreachable: {
								remoteName: outage.event.remoteName,
								since: outage.event.since,
								message: outage.event.message,
							},
						}
					: {}),
			}}
		/>
	);
});
