import { getAgentDisplayName } from '../../../../shared/agentMetadata';
import type { BlockedIdentity } from '../../../stores/providerAuthStore';
import type { QuickAction } from '../types';

interface BuildProviderAuthCommandsArgs {
	/** Every credential currently logged out, each with the agents it blocks. */
	blockedIdentities: BlockedIdentity[];
	/** Opens the recovery modal for one credential. */
	openAuthRecovery: (identityKey: string) => void;
	/** Re-probes every credential. Seconds, not milliseconds - it spawns. */
	refreshAllIdentities: () => Promise<void>;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * Keyboard route into the auth recovery flow.
 *
 * One entry per logged-out CREDENTIAL rather than per blocked agent: fifteen
 * agents on one dead Anthropic login would otherwise fill the palette with
 * fifteen rows that all run the same command. The account label is in the
 * command name because a user with several accounts has to pick the right one,
 * and the agent count is the subtext because "what of mine is broken" is the
 * question they actually came with.
 *
 * The re-probe entry is always offered, even with nothing logged out. It is the
 * command a user goes hunting for by name after fixing a login in their own
 * terminal, and hiding it at zero makes that search come back empty - which
 * reads as "the feature does not exist" rather than "there is nothing to fix".
 */
export function buildProviderAuthCommands({
	blockedIdentities,
	openAuthRecovery,
	refreshAllIdentities,
	setQuickActionOpen,
}: BuildProviderAuthCommandsArgs): QuickAction[] {
	const recoveryActions: QuickAction[] = blockedIdentities.map((entry) => {
		const { identity, sessionIds } = entry;
		const blocked =
			sessionIds.length === 1 ? '1 agent blocked' : `${sessionIds.length} agents blocked`;
		return {
			id: `provider-auth-recovery-${identity.key}`,
			label: `Sign In to ${getAgentDisplayName(identity.provider)} (${identity.label})`,
			subtext: `${blocked} until this account is signed in`,
			action: () => {
				openAuthRecovery(identity.key);
				setQuickActionOpen(false);
			},
		};
	});

	return [
		...recoveryActions,
		{
			id: 'provider-auth-recheck-all',
			label: 'Re-Check Provider Logins',
			subtext:
				blockedIdentities.length > 0
					? `Re-probe every account (${blockedIdentities.length} signed out)`
					: 'Re-probe every account for expired logins',
			action: () => {
				// Fire and forget: the probe spawns one CLI per credential and writes
				// through to the store, so the Left Bar updates on its own. Holding the
				// palette open for it would freeze the UI on a slow remote.
				void refreshAllIdentities();
				setQuickActionOpen(false);
			},
		},
	];
}
