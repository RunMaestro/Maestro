/**
 * useWizardAuthRecovery - turn a wizard auth failure into an in-app repair.
 *
 * The wizard hits auth failures at the worst possible moment: the user is being
 * onboarded, has no agent yet, and the old copy told them to go find a terminal
 * and remember a login command. So this hook does what the agent-error path does
 * (see `useAgentErrorRecovery`), minus the Session that path relies on:
 *
 *   1. Record the failure against the CREDENTIAL, not the agent. That is what
 *      makes the recovery modal able to describe the account, and it surfaces
 *      the same problem on any existing agent sharing the login.
 *   2. Offer a login button only for an `oauth` credential. A rejected API key
 *      or a gateway token is not repaired by signing in, so those get a sentence
 *      naming the env var in play instead of a button that cannot work.
 */

import { useCallback, useEffect, useState } from 'react';

import { getAgentDisplayName } from '../../../../../../shared/agentMetadata';
import type { CredentialIdentity } from '../../../../../../shared/providerAuth';
import { describeCredentialFix } from '../../../../../hooks/agent/useAgentErrorRecovery';
import { getModalActions } from '../../../../../stores/modalStore';
import { markAgentTypeAuthFailure } from '../../../../../stores/providerAuthStore';
import type { ToolType } from '../../../../../types';
import type { WizardError } from '../../../services/wizardErrorDetection';

/** SSH shape the wizard carries on its state, narrowed to what identity needs. */
export interface WizardSshConfig {
	enabled: boolean;
	remoteId: string | null;
}

export interface WizardAuthRecovery {
	/** Copy for the error panel, replacing the generic per-type hint. */
	hint: string;
	/** Present only when an in-app login can repair the credential. */
	action: { label: string; onClick: () => void } | null;
}

/**
 * @param error the detected wizard error, or null
 * @param agentType the agent the wizard is driving
 * @param sshRemoteConfig the wizard's SSH selection, when it has one
 * @returns null for anything that is not an auth failure
 */
export function useWizardAuthRecovery(
	error: WizardError | null,
	agentType: ToolType | null,
	sshRemoteConfig?: WizardSshConfig | null
): WizardAuthRecovery | null {
	const isAuthError = error?.type === 'auth_expired';
	const message = error?.message ?? '';
	const sshRemoteId = sshRemoteConfig?.enabled ? (sshRemoteConfig.remoteId ?? null) : null;

	const [identity, setIdentity] = useState<CredentialIdentity | null>(null);

	useEffect(() => {
		if (!isAuthError || !agentType) {
			setIdentity(null);
			return;
		}
		let cancelled = false;
		void markAgentTypeAuthFailure(agentType, sshRemoteId, message).then((resolved) => {
			if (!cancelled) setIdentity(resolved);
		});
		return () => {
			cancelled = true;
		};
	}, [isAuthError, agentType, sshRemoteId, message]);

	const openRecovery = useCallback(() => {
		if (identity) getModalActions().openAuthRecovery(identity.key);
	}, [identity]);

	if (!isAuthError || !error) return null;

	// Before the identity resolves (or when it cannot be resolved at all) there is
	// nothing honest to offer, so the panel keeps its generic hint. It states the
	// failure and promises nothing.
	if (!identity) return { hint: error.recoveryHint, action: null };

	const providerName = getAgentDisplayName(identity.provider);
	if (identity.kind !== 'oauth') {
		return { hint: `${describeCredentialFix(identity, providerName)}.`, action: null };
	}

	return {
		hint: 'Sign in here and Maestro runs the login for you, then send your message again.',
		action: {
			label: `Sign in to ${providerName} (${identity.label})`,
			onClick: openRecovery,
		},
	};
}
