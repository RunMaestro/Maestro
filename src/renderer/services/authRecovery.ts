/**
 * authRecovery - what happens after a provider login finishes.
 *
 * The recovery modal runs the login command; this module decides whether it
 * WORKED and repairs everything the dead login broke. Two rules shape it:
 *
 *   - **Nothing is claimed without a probe.** A finished browser flow is not
 *     evidence: some CLIs keep running after the browser step, some redirect to
 *     a success page and still fail to write a token. So the verdict always
 *     comes from a fresh `providerAuth:reprobe`, and a probe that cannot answer
 *     reports `unknown` rather than guessing at success.
 *   - **A repaired login repairs every agent on it.** The error was recorded
 *     against the CREDENTIAL, so clearing it against one agent would leave the
 *     other fourteen wearing a badge for a login that already works. Clearing is
 *     type-scoped: a rate-limit or network error on one of those agents is still
 *     true and survives.
 *
 * Lives in `services/` rather than in a store because it is glue - it spans
 * `providerAuthStore` (which credential, which agents), `agentStore` (clear the
 * error), and `modalStore` (close the error modal that is now describing a fixed
 * problem). No store imports it, so there is no cycle to reason about.
 */

import { getAgentDisplayName } from '../../shared/agentMetadata';
import { useAgentStore } from '../stores/agentStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { getModalActions, selectModalData, useModalStore } from '../stores/modalStore';
import { getSessionsForIdentity, useProviderAuthStore } from '../stores/providerAuthStore';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[AuthRecovery]';

/**
 * What the post-login probe found.
 *
 * `unknown` is deliberately distinct from `logged-out`: one means the provider
 * says there is no login, the other means Maestro could not get an answer. Both
 * keep the modal open, but only the first has anything to explain.
 */
export type AuthVerifyStatus = 'authenticated' | 'logged-out' | 'unknown';

export interface AuthVerifyOutcome {
	status: AuthVerifyStatus;
	/** Agents whose auth error was cleared. Empty unless the login worked. */
	clearedSessionIds: string[];
}

/**
 * Clear the auth error on every agent presenting one credential.
 *
 * Returns the ids that actually had one, so the caller can say how much the
 * login fixed. Also closes the agent-error modal when it is sitting on one of
 * those agents: the recovery modal is layered on top of it, and leaving it
 * behind would show the user an error frame for a problem that is now repaired.
 */
export function clearAuthErrorsForIdentity(identityKey: string): string[] {
	const { clearAuthErrors } = useAgentStore.getState();
	const cleared: string[] = [];
	for (const session of getSessionsForIdentity(identityKey)) {
		if (clearAuthErrors(session.id)) cleared.push(session.id);
	}

	const errorModalSessionId = selectModalData('agentError')(useModalStore.getState())?.sessionId;
	if (errorModalSessionId && cleared.includes(errorModalSessionId)) {
		getModalActions().setAgentErrorModalSessionId(null);
	}

	return cleared;
}

/**
 * Re-probe one credential after a login and act on what comes back.
 *
 * On success this is the whole payoff: the snapshot is rewritten as
 * `login-flow`, every agent on the credential drops its auth error, and one
 * green flash confirms it. On anything else it reports honestly and changes
 * nothing - the caller keeps its modal (and the terminal scrollback that
 * explains what went wrong) on screen.
 *
 * Never throws: a failed probe is a verdict of `unknown`, not an exception for
 * the modal to handle.
 */
export async function verifyAuthRecovery(identityKey: string): Promise<AuthVerifyOutcome> {
	try {
		// `login-flow` so the stored record says WHY it says what it says: a user
		// finished a login here, not a background sweep that found a live token.
		await useProviderAuthStore.getState().refreshIdentity(identityKey, { source: 'login-flow' });
	} catch (error) {
		// `refreshIdentity` swallows its own failures; this is the belt to its
		// braces, and it lands on `unknown` below either way.
		logger.warn('Re-probe after login failed', LOG_CONTEXT, {
			identityKey,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const snapshot = useProviderAuthStore.getState().snapshots[identityKey];
	const status: AuthVerifyStatus =
		snapshot?.status === 'authenticated'
			? 'authenticated'
			: snapshot?.status === 'logged-out'
				? 'logged-out'
				: 'unknown';

	if (status !== 'authenticated') {
		return { status, clearedSessionIds: [] };
	}

	const clearedSessionIds = clearAuthErrorsForIdentity(identityKey);
	const identity = snapshot?.identity;
	const account = identity ? `${getAgentDisplayName(identity.provider)} (${identity.label})` : null;
	notifyCenterFlash({
		color: 'green',
		message: account ? `Signed in to ${account}` : 'Signed in',
		// The count is the answer to the question the user actually had, which was
		// never "which key expired" but "what of mine is broken".
		...(clearedSessionIds.length > 0
			? {
					detail:
						clearedSessionIds.length === 1
							? '1 agent unblocked'
							: `${clearedSessionIds.length} agents unblocked`,
				}
			: {}),
	});

	logger.info('Provider login verified', LOG_CONTEXT, {
		identityKey,
		clearedSessions: clearedSessionIds.length,
	});

	return { status, clearedSessionIds };
}
